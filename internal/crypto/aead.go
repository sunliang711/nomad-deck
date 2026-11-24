package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// Ciphertext format: "nd1:<keyID>:<base64url(nonce||sealed)>".
// The additional data binds a ciphertext to its storage location so that a
// value cannot be copied to another column or row unnoticed.
const ciphertextPrefix = "nd1"

// ErrUnknownKey is returned when a ciphertext references a key that is not loaded.
var ErrUnknownKey = errors.New("ciphertext references a master key that is not loaded")

// Encrypt seals plaintext with the active master key.
func (kr *Keyring) Encrypt(plaintext []byte, aad string) (string, error) {
	k := kr.Active()
	gcm, err := newGCM(k.secret[:])
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, []byte(aad))
	return ciphertextPrefix + ":" + k.ID + ":" + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// EncryptString is a convenience wrapper around Encrypt.
func (kr *Keyring) EncryptString(plaintext, aad string) (string, error) {
	return kr.Encrypt([]byte(plaintext), aad)
}

// Decrypt opens a ciphertext produced by Encrypt using the key named in it.
func (kr *Keyring) Decrypt(ciphertext, aad string) ([]byte, error) {
	keyID, payload, err := splitCiphertext(ciphertext)
	if err != nil {
		return nil, err
	}
	k, ok := kr.byID[keyID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownKey, keyID)
	}
	gcm, err := newGCM(k.secret[:])
	if err != nil {
		return nil, err
	}
	if len(payload) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	pt, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(aad))
	if err != nil {
		return nil, errors.New("ciphertext authentication failed")
	}
	return pt, nil
}

// DecryptString is a convenience wrapper around Decrypt.
func (kr *Keyring) DecryptString(ciphertext, aad string) (string, error) {
	b, err := kr.Decrypt(ciphertext, aad)
	return string(b), err
}

// KeyIDOf extracts the key ID from a ciphertext without decrypting it.
func KeyIDOf(ciphertext string) (string, error) {
	id, _, err := splitCiphertext(ciphertext)
	return id, err
}

func splitCiphertext(s string) (string, []byte, error) {
	parts := strings.SplitN(s, ":", 3)
	if len(parts) != 3 || parts[0] != ciphertextPrefix || parts[1] == "" {
		return "", nil, errors.New("malformed ciphertext")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", nil, errors.New("malformed ciphertext payload")
	}
	return parts[1], payload, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
