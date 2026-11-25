package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Node is a managed Linux host.
type Node struct {
	ID                 string
	Name               string
	Host               string
	SSHPort            int
	SSHUser            string
	SSHKeyID           string
	UseSudo            bool
	SudoReady          bool
	SELinuxMode        string
	SwapEnabled        bool
	OSFamily           string
	OSCodename         string
	PackageManager     string
	DockerMode         string
	DockerStatus       string
	DockerVersion      string
	DockerConfigJSON   string
	MachineID          string
	AddressAliasesJSON string
	TimeSync           string
	ClockSkewMS        int64
	HostKeyFingerprint string
	OSInfo             string
	Arch               string
	CPUCores           int
	CPUPercent         float64
	MemTotalBytes      int64
	MemUsedBytes       int64
	MemPercent         float64
	ProbeJSON          string
	Status             string
	LastCheckedAt      time.Time
	LabelsJSON         string
	Notes              string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

const nodeCols = `id, name, host, ssh_port, ssh_user, ssh_key_id, use_sudo, sudo_ready, selinux_mode, swap_enabled,
	os_family, os_codename, package_manager, docker_mode, docker_status, docker_version, docker_config_json,
	COALESCE(machine_id, ''), address_aliases_json, time_sync, clock_skew_ms, host_key_fingerprint, os_info, arch,
	cpu_cores, cpu_percent, mem_total_bytes, mem_used_bytes, mem_percent,
	probe_json, status, COALESCE(last_checked_at, ''), labels_json, notes, created_at, updated_at`

func scanNode(row interface{ Scan(...any) error }) (*Node, error) {
	var n Node
	var useSudo, sudoReady, swap int
	var checked, created, updated string
	err := row.Scan(&n.ID, &n.Name, &n.Host, &n.SSHPort, &n.SSHUser, &n.SSHKeyID, &useSudo, &sudoReady, &n.SELinuxMode, &swap,
		&n.OSFamily, &n.OSCodename, &n.PackageManager, &n.DockerMode, &n.DockerStatus, &n.DockerVersion, &n.DockerConfigJSON,
		&n.MachineID, &n.AddressAliasesJSON, &n.TimeSync, &n.ClockSkewMS, &n.HostKeyFingerprint, &n.OSInfo, &n.Arch,
		&n.CPUCores, &n.CPUPercent, &n.MemTotalBytes, &n.MemUsedBytes, &n.MemPercent,
		&n.ProbeJSON, &n.Status, &checked, &n.LabelsJSON, &n.Notes, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	n.UseSudo, n.SudoReady, n.SwapEnabled = useSudo != 0, sudoReady != 0, swap != 0
	n.LastCheckedAt, n.CreatedAt, n.UpdatedAt = ParseTime(checked), ParseTime(created), ParseTime(updated)
	return &n, nil
}

// InsertNode creates a host record.
func InsertNode(ctx context.Context, q Querier, n *Node) error {
	now := FormatTime(n.CreatedAt)
	_, err := q.ExecContext(ctx, `INSERT INTO nodes(id, name, host, ssh_port, ssh_user, ssh_key_id, use_sudo,
		labels_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.Name, n.Host, n.SSHPort, n.SSHUser, n.SSHKeyID, boolInt(n.UseSudo), orDefault(n.LabelsJSON, "{}"), n.Notes, now, now)
	return mapUnique(err)
}

// GetNode loads a host by ID.
func GetNode(ctx context.Context, q Querier, id string) (*Node, error) {
	return scanNode(q.QueryRowContext(ctx, `SELECT `+nodeCols+` FROM nodes WHERE id = ?`, id))
}

// GetNodeByMachineID loads a host by machine ID.
func GetNodeByMachineID(ctx context.Context, q Querier, machineID string) (*Node, error) {
	return scanNode(q.QueryRowContext(ctx, `SELECT `+nodeCols+` FROM nodes WHERE machine_id = ?`, machineID))
}

// ListNodes returns all hosts ordered by name.
func ListNodes(ctx context.Context, q Querier) ([]*Node, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+nodeCols+` FROM nodes ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Node
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// UpdateNodeConnection updates editable connection fields.
func UpdateNodeConnection(ctx context.Context, q Querier, n *Node, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE nodes SET name = ?, host = ?, ssh_port = ?, ssh_user = ?, ssh_key_id = ?,
		use_sudo = ?, labels_json = ?, notes = ?, updated_at = ? WHERE id = ?`,
		n.Name, n.Host, n.SSHPort, n.SSHUser, n.SSHKeyID, boolInt(n.UseSudo), orDefault(n.LabelsJSON, "{}"), n.Notes,
		FormatTime(now), n.ID)
	if err != nil {
		return mapUnique(err)
	}
	return affectedOne(res, nil)
}

// UpdateNodeHostKey stores (or clears) the trusted host key fingerprint.
func UpdateNodeHostKey(ctx context.Context, q Querier, id, fingerprint string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE nodes SET host_key_fingerprint = ?, updated_at = ? WHERE id = ?`, fingerprint, FormatTime(now), id)
	return affectedOne(res, err)
}

// UpdateNodeProbe stores probe results.
func UpdateNodeProbe(ctx context.Context, q Querier, n *Node, now time.Time) error {
	var mid any
	if n.MachineID != "" {
		mid = n.MachineID
	}
	res, err := q.ExecContext(ctx, `UPDATE nodes SET sudo_ready = ?, selinux_mode = ?, swap_enabled = ?, os_family = ?,
		os_codename = ?, package_manager = ?, docker_mode = ?, docker_status = ?, docker_version = ?, machine_id = ?,
		time_sync = ?, clock_skew_ms = ?, os_info = ?, arch = ?, cpu_cores = ?, cpu_percent = ?, mem_total_bytes = ?,
		mem_used_bytes = ?, mem_percent = ?, probe_json = ?, status = ?, last_checked_at = ?,
		updated_at = ? WHERE id = ?`,
		boolInt(n.SudoReady), n.SELinuxMode, boolInt(n.SwapEnabled), n.OSFamily, n.OSCodename, n.PackageManager,
		n.DockerMode, n.DockerStatus, n.DockerVersion, mid, n.TimeSync, n.ClockSkewMS, n.OSInfo, n.Arch,
		n.CPUCores, n.CPUPercent, n.MemTotalBytes, n.MemUsedBytes, n.MemPercent, n.ProbeJSON,
		n.Status, FormatTime(now), FormatTime(now), n.ID)
	if err != nil {
		return mapUnique(err)
	}
	return affectedOne(res, nil)
}

// UpdateNodeStatus records reachability.
func UpdateNodeStatus(ctx context.Context, q Querier, id, status string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE nodes SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
		status, FormatTime(now), FormatTime(now), id)
	return err
}

// UpdateNodeMetrics records reachability and latest CPU/memory utilization.
func UpdateNodeMetrics(ctx context.Context, q Querier, id, status string, cpuCores int, cpuPct float64, memTotal, memUsed int64, memPct float64, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE nodes SET status = ?, cpu_cores = ?, cpu_percent = ?, mem_total_bytes = ?, mem_used_bytes = ?, mem_percent = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
		status, cpuCores, cpuPct, memTotal, memUsed, memPct, FormatTime(now), FormatTime(now), id)
	return err
}

// UpdateNodeAliases replaces the address alias list.
func UpdateNodeAliases(ctx context.Context, q Querier, id, aliasesJSON string, now time.Time) error {
	res, err := q.ExecContext(ctx, `UPDATE nodes SET address_aliases_json = ?, updated_at = ? WHERE id = ?`, aliasesJSON, FormatTime(now), id)
	return affectedOne(res, err)
}

// DeleteNode removes a host record.
func DeleteNode(ctx context.Context, q Querier, id string) error {
	res, err := q.ExecContext(ctx, `DELETE FROM nodes WHERE id = ?`, id)
	return affectedOne(res, err)
}

// CountNodesUsingKey returns hosts referencing an SSH key.
func CountNodesUsingKey(ctx context.Context, q Querier, keyID string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM nodes WHERE ssh_key_id = ?`, keyID).Scan(&n)
	return n, err
}

// ErrUnique is returned when a UNIQUE constraint fails.
var ErrUnique = errors.New("unique constraint violated")

func mapUnique(err error) error {
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return errors.Join(ErrUnique, err)
	}
	return err
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// UpdateNodeDocker stores the Docker Engine state and host-level settings.
func UpdateNodeDocker(ctx context.Context, q Querier, id, mode, status, version, configJSON string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE nodes SET docker_mode = ?, docker_status = ?, docker_version = ?, docker_config_json = ?,
		updated_at = ? WHERE id = ?`, mode, status, version, orDefault(configJSON, "{}"), FormatTime(now), id)
	return err
}

// NomadClusterOfNode returns the Nomad cluster a host belongs to ("" if none).
func NomadClusterOfNode(ctx context.Context, q Querier, nodeID string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT cluster_id FROM cluster_nodes WHERE node_id = ? AND cluster_type = 'nomad'`, nodeID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}
