package db

import (
	"context"
	"database/sql"
	"errors"
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
	UpdatedAt           time.Time
}

// SSHKeyAAD is the additional authenticated data for an SSH private key.
func SSHKeyAAD(id string) string { return "ssh_keys.private_key_encrypted:" + id }

const sshKeyCols = `id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at`

func scanSSHKey(row interface{ Scan(...any) error }) (*SSHKey, error) {
	var k SSHKey
	var def int
	var created, updated string
	err := row.Scan(&k.ID, &k.Name, &k.Algorithm, &k.PublicKey, &k.PrivateKeyEncrypted, &k.Fingerprint, &def, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	k.IsDefault = def != 0
	k.CreatedAt, k.UpdatedAt = ParseTime(created), ParseTime(updated)
	return &k, nil
}

// InsertSSHKey stores a key pair.
func InsertSSHKey(ctx context.Context, q Querier, k *SSHKey) error {
	now := FormatTime(k.CreatedAt)
	_, err := q.ExecContext(ctx, `INSERT INTO ssh_keys(`+sshKeyCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		k.ID, k.Name, k.Algorithm, k.PublicKey, k.PrivateKeyEncrypted, k.Fingerprint, boolInt(k.IsDefault), now, now)
	return mapUnique(err)
}

// GetSSHKey loads a key by ID.
func GetSSHKey(ctx context.Context, q Querier, id string) (*SSHKey, error) {
	return scanSSHKey(q.QueryRowContext(ctx, `SELECT `+sshKeyCols+` FROM ssh_keys WHERE id = ?`, id))
}

// GetDefaultSSHKey loads the default key.
func GetDefaultSSHKey(ctx context.Context, q Querier) (*SSHKey, error) {
	return scanSSHKey(q.QueryRowContext(ctx, `SELECT `+sshKeyCols+` FROM ssh_keys WHERE is_default = 1`))
}

// ListSSHKeys returns all keys ordered by name.
func ListSSHKeys(ctx context.Context, q Querier) ([]*SSHKey, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+sshKeyCols+` FROM ssh_keys ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SSHKey
	for rows.Next() {
		k, err := scanSSHKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// SetDefaultSSHKey marks one key as default (and clears the others).
func SetDefaultSSHKey(ctx context.Context, q Querier, id string, now time.Time) error {
	if _, err := q.ExecContext(ctx, `UPDATE ssh_keys SET is_default = 0, updated_at = ? WHERE is_default = 1 AND id != ?`, FormatTime(now), id); err != nil {
		return err
	}
	res, err := q.ExecContext(ctx, `UPDATE ssh_keys SET is_default = 1, updated_at = ? WHERE id = ?`, FormatTime(now), id)
	return affectedOne(res, err)
}

// DeleteSSHKey removes a key.
func DeleteSSHKey(ctx context.Context, q Querier, id string) error {
	res, err := q.ExecContext(ctx, `DELETE FROM ssh_keys WHERE id = ?`, id)
	return affectedOne(res, err)
}

// CountSSHKeys returns the number of stored keys.
func CountSSHKeys(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM ssh_keys`).Scan(&n)
	return n, err
}
