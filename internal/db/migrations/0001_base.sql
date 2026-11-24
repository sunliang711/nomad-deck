-- Accounts that can sign in to the management UI.
CREATE TABLE admins (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    is_disabled     INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    last_login_at   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Server-side sessions; only hashes of the cookie and CSRF tokens are stored.
CREATE TABLE admin_sessions (
    id              TEXT PRIMARY KEY,
    admin_id        TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    client_ip       TEXT NOT NULL DEFAULT '',
    user_agent      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    expires_at      TEXT NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

CREATE TABLE system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE ssh_keys (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL UNIQUE,
    algorithm             TEXT NOT NULL,
    public_key            TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,
    is_default            INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ssh_keys_single_default ON ssh_keys(is_default) WHERE is_default = 1;

CREATE TABLE audit_logs (
    id                   TEXT PRIMARY KEY,
    actor_id             TEXT NOT NULL DEFAULT '',
    actor_name           TEXT NOT NULL DEFAULT '',
    client_ip            TEXT NOT NULL DEFAULT '',
    action               TEXT NOT NULL,
    resource_type        TEXT NOT NULL DEFAULT '',
    resource_id          TEXT NOT NULL DEFAULT '',
    resource_name        TEXT NOT NULL DEFAULT '',
    request_summary_json TEXT NOT NULL DEFAULT '{}',
    operation_task_id    TEXT NOT NULL DEFAULT '',
    result               TEXT NOT NULL CHECK (result IN ('success', 'failed')),
    error_message        TEXT NOT NULL DEFAULT '',
    duration_ms          INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at);
