package crypto

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func key(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func TestEncryptDecryptAndAAD(t *testing.T) {
	kr, _ := NewKeyringForTest(key(1))
	ct, err := kr.EncryptString("secret", "t.c:1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ct, "nd1:"+kr.Primary().ID+":") {
		t.Fatalf("unexpected ciphertext %s", ct)
	}
	pt, err := kr.DecryptString(ct, "t.c:1")
	if err != nil || pt != "secret" {
		t.Fatalf("decrypt: %q %v", pt, err)
	}
	if _, err := kr.Decrypt(ct, "t.c:2"); err == nil {
		t.Fatal("decrypt with wrong AAD must fail")
	}
}

func TestRotationKeyring(t *testing.T) {
	old, _ := NewKeyringForTest(key(1))
	ct, _ := old.EncryptString("v", "a")
	both, _ := NewKeyringForTest(key(1), key(2))
	if both.Active().ID == old.Primary().ID {
		t.Fatal("next key must be active during rotation")
	}
	if pt, err := both.DecryptString(ct, "a"); err != nil || pt != "v" {
		t.Fatalf("old ciphertext must stay readable: %v", err)
	}
	ct2, _ := both.EncryptString("v2", "a")
	id, _ := KeyIDOf(ct2)
	if id != both.Next().ID {
		t.Fatal("new ciphertext must use next key")
	}
	newOnly, _ := NewKeyringForTest(key(2))
	if _, err := newOnly.Decrypt(ct, "a"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("expected ErrUnknownKey, got %v", err)
	}
}

func TestLoadKeyringSources(t *testing.T) {
	dir := t.TempDir()
	cred := filepath.Join(dir, "cred")
	os.MkdirAll(cred, 0o700)
	envKey := base64.StdEncoding.EncodeToString(key(3))
	os.WriteFile(filepath.Join(cred, "master_key"), []byte(hex.EncodeToString(key(4))+"\n"), 0o600)

	kr, err := LoadKeyring(LoadOptions{CredentialsDir: cred, Getenv: func(k string) string {
		if k == "NOMAD_DECK_MASTER_KEY" {
			return envKey
		}
		return ""
	}, DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if kr.Primary().Source != SourceCredential {
		t.Fatalf("credential must win, got %s", kr.Primary().Source)
	}

	kr, err = LoadKeyring(LoadOptions{Getenv: func(k string) string {
		if k == "NOMAD_DECK_MASTER_KEY" {
			return envKey
		}
		return ""
	}, DataDir: dir})
	if err != nil || kr.Primary().Source != SourceEnv {
		t.Fatalf("env source expected: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "master.key")); !os.IsNotExist(err) {
		t.Fatal("master.key must not be generated when a key is provided")
	}
}

func TestGenerateMasterKeyFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadKeyring(LoadOptions{DataDir: dir}); err == nil {
		t.Fatal("expected error without AllowGenerate")
	}
	kr, err := LoadKeyring(LoadOptions{DataDir: dir, AllowGenerate: true})
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "master.key"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("master.key perms: %v %v", st, err)
	}
	again, err := LoadKeyring(LoadOptions{DataDir: dir, AllowGenerate: true})
	if err != nil || again.Primary().ID != kr.Primary().ID || again.Primary().Source != SourceFile {
		t.Fatal("generated key must be reused on next start")
	}
}

func TestParseKeyRejectsBadInput(t *testing.T) {
	for _, s := range []string{"", "short", hex.EncodeToString(key(1)[:16])} {
		if _, err := parseKey(s, "test"); err == nil {
			t.Errorf("expected error for %q", s)
		}
	}
}

func TestPasswordHash(t *testing.T) {
	PasswordParams = Argon2Params{Memory: 1024, Time: 1, Threads: 1, KeyLen: 32, SaltLen: 16}
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := VerifyPassword("correct horse", h); !ok {
		t.Fatal("password must verify")
	}
	if ok, _ := VerifyPassword("wrong", h); ok {
		t.Fatal("wrong password must not verify")
	}
}

func TestGenerateEd25519(t *testing.T) {
	kp, err := GenerateEd25519("nomad-deck")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(kp.PublicKey, "ssh-ed25519 ") || !strings.HasPrefix(kp.Fingerprint, "SHA256:") ||
		!bytes.Contains(kp.PrivatePEM, []byte("OPENSSH PRIVATE KEY")) {
		t.Fatalf("unexpected key pair: %+v", kp)
	}
}
