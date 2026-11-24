// Package crypto implements master key management, envelope-style field
// encryption, password hashing and key generation helpers.
package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Master key source names, in loading priority order.
const (
	SourceCredential = "systemd-credential"
	SourceEnv        = "environment"
	SourceFile       = "file"
	SourceGenerated  = "generated"
)

const (
	credentialName     = "master_key"
	credentialNextName = "master_key_next"
	envName            = "NOMAD_DECK_MASTER_KEY"
	envNextName        = "NOMAD_DECK_MASTER_KEY_NEXT"
	fileName           = "master.key"
	fileNextName       = "master.key.next"
	keySize            = 32
)

// Key is one 32-byte master key identified by a stable Key ID.
type Key struct {
	ID     string
	Source string
	secret [keySize]byte
}

// Keyring holds the primary master key and an optional next key used during
// rotation. New ciphertext is always written with the active key.
type Keyring struct {
	primary *Key
	next    *Key
	byID    map[string]*Key
}

// LoadOptions controls where master keys are read from.
type LoadOptions struct {
	CredentialsDir string // usually $CREDENTIALS_DIRECTORY
	Getenv         func(string) string
	DataDir        string
	AllowGenerate  bool // create data_dir/master.key when no key is found
}

// LoadKeyring loads the primary key from the first available source
// (systemd credential, environment, file) and an optional next key.
func LoadKeyring(opts LoadOptions) (*Keyring, error) {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	primary, err := loadOne(opts, getenv, credentialName, envName, fileName)
	if err != nil {
		return nil, err
	}
	if primary == nil {
		if !opts.AllowGenerate {
			return nil, errors.New("no master key found (systemd credential, NOMAD_DECK_MASTER_KEY or master.key)")
		}
		primary, err = generateKeyFile(filepath.Join(opts.DataDir, fileName))
		if err != nil {
			return nil, err
		}
	}
	next, err := loadOne(opts, getenv, credentialNextName, envNextName, fileNextName)
	if err != nil {
		return nil, err
	}
	kr := &Keyring{primary: primary, byID: map[string]*Key{primary.ID: primary}}
	if next != nil && next.ID != primary.ID {
		kr.next = next
		kr.byID[next.ID] = next
	}
	return kr, nil
}

// NewKeyringForTest builds a keyring from raw keys (first is primary).
func NewKeyringForTest(keys ...[]byte) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("at least one key required")
	}
	kr := &Keyring{byID: map[string]*Key{}}
	for i, raw := range keys {
		k, err := newKey(raw, "test")
		if err != nil {
			return nil, err
		}
		if i == 0 {
			kr.primary = k
		} else {
			kr.next = k
		}
		kr.byID[k.ID] = k
	}
	return kr, nil
}

// Active returns the key used for new ciphertext.
func (kr *Keyring) Active() *Key {
	if kr.next != nil {
		return kr.next
	}
	return kr.primary
}

// Primary returns the primary key.
func (kr *Keyring) Primary() *Key { return kr.primary }

// Next returns the rotation target key, if loaded.
func (kr *Keyring) Next() *Key { return kr.next }

// Has reports whether a key with the given ID is loaded.
func (kr *Keyring) Has(id string) bool { _, ok := kr.byID[id]; return ok }

// IDs lists loaded key IDs (primary first).
func (kr *Keyring) IDs() []string {
	ids := []string{kr.primary.ID}
	if kr.next != nil {
		ids = append(ids, kr.next.ID)
	}
	return ids
}

// Subkey derives a purpose-bound 32-byte key from the primary master key.
func (kr *Keyring) Subkey(purpose string) []byte {
	h := sha256.New()
	h.Write([]byte("nomad-deck/subkey/v1/" + purpose + "/"))
	h.Write(kr.primary.secret[:])
	return h.Sum(nil)
}

func loadOne(opts LoadOptions, getenv func(string) string, cred, env, file string) (*Key, error) {
	if opts.CredentialsDir != "" {
		p := filepath.Join(opts.CredentialsDir, cred)
		if b, err := os.ReadFile(p); err == nil {
			return parseKey(string(b), SourceCredential)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("read credential %s: %w", cred, err)
		}
	}
	if v := getenv(env); strings.TrimSpace(v) != "" {
		return parseKey(v, SourceEnv)
	}
	if opts.DataDir != "" {
		p := filepath.Join(opts.DataDir, file)
		if b, err := os.ReadFile(p); err == nil {
			return parseKey(string(b), SourceFile)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("read %s: %w", p, err)
		}
	}
	return nil, nil
}

// parseKey accepts 64 hex characters or standard/URL base64 of 32 bytes.
func parseKey(s, source string) (*Key, error) {
	s = strings.TrimSpace(s)
	var raw []byte
	if len(s) == 2*keySize {
		if b, err := hex.DecodeString(s); err == nil {
			raw = b
		}
	}
	if raw == nil {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if b, err := enc.DecodeString(s); err == nil && len(b) == keySize {
				raw = b
				break
			}
		}
	}
	if raw == nil {
		return nil, fmt.Errorf("master key from %s must be 32 bytes encoded as hex or base64", source)
	}
	return newKey(raw, source)
}

func newKey(raw []byte, source string) (*Key, error) {
	if len(raw) != keySize {
		return nil, fmt.Errorf("master key must be %d bytes", keySize)
	}
	k := &Key{Source: source}
	copy(k.secret[:], raw)
	sum := sha256.Sum256(append([]byte("nomad-deck/master-key-id/v1/"), raw...))
	k.ID = hex.EncodeToString(sum[:8])
	return k, nil
}

func generateKeyFile(path string) (*Key, error) {
	raw := make([]byte, keySize)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create %s: %w", path, err)
	}
	if _, err := f.WriteString(hex.EncodeToString(raw) + "\n"); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return newKey(raw, SourceGenerated)
}
