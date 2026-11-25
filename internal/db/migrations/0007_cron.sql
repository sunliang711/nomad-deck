-- Platform scheduled jobs and their run history.
CREATE TABLE cron_jobs (
    id             TEXT PRIMARY KEY,
    job_key        TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    cron_expr      TEXT NOT NULL,
    overlap_policy TEXT NOT NULL DEFAULT 'skip_if_running' CHECK (overlap_policy IN ('skip_if_running', 'queue_one')),
    misfire_policy TEXT NOT NULL DEFAULT 'skip' CHECK (misfire_policy IN ('skip', 'run_once')),
    enabled        INTEGER NOT NULL DEFAULT 1,
    payload_json   TEXT NOT NULL DEFAULT '{}',
    is_builtin     INTEGER NOT NULL DEFAULT 0,
    last_run_at    TEXT,
    last_status    TEXT NOT NULL DEFAULT '',
    next_run_at    TEXT,
    updated_at     TEXT NOT NULL
);

CREATE TABLE cron_job_runs (
    id                TEXT PRIMARY KEY,
    cron_job_id       TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    run_key           TEXT NOT NULL UNIQUE,
    scheduled_for     TEXT NOT NULL,
    operation_task_id TEXT NOT NULL DEFAULT '',
    trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
    status            TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
    summary           TEXT NOT NULL DEFAULT '',
    detail_log        TEXT NOT NULL DEFAULT '',
    started_at        TEXT NOT NULL,
    finished_at       TEXT
);
CREATE INDEX idx_cron_job_runs_job ON cron_job_runs(cron_job_id, started_at);
CREATE INDEX idx_cron_job_runs_started ON cron_job_runs(started_at);
