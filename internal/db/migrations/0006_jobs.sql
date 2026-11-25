-- Nomad job templates and the revision history of jobs submitted through
-- NomadDeck (source of truth for visual specs, HCL, variables and the exact
-- Job JSON sent to Nomad).
CREATE TABLE job_templates (
    id               TEXT PRIMARY KEY,
    cluster_id       TEXT REFERENCES clusters(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    job_id           TEXT NOT NULL DEFAULT '',
    namespace        TEXT NOT NULL DEFAULT 'default',
    edit_mode        TEXT NOT NULL CHECK (edit_mode IN ('visual', 'hcl')),
    renderer_version TEXT NOT NULL DEFAULT '',
    form_spec_json   TEXT,
    hcl_content      TEXT NOT NULL DEFAULT '',
    hcl_sha256       TEXT NOT NULL DEFAULT '',
    source_type      TEXT NOT NULL CHECK (source_type IN ('visual', 'hcl', 'compose', 'imported')),
    description      TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (name)
);

CREATE TABLE job_revisions (
    id                      TEXT PRIMARY KEY,
    cluster_id              TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    namespace               TEXT NOT NULL,
    job_id                  TEXT NOT NULL,
    revision_no             INTEGER NOT NULL,
    source                  TEXT NOT NULL CHECK (source IN ('workbench', 'scale', 'revert', 'stop_archive')),
    edit_mode               TEXT NOT NULL CHECK (edit_mode IN ('visual', 'hcl', 'json')),
    renderer_version        TEXT NOT NULL DEFAULT '',
    form_spec_json          TEXT,
    hcl_content             TEXT,
    hcl_sha256              TEXT NOT NULL DEFAULT '',
    variables_encrypted     TEXT NOT NULL DEFAULT '',
    job_json_encrypted      TEXT NOT NULL DEFAULT '',
    operation_id            TEXT NOT NULL DEFAULT '',
    base_job_modify_index   INTEGER NOT NULL DEFAULT 0,
    result_job_modify_index INTEGER NOT NULL DEFAULT 0,
    remote_job_version      INTEGER,
    eval_id                 TEXT NOT NULL DEFAULT '',
    submit_status           TEXT NOT NULL
                            CHECK (submit_status IN ('submitted', 'in_doubt', 'confirmed', 'failed', 'needs_review')),
    plan_summary            TEXT NOT NULL DEFAULT '',
    count_overridden_json   TEXT,
    submitted_by            TEXT NOT NULL DEFAULT '',
    created_at              TEXT NOT NULL,
    UNIQUE (cluster_id, namespace, job_id, revision_no)
);
CREATE INDEX idx_job_revisions_job ON job_revisions(cluster_id, namespace, job_id);
CREATE INDEX idx_job_revisions_status ON job_revisions(submit_status);
