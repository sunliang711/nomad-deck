package crypto

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"

	"golang.org/x/crypto/ssh"
)

// RandomToken returns n random bytes encoded as unpadded base64url.
func RandomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SHA256Hex returns the hex SHA-256 of s.
func SHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// HMACToken derives a deterministic token from key and message.
func HMACToken(key []byte, msg string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// SSHKeyPair is a generated OpenSSH key pair.
type SSHKeyPair struct {
	PublicKey   string // authorized_keys line
	PrivatePEM  []byte // OpenSSH private key
	Fingerprint string // SHA256:...
}

// GenerateEd25519 creates a new Ed25519 key pair in OpenSSH formats.
func GenerateEd25519(comment string) (*SSHKeyPair, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	line := string(ssh.MarshalAuthorizedKey(sshPub))
	if len(line) > 0 && line[len(line)-1] == '\n' {
		line = line[:len(line)-1]
	}
	if comment != "" {
		line += " " + comment
	}
	return &SSHKeyPair{
		PublicKey:   line,
		PrivatePEM:  pem.EncodeToMemory(block),
		Fingerprint: ssh.FingerprintSHA256(sshPub),
	}, nil
}
