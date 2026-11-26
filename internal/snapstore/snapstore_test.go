package snapstore

import (
	"bytes"
	"crypto/rand"
	"errors"
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
		w, err := Create(keys, path, "snap1")
		if err != nil {
			t.Fatal(err)
		}
		w.Write(data)
		sha, err := w.Close()
		if err != nil {
			t.Fatal(err)
		}
		r, err := Open(keys, path, "snap1", sha)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("size %d: round trip failed (%v)", size, err)
		}
		if _, err := Open(keys, path, "other", sha); err == nil {
			t.Fatal("wrong record id must fail")
		}
		if size > 0 {
			raw, _ := os.ReadFile(path)
			raw[len(raw)-20] ^= 1
			os.WriteFile(path, raw, 0o600)
			if _, err := Open(keys, path, "snap1", sha); err == nil {
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
		if err := WriteArchive(&buf, bytes.NewReader(data), ArchiveMeta{ClusterName: "c", ClusterType: "vault", SealGeneration: &gen}, "a long passphrase"); err != nil {
			t.Fatal(err)
		}
		meta, r, err := ReadArchive(io.NopCloser(bytes.NewReader(buf.Bytes())), "a long passphrase")
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		if err != nil || !bytes.Equal(got, data) || *meta.SealGeneration != 2 {
			t.Fatalf("size %d: %v", size, err)
		}
		_, r, err = ReadArchive(io.NopCloser(bytes.NewReader(buf.Bytes())), "the wrong passphrase")
		if err == nil {
			if _, err = io.ReadAll(r); err == nil {
				t.Fatal("wrong passphrase must fail")
			}
		}
		if _, _, err := ReadArchive(io.NopCloser(bytes.NewReader(buf.Bytes())), ""); !errors.Is(err, ErrPassphraseRequired) {
			t.Fatalf("empty passphrase on encrypted archive: %v", err)
		}

		// Empty passphrase writes unencrypted v2 archive.
		var plainBuf bytes.Buffer
		if err := WriteArchive(&plainBuf, bytes.NewReader(data), ArchiveMeta{ClusterName: "c", ClusterType: "vault", SealGeneration: &gen}, ""); err != nil {
			t.Fatalf("unencrypted WriteArchive size %d: %v", size, err)
		}
		pMeta, pr, err := ReadArchive(io.NopCloser(bytes.NewReader(plainBuf.Bytes())), "")
		if err != nil {
			t.Fatalf("unencrypted ReadArchive size %d: %v", size, err)
		}
		pGot, err := io.ReadAll(pr)
		pr.Close()
		if err != nil || !bytes.Equal(pGot, data) || *pMeta.SealGeneration != 2 {
			t.Fatalf("unencrypted size %d: %v", size, err)
		}
	}
	// Short passphrase (<6) is rejected; 6-char passphrase succeeds.
	var tmp bytes.Buffer
	if err := WriteArchive(&tmp, bytes.NewReader([]byte("x")), ArchiveMeta{ClusterName: "c", ClusterType: "nomad"}, "12345"); err == nil {
		t.Fatal("5-char passphrase must fail")
	}
	if err := WriteArchive(&tmp, bytes.NewReader([]byte("x")), ArchiveMeta{ClusterName: "c", ClusterType: "nomad"}, "123456"); err != nil {
		t.Fatalf("6-char passphrase must succeed: %v", err)
	}
}

func TestRewrapAndHeaderKeyID(t *testing.T) {
	k1 := bytes.Repeat([]byte{1}, 32)
	k2 := bytes.Repeat([]byte{2}, 32)
	kr1, _ := crypto.NewKeyringForTest(k1)
	kr12, _ := crypto.NewKeyringForTest(k1, k2)
	kr2, _ := crypto.NewKeyringForTest(k2)

	dir := t.TempDir()
	path := filepath.Join(dir, "s1.snap")
	payload := bytes.Repeat([]byte("raft-state-"), 50000)

	w, err := Create(kr1, path, "snap-rw")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	sha, err := w.Close()
	if err != nil {
		t.Fatal(err)
	}

	gotID, err := HeaderKeyID(path)
	if err != nil || gotID != kr1.Primary().ID {
		t.Fatalf("initial HeaderKeyID=%q err=%v, want %q", gotID, err, kr1.Primary().ID)
	}

	changed, err := Rewrap(kr12, path, "snap-rw")
	if err != nil || !changed {
		t.Fatalf("Rewrap changed=%v err=%v", changed, err)
	}
	gotID, err = HeaderKeyID(path)
	if err != nil || gotID != kr2.Primary().ID {
		t.Fatalf("after Rewrap HeaderKeyID=%q err=%v, want %q", gotID, err, kr2.Primary().ID)
	}

	// Second Rewrap is a no-op.
	changed, err = Rewrap(kr12, path, "snap-rw")
	if err != nil || changed {
		t.Fatalf("second Rewrap changed=%v err=%v", changed, err)
	}

	// New-key-only keyring opens with the original body SHA-256 unchanged.
	r, err := Open(kr2, path, "snap-rw", sha)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r)
	r.Close()
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("open after rewrap failed: %v", err)
	}
}
