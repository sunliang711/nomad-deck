-- Align cron jobs and runs with per-job schedule_type, timezone, timeout_seconds,
-- config_json, last_summary, duration_ms, and timeout status.
ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'cron';
ALTER TABLE cron_jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT '';
ALTER TABLE cron_jobs ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 600;
ALTER TABLE cron_jobs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cron_jobs ADD COLUMN last_summary TEXT NOT NULL DEFAULT '';

CREATE TABLE cron_job_runs_new (
    id                TEXT PRIMARY KEY,
    cron_job_id       TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    run_key           TEXT NOT NULL UNIQUE,
    scheduled_for     TEXT NOT NULL,
    operation_task_id TEXT NOT NULL DEFAULT '',
    trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
    status            TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'timeout', 'skipped')),
    summary           TEXT NOT NULL DEFAULT '',
    detail_log        TEXT NOT NULL DEFAULT '',
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    started_at        TEXT NOT NULL,
    finished_at       TEXT
);

INSERT INTO cron_job_runs_new (
    id, cron_job_id, run_key, scheduled_for, operation_task_id, trigger_type,
    status, summary, detail_log, duration_ms, started_at, finished_at
)
SELECT
    id, cron_job_id, run_key, scheduled_for, operation_task_id, trigger_type,
    status, summary, detail_log, 0, started_at, finished_at
FROM cron_job_runs;

DROP TABLE cron_job_runs;
ALTER TABLE cron_job_runs_new RENAME TO cron_job_runs;
CREATE INDEX idx_cron_job_runs_job ON cron_job_runs(cron_job_id, started_at);
CREATE INDEX idx_cron_job_runs_started ON cron_job_runs(started_at);
