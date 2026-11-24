package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// GetSetting reads a raw setting value and its secret flag.
func GetSetting(ctx context.Context, q Querier, key string) (value string, secret bool, err error) {
	var s int
	err = q.QueryRowContext(ctx, `SELECT value, is_secret FROM system_settings WHERE key = ?`, key).Scan(&value, &s)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, ErrNotFound
	}
	return value, s != 0, err
}

// PutSetting upserts a raw setting value.
func PutSetting(ctx context.Context, q Querier, key, value string, secret bool, now string) error {
	_, err := q.ExecContext(ctx, `INSERT INTO system_settings(key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at`,
		key, value, boolInt(secret), now)
	return err
}

// GetSettingJSON decodes a non-secret JSON setting into v; it returns
// ErrNotFound when the key is absent.
func GetSettingJSON(ctx context.Context, q Querier, key string, v any) error {
	raw, _, err := GetSetting(ctx, q, key)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), v)
}

// PutSettingJSON stores v as a non-secret JSON setting.
func PutSettingJSON(ctx context.Context, q Querier, key string, v any, now string) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return PutSetting(ctx, q, key, string(b), false, now)
}

// IntSetting returns an integer setting or def when absent or invalid.
func IntSetting(ctx context.Context, q Querier, key string, def int) int {
	var v int
	if err := GetSettingJSON(ctx, q, key, &v); err != nil || v <= 0 {
		return def
	}
	return v
}
