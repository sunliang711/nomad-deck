-- Nomad / Vault clusters managed by the control plane.
CREATE TABLE clusters (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL UNIQUE,
    type                   TEXT NOT NULL CHECK (type IN ('nomad', 'vault', 'consul')),
    mode                   TEXT NOT NULL CHECK (mode IN ('single', 'cluster')),
    region                 TEXT NOT NULL DEFAULT '',
    datacenter             TEXT NOT NULL DEFAULT '',
    tls_enabled            INTEGER NOT NULL DEFAULT 1,
    tls_config_json        TEXT NOT NULL DEFAULT '{}',
    ca_cert_pem            TEXT NOT NULL DEFAULT '',
    ca_key_encrypted       TEXT NOT NULL DEFAULT '',
    ca_expires_at          TEXT,
    client_cert_pem        TEXT NOT NULL DEFAULT '',
    client_key_encrypted   TEXT NOT NULL DEFAULT '',
    client_cert_expires_at TEXT,
    gossip_key_encrypted   TEXT NOT NULL DEFAULT '',
    public_api_url         TEXT NOT NULL DEFAULT '',
    api_endpoints_json     TEXT NOT NULL DEFAULT '[]',
    admin_token_encrypted  TEXT NOT NULL DEFAULT '',
    init_state             TEXT NOT NULL DEFAULT 'uninitialized'
                           CHECK (init_state IN ('uninitialized', 'init_in_doubt', 'initialized')),
    maintenance_mode       INTEGER NOT NULL DEFAULT 0,
    maintenance_reason     TEXT NOT NULL DEFAULT '',
    config_json            TEXT NOT NULL DEFAULT '{}',
    health_status          TEXT NOT NULL DEFAULT 'unknown',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);

-- Cluster membership. A host belongs to at most one cluster per product.
CREATE TABLE cluster_nodes (
    id                 TEXT PRIMARY KEY,
    cluster_id         TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    cluster_type       TEXT NOT NULL,
    node_id            TEXT NOT NULL REFERENCES nodes(id),
    role               TEXT NOT NULL,
    advertise_addr     TEXT NOT NULL,
    api_addr           TEXT NOT NULL DEFAULT '',
    cluster_addr       TEXT NOT NULL DEFAULT '',
    install_state      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (install_state IN ('pending', 'installed', 'uninstalled', 'failed')),
    installed_version  TEXT NOT NULL DEFAULT '',
    kept_versions_json TEXT NOT NULL DEFAULT '[]',
    service_status     TEXT NOT NULL DEFAULT 'unknown',
    raft_role          TEXT NOT NULL DEFAULT 'none',
    is_voter           INTEGER NOT NULL DEFAULT 0,
    is_sealed          INTEGER,
    node_config_json   TEXT NOT NULL DEFAULT '{}',
    cert_expires_at    TEXT,
    last_synced_at     TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (cluster_id, node_id),
    UNIQUE (node_id, cluster_type)
);
CREATE INDEX idx_cluster_nodes_cluster ON cluster_nodes(cluster_id);

-- Vault custody: unseal keys are held per generation, tokens are encrypted.
CREATE TABLE vault_secrets_custody (
    cluster_id                     TEXT PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
    initialized                    INTEGER NOT NULL DEFAULT 0,
    key_shares                     INTEGER NOT NULL DEFAULT 5,
    key_threshold                  INTEGER NOT NULL DEFAULT 3,
    seal_generation                INTEGER NOT NULL DEFAULT 0,
    bootstrap_root_token_encrypted TEXT NOT NULL DEFAULT '',
    admin_token_encrypted          TEXT NOT NULL DEFAULT '',
    admin_token_expires_at         TEXT,
    auto_unseal_by_deck            INTEGER NOT NULL DEFAULT 1,
    unseal_suppressed_reason       TEXT NOT NULL DEFAULT '',
    initialized_at                 TEXT,
    last_unsealed_at               TEXT,
    updated_at                     TEXT NOT NULL
);

CREATE TABLE vault_unseal_key_generations (
    cluster_id               TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    generation               INTEGER NOT NULL,
    key_shares               INTEGER NOT NULL,
    key_threshold            INTEGER NOT NULL,
    unseal_keys_encrypted    TEXT NOT NULL,
    rekey_verification_nonce TEXT NOT NULL DEFAULT '',
    state                    TEXT NOT NULL CHECK (state IN
                             ('pending_verification', 'verification_in_doubt', 'active', 'retired', 'abandoned')),
    created_at               TEXT NOT NULL,
    activated_at             TEXT,
    retired_at               TEXT,
    PRIMARY KEY (cluster_id, generation)
);
CREATE UNIQUE INDEX idx_vault_gen_one_active ON vault_unseal_key_generations(cluster_id) WHERE state = 'active';

-- Encrypted Raft snapshots stored by the control plane.
CREATE TABLE cluster_snapshots (
    id                    TEXT PRIMARY KEY,
    cluster_id            TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    cluster_type          TEXT NOT NULL,
    product_version       TEXT NOT NULL DEFAULT '',
    seal_generation       INTEGER,
    credential_generation TEXT NOT NULL DEFAULT '',
    file_path             TEXT NOT NULL,
    size_bytes            INTEGER NOT NULL DEFAULT 0,
    sha256                TEXT NOT NULL,
    trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'uploaded', 'pre_upgrade')),
    triggered_by          TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL
);
CREATE INDEX idx_cluster_snapshots_cluster ON cluster_snapshots(cluster_id, created_at);
