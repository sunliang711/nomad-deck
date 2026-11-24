package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// AuditLog is one audit record.
type AuditLog struct {
	ID                 string    `json:"id"`
	ActorID            string    `json:"actor_id"`
	ActorName          string    `json:"actor_name"`
	ClientIP           string    `json:"client_ip"`
	Action             string    `json:"action"`
	ResourceType       string    `json:"resource_type"`
	ResourceID         string    `json:"resource_id"`
	ResourceName       string    `json:"resource_name"`
	RequestSummaryJSON string    `json:"request_summary_json"`
	OperationTaskID    string    `json:"operation_task_id"`
	Result             string    `json:"result"`
	ErrorMessage       string    `json:"error_message"`
	DurationMS         int64     `json:"duration_ms"`
	CreatedAt          time.Time `json:"created_at"`
}

const auditCols = `id, actor_id, actor_name, client_ip, action, resource_type, resource_id, resource_name,
	request_summary_json, operation_task_id, result, error_message, duration_ms, created_at`

// InsertAuditLog stores an audit record.
func InsertAuditLog(ctx context.Context, q Querier, a *AuditLog) error {
	_, err := q.ExecContext(ctx, `INSERT INTO audit_logs(`+auditCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.ActorID, a.ActorName, a.ClientIP, a.Action, a.ResourceType, a.ResourceID, a.ResourceName,
		a.RequestSummaryJSON, a.OperationTaskID, a.Result, a.ErrorMessage, a.DurationMS, FormatTime(a.CreatedAt))
	return err
}

func scanAudit(row interface{ Scan(...any) error }) (*AuditLog, error) {
	var a AuditLog
	var created string
	if err := row.Scan(&a.ID, &a.ActorID, &a.ActorName, &a.ClientIP, &a.Action, &a.ResourceType, &a.ResourceID,
		&a.ResourceName, &a.RequestSummaryJSON, &a.OperationTaskID, &a.Result, &a.ErrorMessage, &a.DurationMS, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.CreatedAt = ParseTime(created)
	return &a, nil
}

// GetAuditLog loads one record.
func GetAuditLog(ctx context.Context, q Querier, id string) (*AuditLog, error) {
	return scanAudit(q.QueryRowContext(ctx, `SELECT `+auditCols+` FROM audit_logs WHERE id = ?`, id))
}

// AuditFilter narrows an audit query. Results are ordered newest first and
// paginated with Before (an audit ID; ULIDs sort by time).
type AuditFilter struct {
	Action       string
	ResourceType string
	Result       string
	ActorName    string
	Keyword      string
	From, To     time.Time
	Before       string
	Limit        int
}

// ListAuditLogs returns records matching f.
func ListAuditLogs(ctx context.Context, q Querier, f AuditFilter) ([]*AuditLog, error) {
	var where []string
	var args []any
	add := func(cond string, v any) { where = append(where, cond); args = append(args, v) }
	if f.Action != "" {
		add("action = ?", f.Action)
	}
	if f.ResourceType != "" {
		add("resource_type = ?", f.ResourceType)
	}
	if f.Result != "" {
		add("result = ?", f.Result)
	}
	if f.ActorName != "" {
		add("actor_name = ?", f.ActorName)
	}
	if !f.From.IsZero() {
		add("created_at >= ?", FormatTime(f.From))
	}
	if !f.To.IsZero() {
		add("created_at < ?", FormatTime(f.To))
	}
	if f.Before != "" {
		add("id < ?", f.Before)
	}
	if f.Keyword != "" {
		kw := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(f.Keyword) + "%"
		where = append(where, `(resource_name LIKE ? ESCAPE '\' OR resource_id LIKE ? ESCAPE '\' OR error_message LIKE ? ESCAPE '\' OR request_summary_json LIKE ? ESCAPE '\')`)
		args = append(args, kw, kw, kw, kw)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT ` + auditCols + ` FROM audit_logs`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, " AND ")
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditLog
	for rows.Next() {
		a, err := scanAudit(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
