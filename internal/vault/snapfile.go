package vault

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/crypto/argon2"

	"nomad-deck/internal/crypto"
	"nomad-deck/internal/vaultbackup"
)

// Encrypted snapshot files: a header holding the snapshot's random data key
// wrapped by the master key, followed by the body encrypted in authenticated
// chunks. The recorded SHA-256 covers only the body, so rewrapping the data
// key during a master key rotation rewrites the header alone.
//
//	"NDSN" | version(1) | header length (uint32 BE) | header JSON | chunks
//	chunk: plaintext length (uint32 BE) | ciphertext (length + 16)
//
// Chunk i is sealed with nonce = header nonce prefix (8 bytes) || i (uint32
// BE) and additional data "<snapshot id>:<i>:<final>"; the final chunk is
// marked so truncation is detected.
const (
	snapMagic     = "NDSN"
	snapChunkSize = 1 << 20
)

type snapHeader struct {
	SnapshotID  string `json:"snapshot_id"`
	WrappedKey  string `json:"wrapped_key"`
	NoncePrefix string `json:"nonce_prefix"`
}

// SnapshotAAD binds a wrapped snapshot data key to its snapshot.
func SnapshotAAD(id string) string { return "cluster_snapshots.data_key:" + id }

type snapWriter struct {
	f      *os.File
	w      *bufio.Writer
	body   hash.Hash
	gcm    cipher.AEAD
	prefix []byte
	id     string // chunk additional-data identifier
	buf    []byte
	index  uint32
	size   int64
}

func createSnapshotFile(keys *crypto.Keyring, path, id string) (*snapWriter, error) {
	dataKey := make([]byte, 32)
	prefix := make([]byte, 8)
	if _, err := rand.Read(dataKey); err != nil {
		return nil, err
	}
	if _, err := rand.Read(prefix); err != nil {
		return nil, err
	}
	wrapped, err := keys.Encrypt(dataKey, SnapshotAAD(id))
	if err != nil {
		return nil, err
	}
	block, _ := aes.NewCipher(dataKey)
	gcm, _ := cipher.NewGCM(block)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	hdr, _ := json.Marshal(snapHeader{SnapshotID: id, WrappedKey: wrapped, NoncePrefix: hex.EncodeToString(prefix)})
	w := bufio.NewWriterSize(f, 256<<10)
	w.WriteString(snapMagic)
	w.WriteByte(1)
	_ = binary.Write(w, binary.BigEndian, uint32(len(hdr)))
	w.Write(hdr)
	return &snapWriter{f: f, w: w, body: sha256.New(), gcm: gcm, prefix: prefix, id: id, buf: make([]byte, 0, snapChunkSize)}, nil
}

func (s *snapWriter) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		room := snapChunkSize - len(s.buf)
		take := len(p)
		if take > room {
			take = room
		}
		s.buf = append(s.buf, p[:take]...)
		p = p[take:]
		n += take
		if len(s.buf) == snapChunkSize {
			if err := s.flush(false); err != nil {
				return n, err
			}
		}
	}
	s.size += int64(n)
	return n, nil
}

func chunkNonce(prefix []byte, i uint32) []byte {
	n := make([]byte, 12)
	copy(n, prefix)
	binary.BigEndian.PutUint32(n[8:], i)
	return n
}

func chunkAAD(id string, i uint32, final bool) []byte {
	return []byte(id + ":" + strconv.FormatUint(uint64(i), 10) + ":" + strconv.FormatBool(final))
}

func (s *snapWriter) flush(final bool) error {
	ct := s.gcm.Seal(nil, chunkNonce(s.prefix, s.index), s.buf, chunkAAD(s.id, s.index, final))
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(s.buf)))
	out := io.MultiWriter(s.w, s.body)
	if _, err := out.Write(l[:]); err != nil {
		return err
	}
	if _, err := out.Write(ct); err != nil {
		return err
	}
	s.index++
	s.buf = s.buf[:0]
	return nil
}

// Close writes the final chunk, syncs the file and returns the body digest.
func (s *snapWriter) Close() (string, error) {
	if err := s.flush(true); err != nil {
		s.f.Close()
		return "", err
	}
	if err := s.w.Flush(); err != nil {
		s.f.Close()
		return "", err
	}
	if err := s.f.Sync(); err != nil {
		s.f.Close()
		return "", err
	}
	return hex.EncodeToString(s.body.Sum(nil)), s.f.Close()
}

// Abort removes a partially written file.
func (s *snapWriter) Abort() {
	s.f.Close()
	_ = os.Remove(s.f.Name())
}

// openSnapshotFile verifies the body digest and returns a reader of the
// decrypted snapshot.
func openSnapshotFile(keys *crypto.Keyring, path, wantID, wantSHA string) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	r := bufio.NewReaderSize(f, 256<<10)
	magic := make([]byte, 5)
	if _, err := io.ReadFull(r, magic); err != nil || string(magic[:4]) != snapMagic || magic[4] != 1 {
		f.Close()
		return nil, errors.New("not a NomadDeck snapshot file")
	}
	var hl uint32
	if err := binary.Read(r, binary.BigEndian, &hl); err != nil || hl > 1<<20 {
		f.Close()
		return nil, errors.New("snapshot header is malformed")
	}
	hb := make([]byte, hl)
	if _, err := io.ReadFull(r, hb); err != nil {
		f.Close()
		return nil, err
	}
	var h snapHeader
	if err := json.Unmarshal(hb, &h); err != nil || h.SnapshotID != wantID {
		f.Close()
		return nil, errors.New("snapshot header does not match the record")
	}
	// Verify the body digest first.
	bodyStart := int64(5 + 4 + hl)
	hs := sha256.New()
	if _, err := f.Seek(bodyStart, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	if _, err := io.Copy(hs, f); err != nil {
		f.Close()
		return nil, err
	}
	if got := hex.EncodeToString(hs.Sum(nil)); got != wantSHA {
		f.Close()
		return nil, fmt.Errorf("snapshot file digest mismatch")
	}
	if _, err := f.Seek(bodyStart, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	dataKey, err := keys.Decrypt(h.WrappedKey, SnapshotAAD(h.SnapshotID))
	if err != nil {
		f.Close()
		return nil, err
	}
	prefix, err := hex.DecodeString(h.NoncePrefix)
	if err != nil || len(prefix) != 8 {
		f.Close()
		return nil, errors.New("snapshot header is malformed")
	}
	block, _ := aes.NewCipher(dataKey)
	gcm, _ := cipher.NewGCM(block)
	return chunkReader(f, gcm, prefix, h.SnapshotID), nil
}

// chunkReader decrypts and authenticates the chunk stream from src.
func chunkReader(src io.ReadCloser, gcm cipher.AEAD, prefix []byte, id string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		defer src.Close()
		br := bufio.NewReaderSize(src, 256<<10)
		var i uint32
		for {
			var l uint32
			if err := binary.Read(br, binary.BigEndian, &l); err != nil {
				pw.CloseWithError(errors.New("snapshot is truncated"))
				return
			}
			if l > snapChunkSize {
				pw.CloseWithError(errors.New("snapshot chunk is malformed"))
				return
			}
			ct := make([]byte, int(l)+gcm.Overhead())
			if _, err := io.ReadFull(br, ct); err != nil {
				pw.CloseWithError(errors.New("snapshot is truncated"))
				return
			}
			final := false
			plain, err := gcm.Open(nil, chunkNonce(prefix, i), ct, chunkAAD(id, i, false))
			if err != nil {
				plain, err = gcm.Open(nil, chunkNonce(prefix, i), ct, chunkAAD(id, i, true))
				final = true
			}
			if err != nil {
				pw.CloseWithError(errors.New("snapshot chunk failed authentication"))
				return
			}
			if _, err := pw.Write(plain); err != nil {
				return
			}
			if final {
				pw.Close()
				return
			}
			i++
		}
	}()
	return pr
}

// ---- Portable archives ----
//
// A portable archive carries a snapshot between control planes, encrypted
// with a passphrase instead of the master key:
//
//	"NDSA" | version(1) | Argon2id time (uint32) | memory KiB (uint32) |
//	parallelism (1) | salt length (1) | salt | header length (uint32) |
//	header JSON | chunks
//
// The chunk additional data uses the SHA-256 of the header, so the header
// (metadata and nonce prefix) is authenticated as well.

const archiveMagic = "NDSA"

// ArchiveMeta describes the snapshot inside a portable archive.
type ArchiveMeta struct {
	ArchiveID      string    `json:"archive_id"`
	NoncePrefix    string    `json:"nonce_prefix"`
	ClusterName    string    `json:"cluster_name"`
	ClusterType    string    `json:"cluster_type"`
	ProductVersion string    `json:"product_version"`
	SealGeneration *int      `json:"seal_generation,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

func passKey(pass string, salt []byte, t, m uint32, p uint8) cipher.AEAD {
	block, _ := aes.NewCipher(argon2.IDKey([]byte(pass), salt, t, m, p, 32))
	gcm, _ := cipher.NewGCM(block)
	return gcm
}

// sealChunks encrypts src into dst using the chunk format.
func sealChunks(dst io.Writer, src io.Reader, gcm cipher.AEAD, prefix []byte, id string) error {
	buf, next := make([]byte, snapChunkSize), make([]byte, snapChunkSize)
	n, err := io.ReadFull(src, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return err
	}
	for i := uint32(0); ; i++ {
		final, m := n < snapChunkSize, 0
		if !final {
			m, err = io.ReadFull(src, next)
			if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
				return err
			}
			final = m == 0
		}
		ct := gcm.Seal(nil, chunkNonce(prefix, i), buf[:n], chunkAAD(id, i, final))
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(n))
		if _, err := dst.Write(l[:]); err != nil {
			return err
		}
		if _, err := dst.Write(ct); err != nil {
			return err
		}
		if final {
			return nil
		}
		buf, next, n = next, buf, m
	}
}

// writeArchive encrypts a snapshot stream into a portable archive.
func writeArchive(dst io.Writer, src io.Reader, meta ArchiveMeta, passphrase string) error {
	if len(passphrase) < vaultbackup.MinPassphrase {
		return fmt.Errorf("passphrase must be at least %d characters", vaultbackup.MinPassphrase)
	}
	salt, prefix, aid := make([]byte, 16), make([]byte, 8), make([]byte, 16)
	for _, b := range [][]byte{salt, prefix, aid} {
		if _, err := rand.Read(b); err != nil {
			return err
		}
	}
	meta.ArchiveID, meta.NoncePrefix = hex.EncodeToString(aid), hex.EncodeToString(prefix)
	hdr, _ := json.Marshal(meta)
	t, m, p := vaultbackup.DefaultTime, vaultbackup.DefaultMemory, vaultbackup.DefaultThreads
	w := bufio.NewWriterSize(dst, 256<<10)
	w.WriteString(archiveMagic)
	w.WriteByte(1)
	_ = binary.Write(w, binary.BigEndian, t)
	_ = binary.Write(w, binary.BigEndian, m)
	w.WriteByte(p)
	w.WriteByte(byte(len(salt)))
	w.Write(salt)
	_ = binary.Write(w, binary.BigEndian, uint32(len(hdr)))
	w.Write(hdr)
	hsum := sha256.Sum256(hdr)
	if err := sealChunks(w, src, passKey(passphrase, salt, t, m, p), prefix, hex.EncodeToString(hsum[:])); err != nil {
		return err
	}
	return w.Flush()
}

// readArchive opens a portable archive; a wrong passphrase surfaces as an
// authentication error on the first read.
func readArchive(src io.ReadCloser, passphrase string) (*ArchiveMeta, io.ReadCloser, error) {
	r := bufio.NewReaderSize(src, 256<<10)
	fixed := make([]byte, 16)
	if _, err := io.ReadFull(r, fixed); err != nil || string(fixed[:4]) != archiveMagic || fixed[4] != 1 {
		src.Close()
		return nil, nil, errors.New("not a NomadDeck snapshot archive")
	}
	t, m, p, sl := binary.BigEndian.Uint32(fixed[5:9]), binary.BigEndian.Uint32(fixed[9:13]), fixed[13], int(fixed[14])
	if t == 0 || t > 64 || m < 8*1024 || m > 4*1024*1024 || p == 0 || sl < 8 {
		src.Close()
		return nil, nil, errors.New("archive header is malformed")
	}
	salt := make([]byte, sl)
	salt[0] = fixed[15]
	if _, err := io.ReadFull(r, salt[1:]); err != nil {
		src.Close()
		return nil, nil, err
	}
	var hl uint32
	if err := binary.Read(r, binary.BigEndian, &hl); err != nil || hl > 1<<20 {
		src.Close()
		return nil, nil, errors.New("archive header is malformed")
	}
	hdr := make([]byte, hl)
	if _, err := io.ReadFull(r, hdr); err != nil {
		src.Close()
		return nil, nil, err
	}
	var meta ArchiveMeta
	if err := json.Unmarshal(hdr, &meta); err != nil {
		src.Close()
		return nil, nil, errors.New("archive header is malformed")
	}
	prefix, err := hex.DecodeString(meta.NoncePrefix)
	if err != nil || len(prefix) != 8 {
		src.Close()
		return nil, nil, errors.New("archive header is malformed")
	}
	hsum := sha256.Sum256(hdr)
	body := struct {
		io.Reader
		io.Closer
	}{r, src}
	return &meta, chunkReader(body, passKey(passphrase, salt, t, m, p), prefix, hex.EncodeToString(hsum[:])), nil
}
