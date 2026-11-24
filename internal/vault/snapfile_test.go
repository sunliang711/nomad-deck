package vault

import (
	"bytes"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"testing"

	"nomad-deck/internal/crypto"
	"nomad-deck/internal/vaultbackup"
)

func TestSnapshotFileRoundTrip(t *testing.T) {
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{3}, 32))
	dir := t.TempDir()
	for _, size := range []int{0, 10, snapChunkSize, snapChunkSize*2 + 77} {
		data := make([]byte, size)
		rand.Read(data)
		path := filepath.Join(dir, "s"+string(rune('a'+size%26))+".snap")
		os.Remove(path)
		w, err := createSnapshotFile(keys, path, "snap1")
		if err != nil {
			t.Fatal(err)
		}
		w.Write(data)
		sha, err := w.Close()
		if err != nil {
			t.Fatal(err)
		}
		r, err := openSnapshotFile(keys, path, "snap1", sha)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("size %d: round trip failed (%v)", size, err)
		}
		if _, err := openSnapshotFile(keys, path, "other", sha); err == nil {
			t.Fatal("wrong record id must fail")
		}
		if size > 0 {
			raw, _ := os.ReadFile(path)
			raw[len(raw)-20] ^= 1
			os.WriteFile(path, raw, 0o600)
			if _, err := openSnapshotFile(keys, path, "snap1", sha); err == nil {
				t.Fatal("tampered body must fail the digest check")
			}
		}
	}
}

func TestPortableArchive(t *testing.T) {
	saved := vaultbackup.DefaultMemory
	vaultbackup.DefaultMemory = 8 * 1024
	defer func() { vaultbackup.DefaultMemory = saved }()
	for _, size := range []int{0, 5, snapChunkSize, snapChunkSize + 3} {
		data := make([]byte, size)
		rand.Read(data)
		var buf bytes.Buffer
		gen := 2
		if err := writeArchive(&buf, bytes.NewReader(data), ArchiveMeta{ClusterName: "c", ClusterType: "vault", SealGeneration: &gen}, "a long passphrase"); err != nil {
			t.Fatal(err)
		}
		meta, r, err := readArchive(io.NopCloser(bytes.NewReader(buf.Bytes())), "a long passphrase")
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, data) || *meta.SealGeneration != 2 {
			t.Fatalf("size %d: %v", size, err)
		}
		_, r, err = readArchive(io.NopCloser(bytes.NewReader(buf.Bytes())), "the wrong passphrase")
		if err == nil {
			if _, err = io.ReadAll(r); err == nil {
				t.Fatal("wrong passphrase must fail")
			}
		}
	}
}
