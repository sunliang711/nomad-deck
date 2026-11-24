package db

import (
	"context"
	"time"
)

// SSHKey is a stored SSH key pair; the private key is encrypted.
type SSHKey struct {
	ID                  string
	Name                string
	Algorithm           string
	PublicKey           string
	PrivateKeyEncrypted string
	Fingerprint         string
	IsDefault           bool
	CreatedAt           time.Time
}

// SSHKeyAAD is the additional authenticated data for an SSH private key.
func SSHKeyAAD(id string) string { return "ssh_keys.private_key_encrypted:" + id }

// InsertSSHKey stores a key pair.
func InsertSSHKey(ctx context.Context, q Querier, k *SSHKey) error {
	now := FormatTime(k.CreatedAt)
	_, err := q.ExecContext(ctx, `INSERT INTO ssh_keys(id, name, algorithm, public_key, private_key_encrypted,
		fingerprint, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		k.ID, k.Name, k.Algorithm, k.PublicKey, k.PrivateKeyEncrypted, k.Fingerprint, boolInt(k.IsDefault), now, now)
	return err
}

// CountSSHKeys returns the number of stored keys.
func CountSSHKeys(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM ssh_keys`).Scan(&n)
	return n, err
}
