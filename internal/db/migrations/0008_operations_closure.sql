-- Control-plane disaster-recovery backups and master-key rotation progress.

CREATE TABLE backup_runs (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('control_plane', 'raft_snapshot')),
    cluster_id    TEXT NOT NULL DEFAULT '',
    cluster_name  TEXT NOT NULL DEFAULT '',
    snapshot_id   TEXT NOT NULL DEFAULT '',
    trigger_type  TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
    triggered_by  TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    sha256        TEXT NOT NULL DEFAULT '',
    object_name   TEXT NOT NULL DEFAULT '',
    targets_json  TEXT NOT NULL DEFAULT '[]',
    error_message TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    finished_at   TEXT
);
CREATE INDEX idx_backup_runs_started ON backup_runs(started_at DESC);
CREATE INDEX idx_backup_runs_kind ON backup_runs(kind, started_at DESC);

CREATE TABLE key_rotation_journal (
    id            TEXT PRIMARY KEY,
    old_key_id    TEXT NOT NULL,
    new_key_id    TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('running', 'verifying', 'completed', 'failed')),
    progress_json TEXT NOT NULL DEFAULT '{}',
    started_by    TEXT NOT NULL DEFAULT '',
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    error_message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_key_rotation_started ON key_rotation_journal(started_at DESC);
