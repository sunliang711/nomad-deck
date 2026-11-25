package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// KeyRotationJournal tracks a master-key rotation so interrupted runs can resume.
type KeyRotationJournal struct {
	ID           string
	OldKeyID     string
	NewKeyID     string
	State        string // running | verifying | completed | failed
	ProgressJSON string
	StartedBy    string
	StartedAt    time.Time
	FinishedAt   time.Time
	ErrorMessage string
}

const rotCols = `id, old_key_id, new_key_id, state, progress_json, started_by, started_at, COALESCE(finished_at, ''), error_message`

func scanRotation(row interface{ Scan(...any) error }) (*KeyRotationJournal, error) {
	var j KeyRotationJournal
	var started, finished string
	err := row.Scan(&j.ID, &j.OldKeyID, &j.NewKeyID, &j.State, &j.ProgressJSON, &j.StartedBy, &started, &finished, &j.ErrorMessage)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	j.StartedAt = ParseTime(started)
	j.FinishedAt = ParseTime(finished)
	return &j, nil
}

// InsertKeyRotation creates a rotation journal entry.
func InsertKeyRotation(ctx context.Context, q Querier, j *KeyRotationJournal) error {
	if j.ProgressJSON == "" {
		j.ProgressJSON = "{}"
	}
	_, err := q.ExecContext(ctx, `INSERT INTO key_rotation_journal (id, old_key_id, new_key_id, state, progress_json,
		started_by, started_at, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID, j.OldKeyID, j.NewKeyID, j.State, j.ProgressJSON, j.StartedBy, FormatTime(j.StartedAt), j.ErrorMessage)
	return err
}

// UpdateKeyRotation updates state, progress and finish metadata.
func UpdateKeyRotation(ctx context.Context, q Querier, j *KeyRotationJournal) error {
	if j.ProgressJSON == "" {
		j.ProgressJSON = "{}"
	}
	_, err := q.ExecContext(ctx, `UPDATE key_rotation_journal SET state = ?, progress_json = ?, finished_at = ?, error_message = ? WHERE id = ?`,
		j.State, j.ProgressJSON, nullTime(j.FinishedAt), j.ErrorMessage, j.ID)
	return err
}

// GetLatestKeyRotation returns the newest rotation journal entry.
func GetLatestKeyRotation(ctx context.Context, q Querier) (*KeyRotationJournal, error) {
	return scanRotation(q.QueryRowContext(ctx, `SELECT `+rotCols+` FROM key_rotation_journal ORDER BY started_at DESC, id DESC LIMIT 1`))
}

// GetActiveKeyRotation returns the newest non-completed journal matching old/new key IDs.
func GetActiveKeyRotation(ctx context.Context, q Querier, oldKeyID, newKeyID string) (*KeyRotationJournal, error) {
	return scanRotation(q.QueryRowContext(ctx, `SELECT `+rotCols+` FROM key_rotation_journal
		WHERE old_key_id = ? AND new_key_id = ? AND state != 'completed'
		ORDER BY started_at DESC, id DESC LIMIT 1`, oldKeyID, newKeyID))
}
