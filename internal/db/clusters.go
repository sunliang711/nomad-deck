package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Cluster init states.
const (
	InitUninitialized = "uninitialized"
	InitInDoubt       = "init_in_doubt"
	InitInitialized   = "initialized"
)

// Cluster is a managed Nomad or Vault cluster.
type Cluster struct {
	ID                  string
	Name                string
	Type                string
	Mode                string
	Region              string
	Datacenter          string
	TLSEnabled          bool
	TLSConfigJSON       string
	CACertPEM           string
	CAKeyEncrypted      string
	CAExpiresAt         time.Time
	ClientCertPEM       string
	ClientKeyEncrypted  string
	ClientCertExpiresAt time.Time
	GossipKeyEncrypted  string
	PublicAPIURL        string
	APIEndpointsJSON    string
	AdminTokenEncrypted string
	InitState           string
	MaintenanceMode     bool
	MaintenanceReason   string
	ConfigJSON          string
	HealthStatus        string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// AAD helpers bind ciphertexts to their storage location.
func ClusterCAKeyAAD(id string) string     { return "clusters.ca_key_encrypted:" + id }
func ClusterClientKeyAAD(id string) string { return "clusters.client_key_encrypted:" + id }
func ClusterGossipKeyAAD(id string) string { return "clusters.gossip_key_encrypted:" + id }
func ClusterGossipPendingAAD(id string) string {
	return "clusters.gossip_key_pending_encrypted:" + id
}
func ClusterAdminTokenAAD(id string) string { return "clusters.admin_token_encrypted:" + id }
func VaultRootTokenAAD(id string) string {
	return "vault_secrets_custody.bootstrap_root_token_encrypted:" + id
}
func VaultAdminTokenAAD(id string) string { return "vault_secrets_custody.admin_token_encrypted:" + id }
func VaultUnsealKeysAAD(id string, gen int) string {
	return "vault_unseal_key_generations.unseal_keys_encrypted:" + id + ":" + itoa(gen)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func init() {
	EncryptedFields = append(EncryptedFields,
		EncryptedField{Name: "clusters.ca_key_encrypted", Query: `SELECT id, ca_key_encrypted FROM clusters WHERE ca_key_encrypted != ''`},
		EncryptedField{Name: "clusters.client_key_encrypted", Query: `SELECT id, client_key_encrypted FROM clusters WHERE client_key_encrypted != ''`},
		EncryptedField{Name: "clusters.gossip_key_encrypted", Query: `SELECT id, gossip_key_encrypted FROM clusters WHERE gossip_key_encrypted != ''`},
		EncryptedField{Name: "clusters.gossip_key_pending_encrypted", Query: `SELECT id, gossip_key_pending_encrypted FROM clusters WHERE gossip_key_pending_encrypted != ''`},
		EncryptedField{Name: "clusters.admin_token_encrypted", Query: `SELECT id, admin_token_encrypted FROM clusters WHERE admin_token_encrypted != ''`},
		EncryptedField{Name: "vault_secrets_custody.bootstrap_root_token_encrypted",
			Query: `SELECT cluster_id, bootstrap_root_token_encrypted FROM vault_secrets_custody WHERE bootstrap_root_token_encrypted != ''`},
		EncryptedField{Name: "vault_secrets_custody.admin_token_encrypted",
			Query: `SELECT cluster_id, admin_token_encrypted FROM vault_secrets_custody WHERE admin_token_encrypted != ''`},
		EncryptedField{Name: "vault_unseal_key_generations.unseal_keys_encrypted",
			Query: `SELECT cluster_id || ':' || generation, unseal_keys_encrypted FROM vault_unseal_key_generations`},
	)
}

const clusterCols = `id, name, type, mode, region, datacenter, tls_enabled, tls_config_json, ca_cert_pem, ca_key_encrypted,
	COALESCE(ca_expires_at, ''), client_cert_pem, client_key_encrypted, COALESCE(client_cert_expires_at, ''), gossip_key_encrypted,
	public_api_url, api_endpoints_json, admin_token_encrypted, init_state, maintenance_mode, maintenance_reason, config_json,
	health_status, created_at, updated_at`

func scanCluster(row interface{ Scan(...any) error }) (*Cluster, error) {
	var c Cluster
	var tls, maint int
	var caExp, clientExp, created, updated string
	err := row.Scan(&c.ID, &c.Name, &c.Type, &c.Mode, &c.Region, &c.Datacenter, &tls, &c.TLSConfigJSON, &c.CACertPEM,
		&c.CAKeyEncrypted, &caExp, &c.ClientCertPEM, &c.ClientKeyEncrypted, &clientExp, &c.GossipKeyEncrypted,
		&c.PublicAPIURL, &c.APIEndpointsJSON, &c.AdminTokenEncrypted, &c.InitState, &maint, &c.MaintenanceReason,
		&c.ConfigJSON, &c.HealthStatus, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.TLSEnabled, c.MaintenanceMode = tls == 1, maint == 1
	c.CAExpiresAt, c.ClientCertExpiresAt = ParseTime(caExp), ParseTime(clientExp)
	c.CreatedAt, c.UpdatedAt = ParseTime(created), ParseTime(updated)
	return &c, nil
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return FormatTime(t)
}

// InsertCluster stores a new cluster.
func InsertCluster(ctx context.Context, q Querier, c *Cluster) error {
	_, err := q.ExecContext(ctx, `INSERT INTO clusters (id, name, type, mode, region, datacenter, tls_enabled, tls_config_json,
		ca_cert_pem, ca_key_encrypted, ca_expires_at, client_cert_pem, client_key_encrypted, client_cert_expires_at,
		gossip_key_encrypted, public_api_url, api_endpoints_json, admin_token_encrypted, init_state, maintenance_mode,
		maintenance_reason, config_json, health_status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.Name, c.Type, c.Mode, c.Region, c.Datacenter, boolInt(c.TLSEnabled), orJSON(c.TLSConfigJSON, "{}"),
		c.CACertPEM, c.CAKeyEncrypted, nullTime(c.CAExpiresAt), c.ClientCertPEM, c.ClientKeyEncrypted,
		nullTime(c.ClientCertExpiresAt), c.GossipKeyEncrypted, c.PublicAPIURL, orJSON(c.APIEndpointsJSON, "[]"),
		c.AdminTokenEncrypted, orStr(c.InitState, InitUninitialized), boolInt(c.MaintenanceMode), c.MaintenanceReason,
		orJSON(c.ConfigJSON, "{}"), orStr(c.HealthStatus, "unknown"), FormatTime(c.CreatedAt), FormatTime(c.UpdatedAt))
	return mapUnique(err)
}

// GetCluster loads a cluster by ID.
func GetCluster(ctx context.Context, q Querier, id string) (*Cluster, error) {
	return scanCluster(q.QueryRowContext(ctx, `SELECT `+clusterCols+` FROM clusters WHERE id = ?`, id))
}

// ListClusters lists clusters, optionally of one type.
func ListClusters(ctx context.Context, q Querier, typ string) ([]*Cluster, error) {
	query := `SELECT ` + clusterCols + ` FROM clusters`
	var args []any
	if typ != "" {
		query += ` WHERE type = ?`
		args = append(args, typ)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Cluster
	for rows.Next() {
		c, err := scanCluster(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateClusterTLS stores CA and client certificate material.
func UpdateClusterTLS(ctx context.Context, q Querier, c *Cluster, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET ca_cert_pem = ?, ca_key_encrypted = ?, ca_expires_at = ?,
		client_cert_pem = ?, client_key_encrypted = ?, client_cert_expires_at = ?, updated_at = ? WHERE id = ?`,
		c.CACertPEM, c.CAKeyEncrypted, nullTime(c.CAExpiresAt), c.ClientCertPEM, c.ClientKeyEncrypted,
		nullTime(c.ClientCertExpiresAt), FormatTime(now), c.ID)
	return err
}

// UpdateClusterSettings stores editable cluster settings.
func UpdateClusterSettings(ctx context.Context, q Querier, c *Cluster, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET name = ?, public_api_url = ?, api_endpoints_json = ?, config_json = ?,
		tls_config_json = ?, updated_at = ? WHERE id = ?`,
		c.Name, c.PublicAPIURL, orJSON(c.APIEndpointsJSON, "[]"), orJSON(c.ConfigJSON, "{}"), orJSON(c.TLSConfigJSON, "{}"),
		FormatTime(now), c.ID)
	return mapUnique(err)
}

// SetClusterInitState updates the init state.
func SetClusterInitState(ctx context.Context, q Querier, id, state string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET init_state = ?, updated_at = ? WHERE id = ?`, state, FormatTime(now), id)
	return err
}

// SetClusterMaintenance toggles maintenance mode.
func SetClusterMaintenance(ctx context.Context, q Querier, id string, on bool, reason string, now time.Time) error {
	if !on {
		reason = ""
	}
	_, err := q.ExecContext(ctx, `UPDATE clusters SET maintenance_mode = ?, maintenance_reason = ?, updated_at = ? WHERE id = ?`,
		boolInt(on), reason, FormatTime(now), id)
	return err
}

// SetClusterHealth records the aggregated health status.
func SetClusterHealth(ctx context.Context, q Querier, id, status string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET health_status = ?, updated_at = ? WHERE id = ?`, status, FormatTime(now), id)
	return err
}

// DeleteCluster removes a cluster (memberships, custody and snapshots cascade).
func DeleteCluster(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM clusters WHERE id = ?`, id)
	return err
}

// ClusterNode is one cluster membership.
type ClusterNode struct {
	ID               string
	ClusterID        string
	ClusterType      string
	NodeID           string
	Role             string
	AdvertiseAddr    string
	APIAddr          string
	ClusterAddr      string
	InstallState     string
	InstalledVersion string
	KeptVersionsJSON string
	ServiceStatus    string
	RaftRole         string
	IsVoter          bool
	IsSealed         *bool
	NodeConfigJSON   string
	CertExpiresAt    time.Time
	LastSyncedAt     time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
	// Joined from nodes.
	NodeName string
	NodeHost string
}

const clusterNodeCols = `cn.id, cn.cluster_id, cn.cluster_type, cn.node_id, cn.role, cn.advertise_addr, cn.api_addr, cn.cluster_addr,
	cn.install_state, cn.installed_version, cn.kept_versions_json, cn.service_status, cn.raft_role, cn.is_voter, cn.is_sealed,
	cn.node_config_json, COALESCE(cn.cert_expires_at, ''), COALESCE(cn.last_synced_at, ''), cn.created_at, cn.updated_at,
	n.name, n.host`

func scanClusterNode(row interface{ Scan(...any) error }) (*ClusterNode, error) {
	var m ClusterNode
	var voter int
	var sealed sql.NullInt64
	var certExp, synced, created, updated string
	err := row.Scan(&m.ID, &m.ClusterID, &m.ClusterType, &m.NodeID, &m.Role, &m.AdvertiseAddr, &m.APIAddr, &m.ClusterAddr,
		&m.InstallState, &m.InstalledVersion, &m.KeptVersionsJSON, &m.ServiceStatus, &m.RaftRole, &voter, &sealed,
		&m.NodeConfigJSON, &certExp, &synced, &created, &updated, &m.NodeName, &m.NodeHost)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.IsVoter = voter == 1
	if sealed.Valid {
		v := sealed.Int64 == 1
		m.IsSealed = &v
	}
	m.CertExpiresAt, m.LastSyncedAt = ParseTime(certExp), ParseTime(synced)
	m.CreatedAt, m.UpdatedAt = ParseTime(created), ParseTime(updated)
	return &m, nil
}

// InsertClusterNode adds a membership.
func InsertClusterNode(ctx context.Context, q Querier, m *ClusterNode) error {
	_, err := q.ExecContext(ctx, `INSERT INTO cluster_nodes (id, cluster_id, cluster_type, node_id, role, advertise_addr, api_addr,
		cluster_addr, install_state, installed_version, kept_versions_json, service_status, raft_role, is_voter, node_config_json,
		created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.ClusterID, m.ClusterType, m.NodeID, m.Role, m.AdvertiseAddr, m.APIAddr, m.ClusterAddr,
		orStr(m.InstallState, "pending"), m.InstalledVersion, orJSON(m.KeptVersionsJSON, "[]"), orStr(m.ServiceStatus, "unknown"),
		orStr(m.RaftRole, "none"), boolInt(m.IsVoter), orJSON(m.NodeConfigJSON, "{}"), FormatTime(m.CreatedAt), FormatTime(m.UpdatedAt))
	return mapUnique(err)
}

// ListClusterNodes lists the members of a cluster ordered by creation.
func ListClusterNodes(ctx context.Context, q Querier, clusterID string) ([]*ClusterNode, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+clusterNodeCols+` FROM cluster_nodes cn JOIN nodes n ON n.id = cn.node_id
		WHERE cn.cluster_id = ? ORDER BY cn.created_at, cn.id`, clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ClusterNode
	for rows.Next() {
		m, err := scanClusterNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetClusterNode loads one membership by cluster and host.
func GetClusterNode(ctx context.Context, q Querier, clusterID, nodeID string) (*ClusterNode, error) {
	return scanClusterNode(q.QueryRowContext(ctx, `SELECT `+clusterNodeCols+` FROM cluster_nodes cn JOIN nodes n ON n.id = cn.node_id
		WHERE cn.cluster_id = ? AND cn.node_id = ?`, clusterID, nodeID))
}

// CountMembershipsOfNode counts the clusters a host belongs to.
func CountMembershipsOfNode(ctx context.Context, q Querier, nodeID string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM cluster_nodes WHERE node_id = ?`, nodeID).Scan(&n)
	return n, err
}

// UpdateClusterNodeState stores runtime state reported by the product API.
func UpdateClusterNodeState(ctx context.Context, q Querier, m *ClusterNode, now time.Time) error {
	var sealed any
	if m.IsSealed != nil {
		sealed = boolInt(*m.IsSealed)
	}
	_, err := q.ExecContext(ctx, `UPDATE cluster_nodes SET service_status = ?, raft_role = ?, is_voter = ?, is_sealed = ?,
		last_synced_at = ?, updated_at = ? WHERE id = ?`,
		m.ServiceStatus, m.RaftRole, boolInt(m.IsVoter), sealed, FormatTime(now), FormatTime(now), m.ID)
	return err
}

// UpdateClusterNodeInstall stores install results.
func UpdateClusterNodeInstall(ctx context.Context, q Querier, m *ClusterNode, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cluster_nodes SET install_state = ?, installed_version = ?, kept_versions_json = ?,
		node_config_json = ?, cert_expires_at = ?, updated_at = ? WHERE id = ?`,
		m.InstallState, m.InstalledVersion, orJSON(m.KeptVersionsJSON, "[]"), orJSON(m.NodeConfigJSON, "{}"),
		nullTime(m.CertExpiresAt), FormatTime(now), m.ID)
	return err
}

// DeleteClusterNode removes a membership.
func DeleteClusterNode(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM cluster_nodes WHERE id = ?`, id)
	return err
}

func orStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func orJSON(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// SetClusterAdminToken stores the encrypted management token together with
// the init state (one statement, so the secret is never persisted without
// the state that says it may be in use).
func SetClusterAdminToken(ctx context.Context, q Querier, id, enc, state string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET admin_token_encrypted = ?, init_state = ?, updated_at = ? WHERE id = ?`,
		enc, state, FormatTime(now), id)
	return err
}

// SetClusterGossipKeys stores the encrypted active and pending gossip keys.
func SetClusterGossipKeys(ctx context.Context, q Querier, id, active, pending string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE clusters SET gossip_key_encrypted = ?, gossip_key_pending_encrypted = ?, updated_at = ? WHERE id = ?`,
		active, pending, FormatTime(now), id)
	return err
}

// GetClusterGossipPending returns the encrypted pending gossip key.
func GetClusterGossipPending(ctx context.Context, q Querier, id string) (string, error) {
	var v string
	err := q.QueryRowContext(ctx, `SELECT gossip_key_pending_encrypted FROM clusters WHERE id = ?`, id).Scan(&v)
	return v, err
}
