package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// BackupRun records one control-plane disaster-recovery backup or offsite
// Raft snapshot upload.
type BackupRun struct {
	ID           string
	Kind         string // control_plane | raft_snapshot
	ClusterID    string
	ClusterName  string
	SnapshotID   string
	TriggerType  string // scheduled | manual
	TriggeredBy  string
	Status       string // running | success | failed
	SizeBytes    int64
	SHA256       string
	ObjectName   string
	TargetsJSON  string
	ErrorMessage string
	StartedAt    time.Time
	FinishedAt   time.Time
}

const backupRunCols = `id, kind, cluster_id, cluster_name, snapshot_id, trigger_type, triggered_by, status, size_bytes,
	sha256, object_name, targets_json, error_message, started_at, COALESCE(finished_at, '')`

func scanBackupRun(row interface{ Scan(...any) error }) (*BackupRun, error) {
	var r BackupRun
	var started, finished string
	err := row.Scan(&r.ID, &r.Kind, &r.ClusterID, &r.ClusterName, &r.SnapshotID, &r.TriggerType, &r.TriggeredBy,
		&r.Status, &r.SizeBytes, &r.SHA256, &r.ObjectName, &r.TargetsJSON, &r.ErrorMessage, &started, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.StartedAt = ParseTime(started)
	r.FinishedAt = ParseTime(finished)
	return &r, nil
}

// InsertBackupRun records the start of a backup run.
func InsertBackupRun(ctx context.Context, q Querier, r *BackupRun) error {
	if r.TargetsJSON == "" {
		r.TargetsJSON = "[]"
	}
	_, err := q.ExecContext(ctx, `INSERT INTO backup_runs (id, kind, cluster_id, cluster_name, snapshot_id, trigger_type,
		triggered_by, status, size_bytes, sha256, object_name, targets_json, error_message, started_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Kind, r.ClusterID, r.ClusterName, r.SnapshotID, r.TriggerType, r.TriggeredBy, r.Status, r.SizeBytes,
		r.SHA256, r.ObjectName, r.TargetsJSON, r.ErrorMessage, FormatTime(r.StartedAt))
	return err
}

// FinishBackupRun updates a backup run with its outcome.
func FinishBackupRun(ctx context.Context, q Querier, id, status string, sizeBytes int64, sha, obj, targetsJSON, errMsg string, at time.Time) error {
	if targetsJSON == "" {
		targetsJSON = "[]"
	}
	_, err := q.ExecContext(ctx, `UPDATE backup_runs SET status = ?, size_bytes = ?, sha256 = ?, object_name = ?,
		targets_json = ?, error_message = ?, finished_at = ? WHERE id = ?`,
		status, sizeBytes, sha, obj, targetsJSON, errMsg, FormatTime(at), id)
	return err
}

// ListBackupRuns returns recent backup runs, optionally filtered by kind.
func ListBackupRuns(ctx context.Context, q Querier, kind string, limit int) ([]*BackupRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `SELECT ` + backupRunCols + ` FROM backup_runs`
	var args []any
	if kind != "" {
		query += ` WHERE kind = ?`
		args = append(args, kind)
	}
	query += ` ORDER BY started_at DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BackupRun
	for rows.Next() {
		r, err := scanBackupRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountConsecutiveFailedBackups counts consecutive failed runs starting from the
// most recent finished run of kind (or all kinds if kind == "").
func CountConsecutiveFailedBackups(ctx context.Context, q Querier, kind string) (int, error) {
	query := `SELECT status FROM backup_runs WHERE status IN ('success', 'failed')`
	var args []any
	if kind != "" {
		query += ` AND kind = ?`
		args = append(args, kind)
	}
	query += ` ORDER BY started_at DESC, id DESC LIMIT 50`
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			return 0, err
		}
		if status != "failed" {
			break
		}
		n++
	}
	return n, rows.Err()
}
