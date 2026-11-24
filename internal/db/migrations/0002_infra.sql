-- Managed Linux hosts.
CREATE TABLE nodes (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE,
    host                 TEXT NOT NULL,
    ssh_port             INTEGER NOT NULL DEFAULT 22,
    ssh_user             TEXT NOT NULL,
    ssh_key_id           TEXT NOT NULL REFERENCES ssh_keys(id),
    use_sudo             INTEGER NOT NULL DEFAULT 0,
    sudo_ready           INTEGER NOT NULL DEFAULT 0,
    selinux_mode         TEXT NOT NULL DEFAULT 'unknown',
    swap_enabled         INTEGER NOT NULL DEFAULT 0,
    os_family            TEXT NOT NULL DEFAULT '',
    os_codename          TEXT NOT NULL DEFAULT '',
    package_manager      TEXT NOT NULL DEFAULT '',
    docker_mode          TEXT NOT NULL DEFAULT 'absent',
    docker_status        TEXT NOT NULL DEFAULT 'absent',
    docker_version       TEXT NOT NULL DEFAULT '',
    docker_config_json   TEXT NOT NULL DEFAULT '{}',
    machine_id           TEXT UNIQUE,
    address_aliases_json TEXT NOT NULL DEFAULT '[]',
    time_sync            TEXT NOT NULL DEFAULT 'unknown',
    clock_skew_ms        INTEGER NOT NULL DEFAULT 0,
    host_key_fingerprint TEXT NOT NULL DEFAULT '',
    os_info              TEXT NOT NULL DEFAULT '',
    arch                 TEXT NOT NULL DEFAULT '',
    probe_json           TEXT NOT NULL DEFAULT '{}',
    status               TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at      TEXT,
    labels_json          TEXT NOT NULL DEFAULT '{}',
    notes                TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);
CREATE INDEX idx_nodes_ssh_key ON nodes(ssh_key_id);

-- Asynchronous operation tasks and their steps.
CREATE TABLE operation_tasks (
    id                   TEXT PRIMARY KEY,
    action               TEXT NOT NULL,
    target_type          TEXT NOT NULL DEFAULT '',
    target_id            TEXT NOT NULL DEFAULT '',
    lock_mode            TEXT NOT NULL DEFAULT 'exclusive' CHECK (lock_mode IN ('exclusive', 'shared', 'none')),
    remote_op_id         TEXT NOT NULL DEFAULT '',
    intent_json          TEXT NOT NULL DEFAULT '{}',
    status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'rolled_back',
                             'interrupted', 'needs_reconcile', 'cancelled')),
    params_redacted_json TEXT NOT NULL DEFAULT '{}',
    triggered_by         TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT,
    error_message        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_operation_tasks_status ON operation_tasks(status);
CREATE INDEX idx_operation_tasks_target ON operation_tasks(target_type, target_id);

CREATE TABLE operation_task_steps (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES operation_tasks(id) ON DELETE CASCADE,
    step_order    INTEGER NOT NULL,
    node_id       TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'interrupted', 'skipped')),
    log_path      TEXT NOT NULL DEFAULT '',
    remote_unit   TEXT NOT NULL DEFAULT '',
    exit_code     INTEGER,
    started_at    TEXT,
    finished_at   TEXT,
    error_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_operation_task_steps_task ON operation_task_steps(task_id, step_order);
