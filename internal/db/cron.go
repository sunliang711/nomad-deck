package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Cron run statuses.
const (
	RunRunning = "running"
	RunSuccess = "success"
	RunFailed  = "failed"
	RunTimeout = "timeout"
	RunSkipped = "skipped"
)

// CronJob is a platform scheduled job.
type CronJob struct {
	ID             string    `json:"id"`
	JobKey         string    `json:"job_key"`
	Name           string    `json:"name"`
	ScheduleType   string    `json:"schedule_type"`
	CronExpr       string    `json:"cron_expr"`
	Timezone       string    `json:"timezone"`
	TimeoutSeconds int       `json:"timeout_seconds"`
	OverlapPolicy  string    `json:"overlap_policy"`
	MisfirePolicy  string    `json:"misfire_policy"`
	Enabled        bool      `json:"enabled"`
	PayloadJSON    string    `json:"-"`
	ConfigJSON     string    `json:"-"`
	IsBuiltin      bool      `json:"is_builtin"`
	LastRunAt      time.Time `json:"last_run_at"`
	LastStatus     string    `json:"last_status"`
	LastSummary    string    `json:"last_summary"`
	NextRunAt      time.Time `json:"next_run_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// CronRun is one execution of a scheduled job.
type CronRun struct {
	ID              string    `json:"id"`
	CronJobID       string    `json:"cron_job_id"`
	RunKey          string    `json:"run_key"`
	ScheduledFor    time.Time `json:"scheduled_for"`
	OperationTaskID string    `json:"operation_task_id"`
	TriggerType     string    `json:"trigger_type"`
	Status          string    `json:"status"`
	Summary         string    `json:"summary"`
	DetailLog       string    `json:"detail_log,omitempty"`
	DurationMS      int64     `json:"duration_ms"`
	StartedAt       time.Time `json:"started_at"`
	FinishedAt      time.Time `json:"finished_at"`
}

const cronCols = `id, job_key, name, schedule_type, cron_expr, timezone, timeout_seconds, overlap_policy, misfire_policy, enabled,
	payload_json, config_json, is_builtin, COALESCE(last_run_at, ''), last_status, last_summary, COALESCE(next_run_at, ''), updated_at`

func scanCron(row interface{ Scan(...any) error }) (*CronJob, error) {
	var j CronJob
	var enabled, builtin int
	var last, next, updated string
	if err := row.Scan(&j.ID, &j.JobKey, &j.Name, &j.ScheduleType, &j.CronExpr, &j.Timezone, &j.TimeoutSeconds,
		&j.OverlapPolicy, &j.MisfirePolicy, &enabled, &j.PayloadJSON, &j.ConfigJSON,
		&builtin, &last, &j.LastStatus, &j.LastSummary, &next, &updated); err != nil {
		return nil, err
	}
	if j.ScheduleType == "" {
		j.ScheduleType = "cron"
	}
	if j.TimeoutSeconds <= 0 {
		j.TimeoutSeconds = 600
	}
	j.Enabled, j.IsBuiltin = enabled == 1, builtin == 1
	j.LastRunAt, j.NextRunAt, j.UpdatedAt = ParseTime(last), ParseTime(next), ParseTime(updated)
	return &j, nil
}

// InsertCronJob stores a new job; an existing job_key is reported as ErrUnique.
func InsertCronJob(ctx context.Context, q Querier, j *CronJob) error {
	timeoutSec := j.TimeoutSeconds
	if timeoutSec <= 0 {
		timeoutSec = 600
	}
	_, err := q.ExecContext(ctx, `INSERT INTO cron_jobs(id, job_key, name, schedule_type, cron_expr, timezone, timeout_seconds,
		overlap_policy, misfire_policy, enabled, payload_json, config_json, is_builtin, next_run_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID, j.JobKey, j.Name, orDefault(j.ScheduleType, "cron"), j.CronExpr, j.Timezone, timeoutSec,
		j.OverlapPolicy, j.MisfirePolicy, boolInt(j.Enabled), orDefault(j.PayloadJSON, "{}"), orDefault(j.ConfigJSON, "{}"),
		boolInt(j.IsBuiltin), nullTime(j.NextRunAt), FormatTime(j.UpdatedAt))
	return mapUnique(err)
}

// UpdateCronJob saves the editable fields of a job.
func UpdateCronJob(ctx context.Context, q Querier, j *CronJob) error {
	timeoutSec := j.TimeoutSeconds
	if timeoutSec <= 0 {
		timeoutSec = 600
	}
	_, err := q.ExecContext(ctx, `UPDATE cron_jobs SET name = ?, schedule_type = ?, cron_expr = ?, timezone = ?, timeout_seconds = ?,
		overlap_policy = ?, misfire_policy = ?, enabled = ?, payload_json = ?, config_json = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
		j.Name, orDefault(j.ScheduleType, "cron"), j.CronExpr, j.Timezone, timeoutSec,
		j.OverlapPolicy, j.MisfirePolicy, boolInt(j.Enabled), orDefault(j.PayloadJSON, "{}"), orDefault(j.ConfigJSON, "{}"),
		nullTime(j.NextRunAt), FormatTime(j.UpdatedAt), j.ID)
	return err
}

// SetCronNext records the next scheduled time.
func SetCronNext(ctx context.Context, q Querier, id string, next time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cron_jobs SET next_run_at = ? WHERE id = ?`, nullTime(next), id)
	return err
}

// SetCronLast records the latest run outcome and summary.
func SetCronLast(ctx context.Context, q Querier, id, status, summary string, at time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_summary = ? WHERE id = ?`,
		FormatTime(at), status, summary, id)
	return err
}

// GetCronJob loads one job.
func GetCronJob(ctx context.Context, q Querier, id string) (*CronJob, error) {
	j, err := scanCron(q.QueryRowContext(ctx, `SELECT `+cronCols+` FROM cron_jobs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return j, err
}

// GetCronJobByKey loads one job by its key.
func GetCronJobByKey(ctx context.Context, q Querier, key string) (*CronJob, error) {
	j, err := scanCron(q.QueryRowContext(ctx, `SELECT `+cronCols+` FROM cron_jobs WHERE job_key = ?`, key))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return j, err
}

// ListCronJobs lists all jobs, built-in first.
func ListCronJobs(ctx context.Context, q Querier) ([]*CronJob, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+cronCols+` FROM cron_jobs ORDER BY is_builtin DESC, job_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*CronJob
	for rows.Next() {
		j, err := scanCron(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// DeleteCronJob removes a job and its runs.
func DeleteCronJob(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM cron_jobs WHERE id = ?`, id)
	return err
}

// InsertCronRun records a run; a duplicate run_key yields ErrUnique.
func InsertCronRun(ctx context.Context, q Querier, r *CronRun) error {
	_, err := q.ExecContext(ctx, `INSERT INTO cron_job_runs(id, cron_job_id, run_key, scheduled_for, operation_task_id, trigger_type,
		status, summary, detail_log, duration_ms, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.CronJobID, r.RunKey, FormatTime(r.ScheduledFor), r.OperationTaskID, r.TriggerType, r.Status, r.Summary, r.DetailLog,
		r.DurationMS, FormatTime(r.StartedAt), nullTime(r.FinishedAt))
	return mapUnique(err)
}

// SetCronRunTask links a run to the operation task that does its work.
func SetCronRunTask(ctx context.Context, q Querier, id, taskID string) error {
	_, err := q.ExecContext(ctx, `UPDATE cron_job_runs SET operation_task_id = ? WHERE id = ?`, taskID, id)
	return err
}

// FinishCronRun records a run's outcome.
func FinishCronRun(ctx context.Context, q Querier, id, status, summary, detail string, durationMS int64, at time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cron_job_runs SET status = ?, summary = ?, detail_log = ?, duration_ms = ?, finished_at = ? WHERE id = ?`,
		status, summary, detail, durationMS, FormatTime(at), id)
	return err
}

// FailRunningCronRuns closes runs left open by a previous process.
func FailRunningCronRuns(ctx context.Context, q Querier, at time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cron_job_runs SET status = 'failed', summary = '控制面在执行期间重启', finished_at = ?
		WHERE status = 'running'`, FormatTime(at))
	return err
}

const runCols = `id, cron_job_id, run_key, scheduled_for, operation_task_id, trigger_type, status, summary, detail_log,
	duration_ms, started_at, COALESCE(finished_at, '')`

func scanRun(row interface{ Scan(...any) error }) (*CronRun, error) {
	var r CronRun
	var sched, started, finished string
	if err := row.Scan(&r.ID, &r.CronJobID, &r.RunKey, &sched, &r.OperationTaskID, &r.TriggerType, &r.Status, &r.Summary,
		&r.DetailLog, &r.DurationMS, &started, &finished); err != nil {
		return nil, err
	}
	r.ScheduledFor, r.StartedAt, r.FinishedAt = ParseTime(sched), ParseTime(started), ParseTime(finished)
	return &r, nil
}

// ListCronRuns lists a job's latest runs (newest first).
func ListCronRuns(ctx context.Context, q Querier, jobID string, limit int) ([]*CronRun, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := q.QueryContext(ctx, `SELECT `+runCols+` FROM cron_job_runs WHERE cron_job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
		jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*CronRun
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListCronRunsPage lists a job's runs with pagination and optional failed/timeout filter.
func ListCronRunsPage(ctx context.Context, q Querier, jobID string, failedOnly bool, page, pageSize int) ([]*CronRun, int, error) {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 20
	}
	where := `cron_job_id = ?`
	if failedOnly {
		where += ` AND status IN ('failed', 'timeout')`
	}
	var total int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM cron_job_runs WHERE `+where, jobID).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := (page - 1) * pageSize
	rows, err := q.QueryContext(ctx, `SELECT `+runCols+` FROM cron_job_runs WHERE `+where+` ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
		jobID, pageSize, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []*CronRun{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// GetCronRun loads one run.
func GetCronRun(ctx context.Context, q Querier, id string) (*CronRun, error) {
	r, err := scanRun(q.QueryRowContext(ctx, `SELECT `+runCols+` FROM cron_job_runs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// DeleteOldCronRuns removes finished runs started before the cutoff.
func DeleteOldCronRuns(ctx context.Context, q Querier, before time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM cron_job_runs WHERE status != 'running' AND started_at < ?`, FormatTime(before))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteOldAuditLogs removes audit records created before the cutoff.
func DeleteOldAuditLogs(ctx context.Context, q Querier, before time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM audit_logs WHERE created_at < ?`, FormatTime(before))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// OldFinishedTaskIDs lists finished tasks created before the cutoff.
func OldFinishedTaskIDs(ctx context.Context, q Querier, before time.Time) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM operation_tasks WHERE status NOT IN ('pending', 'running', 'needs_reconcile')
		AND created_at < ?`, FormatTime(before))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DeleteTasks removes tasks and their steps.
func DeleteTasks(ctx context.Context, q Querier, ids []string) error {
	for len(ids) > 0 {
		n := min(len(ids), 200)
		batch := ids[:n]
		ids = ids[n:]
		args := make([]any, len(batch))
		for i, id := range batch {
			args[i] = id
		}
		ph := strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")
		if _, err := q.ExecContext(ctx, `DELETE FROM operation_task_steps WHERE task_id IN (`+ph+`)`, args...); err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM operation_tasks WHERE id IN (`+ph+`)`, args...); err != nil {
			return err
		}
	}
	return nil
}
