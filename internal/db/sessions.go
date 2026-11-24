package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Session is a server-side login session.
type Session struct {
	ID            string
	AdminID       string
	TokenHash     string
	CSRFTokenHash string
	ClientIP      string
	UserAgent     string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	ExpiresAt     time.Time
}

const sessionCols = `id, admin_id, token_hash, csrf_token_hash, client_ip, user_agent, created_at, last_seen_at, expires_at`

func scanSession(row interface{ Scan(...any) error }) (*Session, error) {
	var s Session
	var created, seen, expires string
	if err := row.Scan(&s.ID, &s.AdminID, &s.TokenHash, &s.CSRFTokenHash, &s.ClientIP, &s.UserAgent,
		&created, &seen, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	s.CreatedAt, s.LastSeenAt, s.ExpiresAt = ParseTime(created), ParseTime(seen), ParseTime(expires)
	return &s, nil
}

// InsertSession stores a new session.
func InsertSession(ctx context.Context, q Querier, s *Session) error {
	_, err := q.ExecContext(ctx, `INSERT INTO admin_sessions(`+sessionCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.AdminID, s.TokenHash, s.CSRFTokenHash, s.ClientIP, s.UserAgent,
		FormatTime(s.CreatedAt), FormatTime(s.LastSeenAt), FormatTime(s.ExpiresAt))
	return err
}

// GetSessionByTokenHash looks up a session by cookie token hash.
func GetSessionByTokenHash(ctx context.Context, q Querier, hash string) (*Session, error) {
	return scanSession(q.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM admin_sessions WHERE token_hash = ?`, hash))
}

// GetSession looks up a session by ID.
func GetSession(ctx context.Context, q Querier, id string) (*Session, error) {
	return scanSession(q.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM admin_sessions WHERE id = ?`, id))
}

// ListSessions returns sessions of one account, or all when adminID is empty.
func ListSessions(ctx context.Context, q Querier, adminID string) ([]*Session, error) {
	query := `SELECT ` + sessionCols + ` FROM admin_sessions`
	var args []any
	if adminID != "" {
		query += ` WHERE admin_id = ?`
		args = append(args, adminID)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY created_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// TouchSession updates last_seen_at.
func TouchSession(ctx context.Context, q Querier, id string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?`, FormatTime(now), id)
	return err
}

// DeleteSession removes one session.
func DeleteSession(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM admin_sessions WHERE id = ?`, id)
	return err
}

// DeleteSessionsOfAdmin removes all sessions of an account except keepID (may be empty)
// and returns the removed session IDs.
func DeleteSessionsOfAdmin(ctx context.Context, q Querier, adminID, keepID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM admin_sessions WHERE admin_id = ? AND id != ?`, adminID, keepID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM admin_sessions WHERE admin_id = ? AND id != ?`, adminID, keepID); err != nil {
		return nil, err
	}
	return ids, nil
}

// DeleteExpiredSessions removes sessions past their absolute expiry or idle deadline.
func DeleteExpiredSessions(ctx context.Context, q Querier, now time.Time, idleBefore time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen_at <= ?`,
		FormatTime(now), FormatTime(idleBefore))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
