package vault

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
)

// AdminPolicyName is the policy of the control plane's admin token.
const AdminPolicyName = "nomad-deck-admin"

// AdminPolicy grants the control plane what it needs for day-to-day
// operations: system backend, auth methods, identity and the secrets
// engines it manages for administrators.
const AdminPolicy = `# Managed by NomadDeck
path "sys/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
path "auth/*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
path "identity/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "+/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
`

// AuditDeviceName is the file audit device enabled at init.
const AuditDeviceName = "nomad-deck-file"

// Service orchestrates Vault clusters.
type Service struct {
	DB       *db.DB
	Keys     *crypto.Keyring
	Audit    *audit.Recorder
	Hosts    *hosts.Service
	Ops      *ops.Engine
	Releases *release.Provider
	Proxy    *netx.Manager
	DataDir  string
	Log      *slog.Logger
	// Timeouts (overridable in tests).
	APITimeout  time.Duration
	PollEvery   time.Duration
	JoinTimeout time.Duration
	// Test seams: RestartNode replaces the SSH service restart used to seal
	// a standby; AuditPath overrides the audit log location.
	RestartNode func(ctx context.Context, m *db.ClusterNode) error
	AuditPath   string
}

// Settings stored in clusters.config_json for Vault clusters.
type Settings struct {
	APIPort           int    `json:"api_port"`
	ClusterPort       int    `json:"cluster_port"`
	AllowInsecureHTTP bool   `json:"allow_insecure_http"`
	TokenPeriod       string `json:"token_period"`
	AuditMaxMB        int    `json:"audit_log_max_mb"`
	AuditKeep         int    `json:"audit_log_keep"`
	Version           string `json:"version,omitempty"`
}

func (s *Settings) defaults() {
	if s.APIPort == 0 {
		s.APIPort = 8200
	}
	if s.ClusterPort == 0 {
		s.ClusterPort = 8201
	}
	if s.TokenPeriod == "" {
		s.TokenPeriod = "168h"
	}
	if s.AuditMaxMB == 0 {
		s.AuditMaxMB = 100
	}
	if s.AuditKeep == 0 {
		s.AuditKeep = 10
	}
}

// MemberConfig is stored in cluster_nodes.node_config_json.
type MemberConfig struct {
	RaftNodeID       string   `json:"raft_node_id"`
	ConfigGeneration int      `json:"config_generation"`
	ExtraSANs        []string `json:"extra_sans,omitempty"`
}

// Error helpers share the auth error type (HTTP status + code).
func badRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}

func conflict(code, format string, args ...any) error {
	return &auth.Error{Status: 409, Code: code, Message: fmt.Sprintf(format, args...)}
}

var errNotFound = &auth.Error{Status: 404, Code: "not_found", Message: "集群不存在"}

var reClusterName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

func (s *Service) apiTimeout() time.Duration {
	if s.APITimeout > 0 {
		return s.APITimeout
	}
	return 20 * time.Second
}

func (s *Service) poll() time.Duration {
	if s.PollEvery > 0 {
		return s.PollEvery
	}
	return 2 * time.Second
}

func (s *Service) joinTimeout() time.Duration {
	if s.JoinTimeout > 0 {
		return s.JoinTimeout
	}
	return 3 * time.Minute
}

// cluster bundles a cluster with its parsed settings.
type cluster struct {
	*db.Cluster
	Settings Settings
}

func (s *Service) loadCluster(ctx context.Context, q db.Querier, id string) (*cluster, error) {
	c, err := db.GetCluster(ctx, q, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if c.Type != "vault" {
		return nil, badRequest("集群 %s 不是 Vault 集群", c.Name)
	}
	cl := &cluster{Cluster: c}
	_ = json.Unmarshal([]byte(c.ConfigJSON), &cl.Settings)
	cl.Settings.defaults()
	return cl, nil
}

func memberConfig(m *db.ClusterNode) MemberConfig {
	var mc MemberConfig
	_ = json.Unmarshal([]byte(m.NodeConfigJSON), &mc)
	return mc
}

func setMemberConfig(m *db.ClusterNode, mc MemberConfig) {
	b, _ := json.Marshal(mc)
	m.NodeConfigJSON = string(b)
}

// ---- Create ----

// MemberInput adds a host to a cluster.
type MemberInput struct {
	NodeID        string `json:"node_id"`
	AdvertiseAddr string `json:"advertise_addr"`
}

// CreateInput creates a Vault cluster.
type CreateInput struct {
	Name              string        `json:"name"`
	Mode              string        `json:"mode"`
	PublicAPIURL      string        `json:"public_api_url"`
	AllowInsecureHTTP bool          `json:"allow_insecure_http"`
	APIPort           int           `json:"api_port"`
	ClusterPort       int           `json:"cluster_port"`
	KeyShares         int           `json:"key_shares"`
	KeyThreshold      int           `json:"key_threshold"`
	Nodes             []MemberInput `json:"nodes"`
}

func validPort(p int) bool { return p == 0 || (p > 0 && p < 65536) }

func validAddr(a string) bool {
	if ip := net.ParseIP(strings.Trim(a, "[]")); ip != nil {
		return true
	}
	return regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`).MatchString(a)
}

func validateShares(shares, threshold int) error {
	if shares < 1 || shares > 10 || threshold < 1 || threshold > shares {
		return badRequest("密钥分片数需为 1～10，阈值需在 1 与分片数之间")
	}
	if shares > 1 && threshold < 2 {
		return badRequest("分片数大于 1 时阈值至少为 2")
	}
	return nil
}

// CreateCluster registers a Vault cluster, its members and its CA.
func (s *Service) CreateCluster(ctx context.Context, actor audit.Actor, in CreateInput) (*db.Cluster, error) {
	if !reClusterName.MatchString(in.Name) {
		return nil, badRequest("集群名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	if in.KeyShares == 0 {
		in.KeyShares, in.KeyThreshold = 5, 3
	}
	if err := validateShares(in.KeyShares, in.KeyThreshold); err != nil {
		return nil, err
	}
	switch in.Mode {
	case "single":
		if len(in.Nodes) != 1 {
			return nil, badRequest("单机模式需要且只能选择 1 台主机")
		}
	case "cluster":
		if len(in.Nodes) < 3 {
			return nil, badRequest("集群模式至少需要 3 台主机（推荐 3 或 5 台）")
		}
	default:
		return nil, badRequest("mode 需为 single 或 cluster")
	}
	if !validPort(in.APIPort) || !validPort(in.ClusterPort) {
		return nil, badRequest("端口不合法")
	}
	if in.PublicAPIURL != "" {
		u, err := url.Parse(in.PublicAPIURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, badRequest("public_api_url 需为 http(s) 地址")
		}
	}
	st := Settings{APIPort: in.APIPort, ClusterPort: in.ClusterPort, AllowInsecureHTTP: in.AllowInsecureHTTP}
	st.defaults()
	cfg, _ := json.Marshal(st)
	now := s.DB.Now()
	c := &db.Cluster{ID: db.NewID(), Name: in.Name, Type: "vault", Mode: in.Mode, TLSEnabled: !in.AllowInsecureHTTP,
		PublicAPIURL: strings.TrimRight(in.PublicAPIURL, "/"), ConfigJSON: string(cfg), InitState: db.InitUninitialized,
		HealthStatus: "unknown", CreatedAt: now, UpdatedAt: now}
	if c.TLSEnabled {
		ca, err := pki.NewCA("NomadDeck Vault CA "+in.Name, pki.CATTL, now)
		if err != nil {
			return nil, err
		}
		enc, err := s.Keys.EncryptString(ca.KeyPEM, db.ClusterCAKeyAAD(c.ID))
		if err != nil {
			return nil, err
		}
		c.CACertPEM, c.CAKeyEncrypted, c.CAExpiresAt = ca.CertPEM, enc, ca.NotAfter
	}
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			if errors.Is(err, db.ErrUnique) {
				return conflict("name_taken", "集群名称已存在")
			}
			return err
		}
		if err := db.InsertCustody(ctx, tx, &db.VaultCustody{ClusterID: c.ID, KeyShares: in.KeyShares, KeyThreshold: in.KeyThreshold,
			AutoUnsealByDeck: c.TLSEnabled, UpdatedAt: now}); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, mi := range in.Nodes {
			if seen[mi.NodeID] {
				return badRequest("主机重复")
			}
			seen[mi.NodeID] = true
			if _, err := s.insertMember(ctx, tx, c, st, mi, now); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "cluster.create", ResourceType: "cluster",
			ResourceID: c.ID, ResourceName: c.Name, Summary: map[string]any{"type": "vault", "mode": in.Mode,
				"nodes": len(in.Nodes), "tls": c.TLSEnabled, "key_shares": in.KeyShares, "key_threshold": in.KeyThreshold}})
	})
	if err != nil {
		return nil, err
	}
	return db.GetCluster(ctx, s.DB.Reader, c.ID)
}

func (s *Service) insertMember(ctx context.Context, tx *sql.Tx, c *db.Cluster, st Settings, mi MemberInput, now time.Time) (*db.ClusterNode, error) {
	n, err := db.GetNode(ctx, tx, mi.NodeID)
	if errors.Is(err, db.ErrNotFound) {
		return nil, badRequest("主机 %s 不存在", mi.NodeID)
	}
	if err != nil {
		return nil, err
	}
	adv := strings.TrimSpace(mi.AdvertiseAddr)
	if adv == "" {
		adv = n.Host
	}
	if !validAddr(adv) {
		return nil, badRequest("主机 %s 的通信地址不合法", n.Name)
	}
	m := &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "vault", NodeID: n.ID, Role: "raft_node",
		AdvertiseAddr: adv, APIAddr: APIAddr(adv, st.APIPort, c.TLSEnabled), ClusterAddr: ClusterAddr(adv, st.ClusterPort, c.TLSEnabled),
		CreatedAt: now, UpdatedAt: now}
	setMemberConfig(m, MemberConfig{RaftNodeID: raftNodeID(n.Name)})
	if err := db.InsertClusterNode(ctx, tx, m); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("node_in_cluster", "主机 %s 已属于另一个 Vault 集群", n.Name)
		}
		return nil, err
	}
	return m, nil
}

func raftNodeID(name string) string {
	return regexp.MustCompile(`[^A-Za-z0-9_-]`).ReplaceAllString(name, "-")
}

// AddMembers adds hosts to a cluster that has not been deployed yet.
func (s *Service) AddMembers(ctx context.Context, actor audit.Actor, clusterID string, in []MemberInput) error {
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cl, err := s.loadCluster(ctx, tx, clusterID)
		if err != nil {
			return err
		}
		if cl.InitState != db.InitUninitialized {
			return conflict("cluster_initialized", "集群已初始化，请使用扩容（Join）新增节点")
		}
		now := s.DB.Now()
		for _, mi := range in {
			if _, err := s.insertMember(ctx, tx, cl.Cluster, cl.Settings, mi, now); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "cluster.add_nodes", ResourceType: "cluster",
			ResourceID: cl.ID, ResourceName: cl.Name, Summary: map[string]any{"nodes": len(in)}})
	})
}

// ---- Clients and credentials ----

func (s *Service) client(cl *cluster, m *db.ClusterNode, token string) (*Client, error) {
	return NewClient(m.APIAddr, cl.CACertPEM, token, s.apiTimeout())
}

func (s *Service) adminToken(ctx context.Context, clusterID string) (string, error) {
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return "", err
	}
	if cu.AdminTokenEncrypted == "" {
		return "", conflict("no_admin_token", "集群尚无托管的运维 Token")
	}
	return s.Keys.DecryptString(cu.AdminTokenEncrypted, db.VaultAdminTokenAAD(clusterID))
}

// keysOf decrypts the unseal keys of a generation.
func (s *Service) keysOf(ctx context.Context, q db.Querier, clusterID string, gen int) ([]string, *db.KeyGeneration, error) {
	g, err := db.GetKeyGeneration(ctx, q, clusterID, gen)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil, conflict("no_key_generation", "找不到第 %d 代 Unseal Key", gen)
	}
	if err != nil {
		return nil, nil, err
	}
	raw, err := s.Keys.Decrypt(g.UnsealKeysEncrypted, db.VaultUnsealKeysAAD(clusterID, gen))
	if err != nil {
		return nil, nil, err
	}
	var keys []string
	if err := json.Unmarshal(raw, &keys); err != nil {
		return nil, nil, err
	}
	return keys, g, nil
}

func (s *Service) encryptKeys(clusterID string, gen int, keys []string) (string, error) {
	b, _ := json.Marshal(keys)
	return s.Keys.Encrypt(b, db.VaultUnsealKeysAAD(clusterID, gen))
}

// activeKeys returns the keys of the active generation.
func (s *Service) activeKeys(ctx context.Context, clusterID string) ([]string, int, error) {
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, 0, err
	}
	if cu.SealGeneration == 0 {
		return nil, 0, conflict("not_initialized", "集群尚未初始化，没有托管的 Unseal Key")
	}
	keys, _, err := s.keysOf(ctx, s.DB.Reader, clusterID, cu.SealGeneration)
	return keys, cu.SealGeneration, err
}

// activeMember finds the active (leader) node among members.
func (s *Service) activeMember(ctx context.Context, cl *cluster, members []*db.ClusterNode) (*db.ClusterNode, error) {
	for _, m := range members {
		if m.InstallState != "installed" {
			continue
		}
		c, err := s.client(cl, m, "")
		if err != nil {
			continue
		}
		h, err := c.Health(ctx)
		if err == nil && h.Initialized && !h.Sealed && !h.Standby && h.HTTPStatus == 200 {
			return m, nil
		}
	}
	return nil, conflict("no_active_node", "没有找到处于 Active 状态的 Vault 节点")
}

// adminClient returns a client for the active node with the admin token.
func (s *Service) adminClient(ctx context.Context, cl *cluster) (*Client, *db.ClusterNode, error) {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, nil, err
	}
	m, err := s.activeMember(ctx, cl, members)
	if err != nil {
		return nil, nil, err
	}
	tok, err := s.adminToken(ctx, cl.ID)
	if err != nil {
		return nil, nil, err
	}
	c, err := s.client(cl, m, tok)
	return c, m, err
}

// ---- Status ----

// NodeStatus is the live state of one member.
type NodeStatus struct {
	NodeID     string `json:"node_id"`
	Name       string `json:"name"`
	APIAddr    string `json:"api_addr"`
	Reachable  bool   `json:"reachable"`
	Init       bool   `json:"initialized"`
	Sealed     bool   `json:"sealed"`
	Role       string `json:"raft_role"`
	Voter      bool   `json:"is_voter"`
	Version    string `json:"version"`
	Enterprise bool   `json:"enterprise"`
	Error      string `json:"error,omitempty"`
}

// SyncStatus probes every member, stores node and cluster state and
// returns the live view.
func (s *Service) SyncStatus(ctx context.Context, clusterID string) ([]NodeStatus, string, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, "", err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, "", err
	}
	var voters map[string]bool
	if tok, err := s.adminToken(ctx, cl.ID); err == nil {
		if am, err := s.activeMember(ctx, cl, members); err == nil {
			if c, err := s.client(cl, am, tok); err == nil {
				if cfg, err := c.RaftConfiguration(ctx); err == nil {
					voters = map[string]bool{}
					for _, sv := range cfg {
						voters[sv.NodeID] = sv.Voter
					}
				}
			}
		}
	}
	now := s.DB.Now()
	out := make([]NodeStatus, len(members))
	reachable, sealed, active, uninit := 0, 0, 0, 0
	for i, m := range members {
		ns := NodeStatus{NodeID: m.NodeID, Name: m.NodeName, APIAddr: m.APIAddr, Role: "none"}
		c, err := s.client(cl, m, "")
		var h *Health
		if err == nil {
			h, err = c.Health(ctx)
		}
		if err != nil {
			ns.Error = err.Error()
			m.ServiceStatus, m.RaftRole, m.IsSealed = "unknown", "none", nil
		} else {
			reachable++
			ns.Reachable, ns.Init, ns.Sealed, ns.Version = true, h.Initialized, h.Sealed, h.Version
			ns.Enterprise = h.Enterprise || IsEnterprise(h.Version)
			switch {
			case !h.Initialized:
				uninit++
			case h.Sealed:
				sealed++
			case !h.Standby:
				ns.Role = "active"
				active++
			default:
				ns.Role = "standby"
			}
			if voters != nil {
				ns.Voter = voters[memberConfig(m).RaftNodeID]
			}
			sealedV := h.Sealed
			m.ServiceStatus, m.RaftRole, m.IsSealed, m.IsVoter = "active", ns.Role, &sealedV, ns.Voter
		}
		_ = db.UpdateClusterNodeState(ctx, s.DB.Writer, m, now)
		out[i] = ns
	}
	health := "healthy"
	switch {
	case len(members) == 0 || reachable == 0:
		health = "unreachable"
	case uninit == reachable:
		health = "uninitialized"
	case active == 0:
		health = "sealed"
	case sealed > 0 || reachable < len(members):
		health = "degraded"
	}
	_ = db.SetClusterHealth(ctx, s.DB.Writer, cl.ID, health, now)
	return out, health, nil
}

func sortedMembers(ms []*db.ClusterNode) []*db.ClusterNode {
	out := append([]*db.ClusterNode(nil), ms...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func jsonMarshal(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

func pemOf(ca *pki.CA) []byte {
	return []byte(pki.EncodeCert(ca.Cert.Raw))
}

// NodeDetail extends NodeStatus with Raft and membership details.
type NodeDetail struct {
	NodeStatus
	AutopilotHealthy bool       `json:"autopilot_healthy"`
	LastContact      string     `json:"last_contact"`
	LastIndex        uint64     `json:"last_index"`
	InstalledVersion string     `json:"installed_version"`
	VersionMismatch  bool       `json:"version_mismatch"`
	ConfigGeneration int        `json:"config_generation"`
	CertExpiresAt    *time.Time `json:"cert_expires_at"`
	ServiceStatus    string     `json:"service_status"`
	LastSyncedAt     *time.Time `json:"last_synced_at"`
}

// StatusReport is the live status detail of a cluster.
type StatusReport struct {
	Health             string       `json:"health_status"`
	InitState          string       `json:"init_state"`
	Maintenance        bool         `json:"maintenance_mode"`
	MaintenanceReason  string       `json:"maintenance_reason"`
	ActiveNode         string       `json:"active_node"`
	Versions           []string     `json:"versions"`
	VersionsConsistent bool         `json:"versions_consistent"`
	Voters             int          `json:"voters"`
	HealthyVoters      int          `json:"healthy_voters"`
	FailureTolerance   *int         `json:"failure_tolerance"`
	RaftError          string       `json:"raft_error,omitempty"`
	Nodes              []NodeDetail `json:"nodes"`
}

// StatusDetail probes the cluster and adds autopilot data per node.
func (s *Service) StatusDetail(ctx context.Context, clusterID string) (*StatusReport, error) {
	nodes, health, err := s.SyncStatus(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	rep := &StatusReport{Health: health, InitState: cl.InitState, Maintenance: cl.MaintenanceMode,
		MaintenanceReason: cl.MaintenanceReason, Versions: []string{}, Nodes: []NodeDetail{}}
	var ap *AutopilotState
	if cl.InitState == db.InitInitialized {
		if admin, _, err := s.adminClient(ctx, cl); err != nil {
			rep.RaftError = err.Error()
		} else if ap, err = admin.AutopilotState(ctx); err != nil {
			rep.RaftError = err.Error()
		} else {
			ft := ap.FailureTolerance
			rep.FailureTolerance, rep.Voters = &ft, len(ap.Voters)
			for _, sv := range ap.Servers {
				if sv.Healthy && (sv.Status == "voter" || sv.Status == "leader") {
					rep.HealthyVoters++
				}
			}
		}
	}
	seen := map[string]bool{}
	for i, ns := range nodes {
		m := members[i]
		d := NodeDetail{NodeStatus: ns, InstalledVersion: m.InstalledVersion, ConfigGeneration: memberConfig(m).ConfigGeneration,
			CertExpiresAt: tp(m.CertExpiresAt), ServiceStatus: m.ServiceStatus, LastSyncedAt: tp(m.LastSyncedAt)}
		d.VersionMismatch = ns.Version != "" && m.InstalledVersion != "" && ns.Version != m.InstalledVersion
		if ap != nil {
			if sv, ok := ap.Servers[memberConfig(m).RaftNodeID]; ok {
				d.AutopilotHealthy, d.LastContact, d.LastIndex = sv.Healthy, sv.LastContact, sv.LastIndex
			}
		}
		if ns.Role == "active" {
			rep.ActiveNode = ns.Name
		}
		if ns.Version != "" && !seen[ns.Version] {
			seen[ns.Version] = true
			rep.Versions = append(rep.Versions, ns.Version)
		}
		rep.Nodes = append(rep.Nodes, d)
	}
	rep.VersionsConsistent = len(rep.Versions) <= 1
	return rep, nil
}
