-- Allow cloned VMs to share /etc/machine-id while keeping machine_id indexed.
CREATE TABLE nodes_new (
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
    machine_id           TEXT,
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
    updated_at           TEXT NOT NULL,
    cpu_cores            INTEGER NOT NULL DEFAULT 0,
    cpu_percent          REAL NOT NULL DEFAULT -1,
    mem_total_bytes      INTEGER NOT NULL DEFAULT 0,
    mem_used_bytes       INTEGER NOT NULL DEFAULT 0,
    mem_percent          REAL NOT NULL DEFAULT -1
);

INSERT INTO nodes_new (
    id, name, host, ssh_port, ssh_user, ssh_key_id, use_sudo, sudo_ready,
    selinux_mode, swap_enabled, os_family, os_codename, package_manager,
    docker_mode, docker_status, docker_version, docker_config_json, machine_id,
    address_aliases_json, time_sync, clock_skew_ms, host_key_fingerprint,
    os_info, arch, probe_json, status, last_checked_at, labels_json, notes,
    created_at, updated_at, cpu_cores, cpu_percent, mem_total_bytes,
    mem_used_bytes, mem_percent
)
SELECT
    id, name, host, ssh_port, ssh_user, ssh_key_id, use_sudo, sudo_ready,
    selinux_mode, swap_enabled, os_family, os_codename, package_manager,
    docker_mode, docker_status, docker_version, docker_config_json, machine_id,
    address_aliases_json, time_sync, clock_skew_ms, host_key_fingerprint,
    os_info, arch, probe_json, status, last_checked_at, labels_json, notes,
    created_at, updated_at, cpu_cores, cpu_percent, mem_total_bytes,
    mem_used_bytes, mem_percent
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;
CREATE INDEX idx_nodes_ssh_key ON nodes(ssh_key_id);
CREATE INDEX idx_nodes_machine_id ON nodes(machine_id);
