-- Cluster integrations (Nomad -> Vault workload identity) and their roles.
CREATE TABLE cluster_integrations (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    integration_type    TEXT NOT NULL,
    source_cluster_id   TEXT NOT NULL REFERENCES clusters(id),
    target_cluster_id   TEXT NOT NULL REFERENCES clusters(id),
    auth_path           TEXT NOT NULL,
    config_json         TEXT NOT NULL DEFAULT '{}',
    nomad_config_sha256 TEXT NOT NULL DEFAULT '',
    -- 1 once the Nomad side (60-vault.hcl, vault-ca.crt) is part of the
    -- source cluster's configuration generations.
    nomad_side_enabled  INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'applied', 'drifted', 'failed')),
    last_doctor_json    TEXT NOT NULL DEFAULT '{}',
    last_applied_at     TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (target_cluster_id, auth_path)
);
-- Nomad Community supports one vault block: one active Vault target per source.
CREATE UNIQUE INDEX idx_integrations_nomad_vault_source ON cluster_integrations(source_cluster_id)
    WHERE integration_type = 'nomad_vault_jwt';

CREATE TABLE integration_roles (
    id                TEXT PRIMARY KEY,
    integration_id    TEXT NOT NULL REFERENCES cluster_integrations(id) ON DELETE CASCADE,
    role_name         TEXT NOT NULL,
    policy_name       TEXT NOT NULL,
    policy_mode       TEXT NOT NULL CHECK (policy_mode IN ('explicit', 'templated')),
    secret_paths_json TEXT NOT NULL DEFAULT '[]',
    custom_policy_hcl TEXT NOT NULL DEFAULT '',
    bound_claims_json TEXT NOT NULL DEFAULT '{}',
    token_period      TEXT NOT NULL DEFAULT '1h',
    status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'applied', 'drifted', 'failed')),
    last_applied_at   TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (integration_id, role_name)
);
