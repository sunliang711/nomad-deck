package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Roles.
const (
	RoleAdmin  = "admin"
	RoleViewer = "viewer"
)

// Admin is an account that can sign in to the management UI.
type Admin struct {
	ID             string
	Username       string
	PasswordHash   string
	Role           string
	Disabled       bool
	FailedAttempts int
	LockedUntil    time.Time
	LastLoginAt    time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const adminCols = `id, username, password_hash, role, is_disabled, failed_attempts,
	COALESCE(locked_until, ''), COALESCE(last_login_at, ''), created_at, updated_at`

func scanAdmin(row interface{ Scan(...any) error }) (*Admin, error) {
	var a Admin
	var disabled int
	var locked, last, created, updated string
	if err := row.Scan(&a.ID, &a.Username, &a.PasswordHash, &a.Role, &disabled, &a.FailedAttempts,
		&locked, &last, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.Disabled = disabled != 0
	a.LockedUntil, a.LastLoginAt = ParseTime(locked), ParseTime(last)
	a.CreatedAt, a.UpdatedAt = ParseTime(created), ParseTime(updated)
	return &a, nil
}

// CountAdmins returns the number of accounts.
func CountAdmins(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM admins`).Scan(&n)
	return n, err
}

// CountActiveAdminRole returns enabled accounts with the admin role.
func CountActiveAdminRole(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM admins WHERE role = 'admin' AND is_disabled = 0`).Scan(&n)
	return n, err
}

// InsertAdmin creates an account.
func InsertAdmin(ctx context.Context, q Querier, a *Admin) error {
	now := FormatTime(a.CreatedAt)
	_, err := q.ExecContext(ctx, `INSERT INTO admins(id, username, password_hash, role, is_disabled,
		failed_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
		a.ID, a.Username, a.PasswordHash, a.Role, boolInt(a.Disabled), now, now)
	return err
}

// GetAdmin loads an account by ID.
func GetAdmin(ctx context.Context, q Querier, id string) (*Admin, error) {
	return scanAdmin(q.QueryRowContext(ctx, `SELECT `+adminCols+` FROM admins WHERE id = ?`, id))
}

// GetAdminByUsername loads an account by username.
func GetAdminByUsername(ctx context.Context, q Querier, username string) (*Admin, error) {
	return scanAdmin(q.QueryRowContext(ctx, `SELECT `+adminCols+` FROM admins WHERE username = ?`, username))
}

// ListAdmins returns all accounts ordered by creation.
func ListAdmins(ctx context.Context, q Querier) ([]*Admin, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+adminCols+` FROM admins ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Admin
	for rows.Next() {
		a, err := scanAdmin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RecordLoginFailure stores the failure counter and optional lock deadline.
func RecordLoginFailure(ctx context.Context, q Querier, id string, attempts int, lockedUntil time.Time, now time.Time) error {
	var locked any
	if !lockedUntil.IsZero() {
		locked = FormatTime(lockedUntil)
	}
	_, err := q.ExecContext(ctx, `UPDATE admins SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
		attempts, locked, FormatTime(now), id)
	return err
}

// RecordLoginSuccess resets lockout state and stamps the login time.
func RecordLoginSuccess(ctx context.Context, q Querier, id string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE admins SET failed_attempts = 0, locked_until = NULL,
		last_login_at = ?, updated_at = ? WHERE id = ?`, FormatTime(now), FormatTime(now), id)
	return err
}

// UpdateAdminPassword sets a new password hash and clears lockout state.
func UpdateAdminPassword(ctx context.Context, q Querier, id, hash string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE admins SET password_hash = ?, failed_attempts = 0, locked_until = NULL,
		updated_at = ? WHERE id = ?`, hash, FormatTime(now), id)
	return affectedOne(res, err)
}

// UpdateAdminRole changes the role.
func UpdateAdminRole(ctx context.Context, q Querier, id, role string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE admins SET role = ?, updated_at = ? WHERE id = ?`, role, FormatTime(now), id)
	return affectedOne(res, err)
}

// UpdateAdminDisabled enables or disables an account.
func UpdateAdminDisabled(ctx context.Context, q Querier, id string, disabled bool, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE admins SET is_disabled = ?, updated_at = ? WHERE id = ?`,
		boolInt(disabled), FormatTime(now), id)
	return affectedOne(res, err)
}

// UpdateAdminUsername renames an account.
func UpdateAdminUsername(ctx context.Context, q Querier, id, username string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE admins SET username = ?, updated_at = ? WHERE id = ?`, username, FormatTime(now), id)
	return affectedOne(res, err)
}

func affectedOne(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
