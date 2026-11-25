package db

import (
	"context"
	"fmt"
	"strings"
)

// EncryptedField describes one storage location holding master-key ciphertext.
// Every encrypted location must be registered here so that the startup
// self-check and master key rotation cover it.
type EncryptedField struct {
	Name  string
	Query string // must select (row identifier, ciphertext)
}

// EncryptedFields is the registry of encrypted database locations.
var EncryptedFields = []EncryptedField{
	{Name: "system_settings.value", Query: `SELECT key, value FROM system_settings WHERE is_secret = 1 AND value != ''`},
	{Name: "ssh_keys.private_key_encrypted", Query: `SELECT id, private_key_encrypted FROM ssh_keys`},
}

// KeyIDProblem is a ciphertext that cannot be decrypted with loaded keys.
type KeyIDProblem struct {
	Field string
	Row   string
	KeyID string
	Err   string
}

func (p KeyIDProblem) String() string {
	if p.Err != "" {
		return fmt.Sprintf("%s[%s]: %s", p.Field, p.Row, p.Err)
	}
	return fmt.Sprintf("%s[%s]: key %s not loaded", p.Field, p.Row, p.KeyID)
}

// CheckKeyIDs scans every registered encrypted field and reports ciphertexts
// whose key ID is not loaded (or that are malformed).
func CheckKeyIDs(ctx context.Context, q Querier, keyIDOf func(string) (string, error), loaded func(string) bool) ([]KeyIDProblem, error) {
	var problems []KeyIDProblem
	for _, f := range EncryptedFields {
		rows, err := q.QueryContext(ctx, f.Query)
		if err != nil {
			return nil, fmt.Errorf("scan %s: %w", f.Name, err)
		}
		for rows.Next() {
			var row, ct string
			if err := rows.Scan(&row, &ct); err != nil {
				rows.Close()
				return nil, err
			}
			id, err := keyIDOf(ct)
			switch {
			case err != nil:
				problems = append(problems, KeyIDProblem{Field: f.Name, Row: row, Err: err.Error()})
			case !loaded(id):
				problems = append(problems, KeyIDProblem{Field: f.Name, Row: row, KeyID: id})
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return problems, nil
}

// FormatProblems joins problems for an error message (at most 10 shown).
func FormatProblems(ps []KeyIDProblem) string {
	var b strings.Builder
	for i, p := range ps {
		if i == 10 {
			fmt.Fprintf(&b, "\n  ... and %d more", len(ps)-10)
			break
		}
		b.WriteString("\n  ")
		b.WriteString(p.String())
	}
	return b.String()
}
