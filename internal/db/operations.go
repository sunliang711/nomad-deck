package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Task statuses.
const (
	TaskPending        = "pending"
	TaskRunning        = "running"
	TaskSuccess        = "success"
	TaskFailed         = "failed"
	TaskRolledBack     = "rolled_back"
	TaskInterrupted    = "interrupted"
	TaskNeedsReconcile = "needs_reconcile"
	TaskCancelled      = "cancelled"
)

// OperationTask is an asynchronous operation.
type OperationTask struct {
	ID                 string    `json:"id"`
	Action             string    `json:"action"`
	TargetType         string    `json:"target_type"`
	TargetID           string    `json:"target_id"`
	LockMode           string    `json:"lock_mode"`
	RemoteOpID         string    `json:"remote_op_id"`
	IntentJSON         string    `json:"-"`
	Status             string    `json:"status"`
	ParamsRedactedJSON string    `json:"-"`
	TriggeredBy        string    `json:"triggered_by"`
	CreatedAt          time.Time `json:"-"`
	StartedAt          time.Time `json:"-"`
	FinishedAt         time.Time `json:"-"`
	ErrorMessage       string    `json:"error_message"`
}

// OperationStep is one step of a task.
type OperationStep struct {
	ID           string
	TaskID       string
	StepOrder    int
	NodeID       string
	Name         string
	Status       string
	LogPath      string
	RemoteUnit   string
	ExitCode     *int
	StartedAt    time.Time
	FinishedAt   time.Time
	ErrorMessage string
}

const taskCols = `id, action, target_type, target_id, lock_mode, remote_op_id, intent_json, status, params_redacted_json,
	triggered_by, created_at, COALESCE(started_at, ''), COALESCE(finished_at, ''), error_message`

func scanTask(row interface{ Scan(...any) error }) (*OperationTask, error) {
	var t OperationTask
	var created, started, finished string
	err := row.Scan(&t.ID, &t.Action, &t.TargetType, &t.TargetID, &t.LockMode, &t.RemoteOpID, &t.IntentJSON, &t.Status,
		&t.ParamsRedactedJSON, &t.TriggeredBy, &created, &started, &finished, &t.ErrorMessage)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt, t.StartedAt, t.FinishedAt = ParseTime(created), ParseTime(started), ParseTime(finished)
	return &t, nil
}

// InsertTask creates a pending task.
func InsertTask(ctx context.Context, q Querier, t *OperationTask) error {
	_, err := q.ExecContext(ctx, `INSERT INTO operation_tasks(id, action, target_type, target_id, lock_mode, remote_op_id,
		intent_json, status, params_redacted_json, triggered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Action, t.TargetType, t.TargetID, t.LockMode, t.RemoteOpID, orDefault(t.IntentJSON, "{}"), t.Status,
		orDefault(t.ParamsRedactedJSON, "{}"), t.TriggeredBy, FormatTime(t.CreatedAt))
	return err
}

// GetTask loads a task.
func GetTask(ctx context.Context, q Querier, id string) (*OperationTask, error) {
	return scanTask(q.QueryRowContext(ctx, `SELECT `+taskCols+` FROM operation_tasks WHERE id = ?`, id))
}

// TaskFilter narrows task listings (newest first, paginated by Before).
type TaskFilter struct {
	Status     string
	Action     string
	TargetType string
	TargetID   string
	Before     string
	Limit      int
}

// ListTasks returns tasks matching f.
func ListTasks(ctx context.Context, q Querier, f TaskFilter) ([]*OperationTask, error) {
	var where []string
	var args []any
	add := func(c string, v any) { where = append(where, c); args = append(args, v) }
	if f.Status != "" {
		add("status = ?", f.Status)
	}
	if f.Action != "" {
		add("action = ?", f.Action)
	}
	if f.TargetType != "" {
		add("target_type = ?", f.TargetType)
	}
	if f.TargetID != "" {
		add("target_id = ?", f.TargetID)
	}
	if f.Before != "" {
		add("id < ?", f.Before)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT ` + taskCols + ` FROM operation_tasks`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, " AND ")
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY id DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OperationTask
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// MarkTaskRunning sets status running and started_at.
func MarkTaskRunning(ctx context.Context, q Querier, id string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_tasks SET status = 'running', started_at = ? WHERE id = ?`, FormatTime(now), id)
	return err
}

// FinishTask sets a terminal status.
func FinishTask(ctx context.Context, q Querier, id, status, errMsg string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_tasks SET status = ?, error_message = ?, finished_at = ? WHERE id = ?`,
		status, errMsg, FormatTime(now), id)
	return err
}

// UpdateTaskIntent stores the intent/checkpoint JSON.
func UpdateTaskIntent(ctx context.Context, q Querier, id, intent string) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_tasks SET intent_json = ? WHERE id = ?`, intent, id)
	return err
}

// ListUnfinishedTasks returns tasks left pending or running.
func ListUnfinishedTasks(ctx context.Context, q Querier) ([]*OperationTask, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+taskCols+` FROM operation_tasks WHERE status IN ('pending', 'running') ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OperationTask
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// InsertStep creates a step.
func InsertStep(ctx context.Context, q Querier, s *OperationStep) error {
	_, err := q.ExecContext(ctx, `INSERT INTO operation_task_steps(id, task_id, step_order, node_id, name, status, log_path,
		remote_unit, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.TaskID, s.StepOrder, s.NodeID, s.Name, s.Status, s.LogPath, s.RemoteUnit, FormatTime(s.StartedAt))
	return err
}

// FinishStep sets a step's terminal status.
func FinishStep(ctx context.Context, q Querier, id, status string, exitCode *int, errMsg string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_task_steps SET status = ?, exit_code = ?, error_message = ?, finished_at = ?
		WHERE id = ?`, status, exitCode, errMsg, FormatTime(now), id)
	return err
}

// SetStepRemoteUnit records the remote transient unit name.
func SetStepRemoteUnit(ctx context.Context, q Querier, id, unit string) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_task_steps SET remote_unit = ? WHERE id = ?`, unit, id)
	return err
}

// ListSteps returns a task's steps in order.
func ListSteps(ctx context.Context, q Querier, taskID string) ([]*OperationStep, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, task_id, step_order, node_id, name, status, log_path, remote_unit, exit_code,
		COALESCE(started_at, ''), COALESCE(finished_at, ''), error_message FROM operation_task_steps WHERE task_id = ? ORDER BY step_order`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*OperationStep
	for rows.Next() {
		var s OperationStep
		var code sql.NullInt64
		var started, finished string
		if err := rows.Scan(&s.ID, &s.TaskID, &s.StepOrder, &s.NodeID, &s.Name, &s.Status, &s.LogPath, &s.RemoteUnit, &code,
			&started, &finished, &s.ErrorMessage); err != nil {
			return nil, err
		}
		if code.Valid {
			c := int(code.Int64)
			s.ExitCode = &c
		}
		s.StartedAt, s.FinishedAt = ParseTime(started), ParseTime(finished)
		out = append(out, &s)
	}
	return out, rows.Err()
}

// MarkRunningStepsInterrupted marks running steps of a task as interrupted.
func MarkRunningStepsInterrupted(ctx context.Context, q Querier, taskID string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE operation_task_steps SET status = 'interrupted', finished_at = ?
		WHERE task_id = ? AND status = 'running'`, FormatTime(now), taskID)
	return err
}
