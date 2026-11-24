// Package vaultbackup implements the offline emergency backup file of Vault
// unseal keys. The format is stable and self-describing so the keys can be
// recovered on any machine with only the file and its passphrase:
//
//	offset  size  field
//	0       5     magic "NDVKB"
//	5       1     format version (1)
//	6       4     Argon2id time cost (big endian)
//	10      4     Argon2id memory in KiB (big endian)
//	14      1     Argon2id parallelism
//	15      1     salt length S
//	16      S     salt
//	16+S    12    AES-256-GCM nonce
//	28+S    ...   AES-256-GCM ciphertext of the JSON payload
//
// The key is Argon2id(passphrase, salt) with a 32-byte output; the header
// (bytes 0 to 28+S) is the GCM additional data.
package vaultbackup

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"golang.org/x/crypto/argon2"
)

// Magic identifies backup files.
const Magic = "NDVKB"

// FormatName is stored in the payload.
const FormatName = "nomad-deck-vault-unseal-backup"

// MinPassphrase is the minimum passphrase length enforced on export.
const MinPassphrase = 12

// Default KDF parameters.
var (
	DefaultTime    uint32 = 3
	DefaultMemory  uint32 = 64 * 1024
	DefaultThreads uint8  = 4
)

// Generation is one key generation in the payload.
type Generation struct {
	Generation   int      `json:"generation"`
	State        string   `json:"state"`
	KeyShares    int      `json:"key_shares"`
	KeyThreshold int      `json:"key_threshold"`
	UnsealKeys   []string `json:"unseal_keys"`
}

// Payload is the decrypted content.
type Payload struct {
	Format           string       `json:"format"`
	ClusterID        string       `json:"cluster_id"`
	ClusterName      string       `json:"cluster_name"`
	CreatedAt        time.Time    `json:"created_at"`
	ActiveGeneration int          `json:"active_generation"`
	Generations      []Generation `json:"generations"`
}

// ErrBadPassphrase is returned when authentication fails.
var ErrBadPassphrase = errors.New("wrong passphrase or corrupted backup file")

func deriveKey(pass string, salt []byte, t, m uint32, p uint8) []byte {
	return argon2.IDKey([]byte(pass), salt, t, m, p, 32)
}

// Encrypt produces a backup file.
func Encrypt(p *Payload, passphrase string) ([]byte, error) {
	if len(passphrase) < MinPassphrase {
		return nil, fmt.Errorf("passphrase must be at least %d characters", MinPassphrase)
	}
	p.Format = FormatName
	plain, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	var hdr bytes.Buffer
	hdr.WriteString(Magic)
	hdr.WriteByte(1)
	_ = binary.Write(&hdr, binary.BigEndian, DefaultTime)
	_ = binary.Write(&hdr, binary.BigEndian, DefaultMemory)
	hdr.WriteByte(DefaultThreads)
	hdr.WriteByte(byte(len(salt)))
	hdr.Write(salt)
	hdr.Write(nonce)
	gcm, err := newGCM(deriveKey(passphrase, salt, DefaultTime, DefaultMemory, DefaultThreads))
	if err != nil {
		return nil, err
	}
	out := append([]byte(nil), hdr.Bytes()...)
	return gcm.Seal(out, nonce, plain, hdr.Bytes()), nil
}

// Decrypt opens a backup file.
func Decrypt(data []byte, passphrase string) (*Payload, error) {
	if len(data) < 16 || string(data[:5]) != Magic {
		return nil, errors.New("not a NomadDeck Vault unseal key backup")
	}
	if data[5] != 1 {
		return nil, fmt.Errorf("unsupported backup format version %d", data[5])
	}
	t := binary.BigEndian.Uint32(data[6:10])
	m := binary.BigEndian.Uint32(data[10:14])
	threads := data[14]
	sl := int(data[15])
	if t == 0 || t > 64 || m < 8*1024 || m > 4*1024*1024 || threads == 0 || sl < 8 || len(data) < 16+sl+12+16 {
		return nil, errors.New("backup header is malformed")
	}
	salt := data[16 : 16+sl]
	nonce := data[16+sl : 28+sl]
	hdr := data[:28+sl]
	gcm, err := newGCM(deriveKey(passphrase, salt, t, m, threads))
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, data[28+sl:], hdr)
	if err != nil {
		return nil, ErrBadPassphrase
	}
	var p Payload
	if err := json.Unmarshal(plain, &p); err != nil {
		return nil, fmt.Errorf("backup payload: %w", err)
	}
	if p.Format != FormatName {
		return nil, errors.New("unexpected backup payload format")
	}
	return &p, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}
