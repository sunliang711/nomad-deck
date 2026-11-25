package nomad

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
)

// Service orchestrates Nomad clusters.
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
	// DrainDeadline bounds a client drain (0 = 1 hour).
	DrainDeadline time.Duration
	// ExtraFiles returns integration fragments of a member's config
	// generation (e.g. 60-vault.hcl and tls/vault-ca.crt).
	ExtraFiles func(ctx context.Context, c *db.Cluster, m *db.ClusterNode, gen int) (map[string]string, error)
	// InUse reports why a cluster cannot be uninstalled ("" when it can),
	// e.g. an applied integration that still references it.
	InUse func(ctx context.Context, clusterID string) string
	// OnCAChange is called after the cluster CA bundle changed, so
	// integrations can push the new trust bundle to their peers.
	OnCAChange func(ctx context.Context, clusterID string, log func(string, ...any)) error

	trCache transportCache
}

// Settings stored in clusters.config_json for Nomad clusters.
type Settings struct {
	HTTPPort          int        `json:"http_port"`
	RPCPort           int        `json:"rpc_port"`
	SerfPort          int        `json:"serf_port"`
	AllowInsecureHTTP bool       `json:"allow_insecure_http"`
	VerifyHTTPSClient bool       `json:"verify_https_client"`
	DisableTelemetry  bool       `json:"disable_telemetry"`
	UI                UISettings `json:"ui"`
	JobGCThreshold    string     `json:"job_gc_threshold,omitempty"`
	// ExecEnabled allows interactive terminals and job actions (default on).
	ExecEnabled *bool  `json:"exec_enabled,omitempty"`
	CNIVersion  string `json:"cni_version,omitempty"`
	Version     string `json:"version,omitempty"`
	UseProxy    *bool  `json:"use_proxy,omitempty"`
	// DockerDefaults are the cluster default Docker Engine settings.
	DockerDefaults json.RawMessage `json:"docker_defaults,omitempty"`
	// Consul is reserved for a future Consul integration (65-consul.hcl).
	Consul json.RawMessage `json:"consul,omitempty"`
}

func (s *Settings) defaults() {
	if s.HTTPPort == 0 {
		s.HTTPPort = 4646
	}
	if s.RPCPort == 0 {
		s.RPCPort = 4647
	}
	if s.SerfPort == 0 {
		s.SerfPort = 4648
	}
}

// ClientSettings are the client-side options of a member (ignored on pure
// servers).
type ClientSettings struct {
	NodePool    string            `json:"node_pool,omitempty"`
	Meta        map[string]string `json:"meta,omitempty"`
	HostVolumes []HostVolume      `json:"host_volumes,omitempty"`
	Docker      DockerDriver      `json:"docker"`
	RawExec     bool              `json:"raw_exec"`
	Denylist    []string          `json:"driver_denylist,omitempty"`
	CNI         bool              `json:"cni"`
	// CPUTotalCompute overrides the fingerprinted CPU capacity (MHz) on
	// hosts where Nomad cannot detect the CPU frequency.
	CPUTotalCompute int `json:"cpu_total_compute,omitempty"`
}

// MemberConfig is stored in cluster_nodes.node_config_json.
type MemberConfig struct {
	NodeName         string   `json:"node_name"`
	ConfigGeneration int      `json:"config_generation"`
	ExtraSANs        []string `json:"extra_sans,omitempty"`
	// ClientNodeID is the Nomad node ID of the client once registered.
	ClientNodeID string `json:"client_node_id,omitempty"`
	ClientSettings
}

var errNotFound = &auth.Error{Status: 404, Code: "not_found", Message: "集群不存在"}

var (
	badRequest = cluster.BadRequest
	conflict   = cluster.Conflict
)

var (
	reClusterName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
	reRegion      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
	reMetaKey     = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	reDriver      = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
	reHostPath    = regexp.MustCompile(`^/[A-Za-z0-9._/@+-]*$`)
	reNodeName    = regexp.MustCompile(`[^A-Za-z0-9_.-]`)
)

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

func (s *Service) drainDeadline() time.Duration {
	if s.DrainDeadline > 0 {
		return s.DrainDeadline
	}
	return time.Hour
}

func (s *Service) remote() *cluster.Remote {
	return &cluster.Remote{DB: s.DB, Hosts: s.Hosts, Product: "nomad", OpLock: OpLockFile}
}

// nomadCluster bundles a cluster with its parsed settings.
type nomadCluster struct {
	*db.Cluster
	Settings Settings
}

func (s *Service) loadCluster(ctx context.Context, q db.Querier, id string) (*nomadCluster, error) {
	c, err := db.GetCluster(ctx, q, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if c.Type != "nomad" {
		return nil, badRequest("集群 %s 不是 Nomad 集群", c.Name)
	}
	cl := &nomadCluster{Cluster: c}
	_ = json.Unmarshal([]byte(c.ConfigJSON), &cl.Settings)
	cl.Settings.defaults()
	return cl, nil
}

func (s *Service) saveSettings(ctx context.Context, cl *nomadCluster) error {
	b, err := json.Marshal(cl.Settings)
	if err != nil {
		return err
	}
	cl.ConfigJSON = string(b)
	return db.UpdateClusterSettings(ctx, s.DB.Writer, cl.Cluster, s.DB.Now())
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

// CreateInput creates a Nomad cluster.
type CreateInput struct {
	Name              string                `json:"name"`
	Mode              string                `json:"mode"`
	Region            string                `json:"region"`
	Datacenter        string                `json:"datacenter"`
	PublicAPIURL      string                `json:"public_api_url"`
	AllowInsecureHTTP bool                  `json:"allow_insecure_http"`
	VerifyHTTPSClient bool                  `json:"verify_https_client"`
	HTTPPort          int                   `json:"http_port"`
	RPCPort           int                   `json:"rpc_port"`
	SerfPort          int                   `json:"serf_port"`
	CNIVersion        string                `json:"cni_version"`
	ClientDefaults    ClientSettings        `json:"client_defaults"`
	Nodes             []cluster.MemberInput `json:"nodes"`
}

func validPort(p int) bool { return p == 0 || (p > 0 && p < 65536) }

func validAddr(a string) bool {
	if ip := net.ParseIP(strings.Trim(a, "[]")); ip != nil {
		return true
	}
	return regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`).MatchString(a)
}

// validateClient checks client settings.
func validateClient(c *ClientSettings) error {
	if c.NodePool != "" && !reRegion.MatchString(c.NodePool) {
		return badRequest("Node Pool 名称不合法")
	}
	for k, v := range c.Meta {
		if !reMetaKey.MatchString(k) || len(v) > 1024 || strings.ContainsAny(v, "\n\r") {
			return badRequest("Client Meta %q 不合法", k)
		}
	}
	seen := map[string]bool{}
	for _, v := range c.HostVolumes {
		if !reVolumeName.MatchString(v.Name) || seen[v.Name] {
			return badRequest("Host Volume 名称 %q 不合法或重复", v.Name)
		}
		seen[v.Name] = true
		if !reHostPath.MatchString(v.Path) || strings.Contains(v.Path, "..") || v.Path == "/" {
			return badRequest("Host Volume %s 的路径不合法", v.Name)
		}
		for _, p := range []string{"/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/proc", "/sys", "/dev", "/run", "/var/lib/docker"} {
			if v.Path == p || strings.HasPrefix(v.Path, p+"/") {
				return badRequest("Host Volume %s 不能使用系统目录 %s", v.Name, p)
			}
		}
		if strings.HasPrefix(v.Path+"/", "/opt/nomad-deck/") && !strings.HasPrefix(v.Path, VolumesDir+"/") {
			return badRequest("Host Volume %s 在 NomadDeck 目录下只能使用 %s/ 子目录", v.Name, VolumesDir)
		}
	}
	for _, d := range c.Denylist {
		if !reDriver.MatchString(d) {
			return badRequest("驱动名称 %q 不合法", d)
		}
	}
	if c.CPUTotalCompute < 0 || c.CPUTotalCompute > 10_000_000 {
		return badRequest("cpu_total_compute 不合法")
	}
	if c.Docker.ImageGCDelay != "" {
		if _, err := time.ParseDuration(c.Docker.ImageGCDelay); err != nil {
			return badRequest("镜像回收延迟格式不正确")
		}
	}
	if c.Docker.AuthConfig != "" && !reHostPath.MatchString(c.Docker.AuthConfig) {
		return badRequest("私有仓库认证文件路径不合法")
	}
	return nil
}

func validURL(s string) error {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return badRequest("public_api_url 需为 http(s) 地址")
	}
	return nil
}

func validRole(r string) bool { return r == RoleServer || r == RoleClient || r == RoleServerClient }

// GenerateGossipKey returns a random 32-byte gossip encryption key.
func GenerateGossipKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// CreateCluster registers a Nomad cluster, its members, CA, control plane
// client certificate and gossip key.
func (s *Service) CreateCluster(ctx context.Context, actor audit.Actor, in CreateInput) (*db.Cluster, error) {
	if !reClusterName.MatchString(in.Name) {
		return nil, badRequest("集群名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	if in.Region == "" {
		in.Region = "global"
	}
	if in.Datacenter == "" {
		in.Datacenter = "dc1"
	}
	if !reRegion.MatchString(in.Region) || !reRegion.MatchString(in.Datacenter) {
		return nil, badRequest("region 与 datacenter 只能包含字母、数字、下划线与连字符")
	}
	servers := 0
	for i := range in.Nodes {
		if in.Mode == "single" {
			in.Nodes[i].Role = RoleServerClient
		}
		if !validRole(in.Nodes[i].Role) {
			return nil, badRequest("节点角色需为 server、client 或 server_client")
		}
		if IsServer(in.Nodes[i].Role) {
			servers++
		}
	}
	switch in.Mode {
	case "single":
		if len(in.Nodes) != 1 {
			return nil, badRequest("单机模式需要且只能选择 1 台主机（Server+Client）")
		}
	case "cluster":
		if servers < 3 || servers%2 == 0 {
			return nil, badRequest("集群模式需要奇数台 Server（推荐 3 或 5 台），当前 %d 台", servers)
		}
	default:
		return nil, badRequest("mode 需为 single 或 cluster")
	}
	if !validPort(in.HTTPPort) || !validPort(in.RPCPort) || !validPort(in.SerfPort) {
		return nil, badRequest("端口不合法")
	}
	if in.PublicAPIURL != "" {
		if err := validURL(in.PublicAPIURL); err != nil {
			return nil, err
		}
	}
	if in.AllowInsecureHTTP && in.VerifyHTTPSClient {
		return nil, badRequest("未启用 TLS 时不能开启 verify_https_client")
	}
	if in.CNIVersion != "" {
		if !contains(s.Releases.CNI(ctx).Versions(), in.CNIVersion) {
			return nil, badRequest("CNI 版本 %s 没有登记的 SHA256", in.CNIVersion)
		}
	}
	if err := validateClient(&in.ClientDefaults); err != nil {
		return nil, err
	}
	if in.ClientDefaults.CNI && in.CNIVersion == "" {
		return nil, badRequest("启用 CNI 时需选择 CNI 版本")
	}
	st := Settings{HTTPPort: in.HTTPPort, RPCPort: in.RPCPort, SerfPort: in.SerfPort, AllowInsecureHTTP: in.AllowInsecureHTTP,
		VerifyHTTPSClient: in.VerifyHTTPSClient, CNIVersion: in.CNIVersion}
	st.defaults()
	cfg, _ := json.Marshal(st)
	tlsCfg, _ := json.Marshal(map[string]any{"http": !in.AllowInsecureHTTP, "rpc": !in.AllowInsecureHTTP,
		"verify_server_hostname": !in.AllowInsecureHTTP, "verify_https_client": in.VerifyHTTPSClient,
		"allow_insecure_http": in.AllowInsecureHTTP})
	now := s.DB.Now()
	c := &db.Cluster{ID: db.NewID(), Name: in.Name, Type: "nomad", Mode: in.Mode, Region: in.Region, Datacenter: in.Datacenter,
		TLSEnabled: !in.AllowInsecureHTTP, TLSConfigJSON: string(tlsCfg), PublicAPIURL: strings.TrimRight(in.PublicAPIURL, "/"),
		ConfigJSON: string(cfg), InitState: db.InitUninitialized, HealthStatus: "unknown", CreatedAt: now, UpdatedAt: now}
	if c.TLSEnabled {
		caM, err := pki.NewCA("NomadDeck Nomad CA "+in.Name, pki.CATTL, now)
		if err != nil {
			return nil, err
		}
		if c.CAKeyEncrypted, err = s.Keys.EncryptString(caM.KeyPEM, db.ClusterCAKeyAAD(c.ID)); err != nil {
			return nil, err
		}
		c.CACertPEM, c.CAExpiresAt = caM.CertPEM, caM.NotAfter
		ca, err := pki.ParseCA(caM.CertPEM, caM.KeyPEM)
		if err != nil {
			return nil, err
		}
		cli, err := ca.Issue(pki.Request{CommonName: "cli." + in.Region + ".nomad", Hosts: []string{"cli." + in.Region + ".nomad", "localhost"}}, now)
		if err != nil {
			return nil, err
		}
		if c.ClientKeyEncrypted, err = s.Keys.EncryptString(cli.KeyPEM, db.ClusterClientKeyAAD(c.ID)); err != nil {
			return nil, err
		}
		c.ClientCertPEM, c.ClientCertExpiresAt = cli.CertPEM, cli.NotAfter
	}
	key, err := GenerateGossipKey()
	if err != nil {
		return nil, err
	}
	if c.GossipKeyEncrypted, err = s.Keys.EncryptString(key, db.ClusterGossipKeyAAD(c.ID)); err != nil {
		return nil, err
	}
	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			if errors.Is(err, db.ErrUnique) {
				return conflict("name_taken", "集群名称已存在")
			}
			return err
		}
		seen := map[string]bool{}
		for _, mi := range in.Nodes {
			if seen[mi.NodeID] {
				return badRequest("主机重复")
			}
			seen[mi.NodeID] = true
			if _, err := s.insertMember(ctx, tx, c, st, mi, in.ClientDefaults, now); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "cluster.create", ResourceType: "cluster",
			ResourceID: c.ID, ResourceName: c.Name, Summary: map[string]any{"type": "nomad", "mode": in.Mode,
				"nodes": len(in.Nodes), "servers": servers, "tls": c.TLSEnabled, "region": in.Region,
				"verify_https_client": in.VerifyHTTPSClient}})
	})
	if err != nil {
		return nil, err
	}
	return db.GetCluster(ctx, s.DB.Reader, c.ID)
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func nodeName(hostName string) string { return reNodeName.ReplaceAllString(hostName, "-") }

func (s *Service) insertMember(ctx context.Context, tx *sql.Tx, c *db.Cluster, st Settings, mi cluster.MemberInput,
	defaults ClientSettings, now time.Time) (*db.ClusterNode, error) {
	n, err := db.GetNode(ctx, tx, mi.NodeID)
	if errors.Is(err, db.ErrNotFound) {
		return nil, badRequest("主机 %s 不存在", mi.NodeID)
	}
	if err != nil {
		return nil, err
	}
	if !validRole(mi.Role) {
		return nil, badRequest("主机 %s 的角色需为 server、client 或 server_client", n.Name)
	}
	adv := strings.TrimSpace(mi.AdvertiseAddr)
	if adv == "" {
		adv = n.Host
	}
	if !validAddr(adv) {
		return nil, badRequest("主机 %s 的通信地址不合法", n.Name)
	}
	m := &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "nomad", NodeID: n.ID, Role: mi.Role,
		AdvertiseAddr: adv, APIAddr: APIAddr(adv, st.HTTPPort, c.TLSEnabled), CreatedAt: now, UpdatedAt: now}
	mc := MemberConfig{NodeName: nodeName(n.Name)}
	if IsClient(mi.Role) {
		mc.ClientSettings = defaults
	}
	setMemberConfig(m, mc)
	if err := db.InsertClusterNode(ctx, tx, m); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("node_in_cluster", "主机 %s 已属于另一个 Nomad 集群", n.Name)
		}
		return nil, err
	}
	return m, nil
}

// AddMembers adds hosts to a cluster that has not been deployed yet.
func (s *Service) AddMembers(ctx context.Context, actor audit.Actor, clusterID string, in []cluster.MemberInput) error {
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cl, err := s.loadCluster(ctx, tx, clusterID)
		if err != nil {
			return err
		}
		if cl.InitState != db.InitUninitialized {
			return conflict("cluster_initialized", "集群已部署，请使用扩容（Join）新增节点")
		}
		now := s.DB.Now()
		for _, mi := range in {
			if cl.Mode == "single" {
				return conflict("single_mode", "单机模式集群只能有一台主机")
			}
			if _, err := s.insertMember(ctx, tx, cl.Cluster, cl.Settings, mi, ClientSettings{}, now); err != nil {
				return err
			}
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "cluster.add_nodes", ResourceType: "cluster",
			ResourceID: cl.ID, ResourceName: cl.Name, Summary: map[string]any{"nodes": len(in)}})
	})
}

// ---- Clients and credentials ----

func (s *Service) clientCert(cl *nomadCluster) *ClientCert {
	if !cl.Settings.VerifyHTTPSClient || cl.ClientKeyEncrypted == "" {
		return nil
	}
	key, err := s.Keys.DecryptString(cl.ClientKeyEncrypted, db.ClusterClientKeyAAD(cl.ID))
	if err != nil {
		return nil
	}
	return &ClientCert{CertPEM: cl.ClientCertPEM, KeyPEM: key}
}

func (s *Service) client(cl *nomadCluster, m *db.ClusterNode, token string) (*Client, error) {
	cert := s.clientCert(cl)
	tr, err := s.trCache.get(m.APIAddr, cl.CACertPEM, cert)
	if err != nil {
		return nil, err
	}
	return newClientWithTransport(m.APIAddr, token, tr, s.apiTimeout()), nil
}

// managementToken decrypts the control plane's management token.
func (s *Service) managementToken(cl *nomadCluster) (string, error) {
	if cl.AdminTokenEncrypted == "" {
		return "", conflict("no_admin_token", "集群尚无托管的 Management Token")
	}
	return s.Keys.DecryptString(cl.AdminTokenEncrypted, db.ClusterAdminTokenAAD(cl.ID))
}

// servers returns the server members, in creation order.
func servers(ms []*db.ClusterNode) []*db.ClusterNode {
	var out []*db.ClusterNode
	for _, m := range ms {
		if IsServer(m.Role) {
			out = append(out, m)
		}
	}
	return out
}

func clients(ms []*db.ClusterNode) []*db.ClusterNode {
	var out []*db.ClusterNode
	for _, m := range ms {
		if IsClient(m.Role) {
			out = append(out, m)
		}
	}
	return out
}

// apiClient returns a management client on the first reachable installed
// server (Nomad forwards cluster-wide requests to the leader).
func (s *Service) apiClient(ctx context.Context, cl *nomadCluster, except string) (*Client, *db.ClusterNode, error) {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, nil, err
	}
	tok, err := s.managementToken(cl)
	if err != nil {
		return nil, nil, err
	}
	var last error
	for _, m := range servers(members) {
		if m.InstallState != "installed" || m.ID == except {
			continue
		}
		c, err := s.client(cl, m, tok)
		if err != nil {
			last = err
			continue
		}
		if leader, err := c.Leader(ctx); err == nil && leader != "" {
			return c, m, nil
		} else if err != nil {
			last = err
		}
	}
	if last == nil {
		last = errors.New("没有可用的 Server")
	}
	return nil, nil, conflict("no_server", "没有找到可访问且已选出 Leader 的 Nomad Server：%v", last)
}

// ---- Status ----

// NodeStatus is the live state of one member.
type NodeStatus struct {
	NodeID           string     `json:"node_id"`
	Name             string     `json:"name"`
	Role             string     `json:"role"`
	APIAddr          string     `json:"api_addr"`
	Reachable        bool       `json:"reachable"`
	Version          string     `json:"version"`
	InstalledVersion string     `json:"installed_version"`
	VersionMismatch  bool       `json:"version_mismatch"`
	RaftRole         string     `json:"raft_role"`
	Voter            bool       `json:"is_voter"`
	AutopilotHealthy bool       `json:"autopilot_healthy"`
	LastContact      string     `json:"last_contact,omitempty"`
	LastIndex        uint64     `json:"last_index,omitempty"`
	ClientStatus     string     `json:"client_status,omitempty"`
	Eligibility      string     `json:"scheduling_eligibility,omitempty"`
	Draining         bool       `json:"draining"`
	NodePool         string     `json:"node_pool,omitempty"`
	DockerHealthy    *bool      `json:"docker_healthy,omitempty"`
	ConfigGeneration int        `json:"config_generation"`
	CertExpiresAt    *time.Time `json:"cert_expires_at"`
	ServiceStatus    string     `json:"service_status"`
	Error            string     `json:"error,omitempty"`
}

// StatusReport is the live status detail of a cluster.
type StatusReport struct {
	Health             string       `json:"health_status"`
	InitState          string       `json:"init_state"`
	Maintenance        bool         `json:"maintenance_mode"`
	MaintenanceReason  string       `json:"maintenance_reason"`
	Leader             string       `json:"leader"`
	Versions           []string     `json:"versions"`
	VersionsConsistent bool         `json:"versions_consistent"`
	Voters             int          `json:"voters"`
	HealthyVoters      int          `json:"healthy_voters"`
	FailureTolerance   *int         `json:"failure_tolerance"`
	ReadyClients       int          `json:"ready_clients"`
	Clients            int          `json:"clients"`
	RaftError          string       `json:"raft_error,omitempty"`
	Nodes              []NodeStatus `json:"nodes"`
}

func tp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// StatusDetail probes every member, stores node and cluster state and
// returns the live view.
func (s *Service) StatusDetail(ctx context.Context, clusterID string) (*StatusReport, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, err
	}
	rep := &StatusReport{InitState: cl.InitState, Maintenance: cl.MaintenanceMode, MaintenanceReason: cl.MaintenanceReason,
		Versions: []string{}, Nodes: []NodeStatus{}}
	tok, _ := s.managementToken(cl)
	var raft []RaftServer
	var ap *AutopilotHealth
	var nodes []NodeStub
	if cl.InitState == db.InitInitialized {
		if api, _, err := s.apiClient(ctx, cl, ""); err != nil {
			rep.RaftError = err.Error()
		} else {
			if raft, err = api.RaftConfiguration(ctx); err != nil {
				rep.RaftError = err.Error()
			}
			if ap, err = api.Autopilot(ctx); err == nil {
				ft := ap.FailureTolerance
				rep.FailureTolerance = &ft
			}
			nodes, _ = api.Nodes(ctx)
		}
	}
	now := s.DB.Now()
	reachable, leaderSeen := 0, false
	seenVer := map[string]bool{}
	for _, m := range members {
		mc := memberConfig(m)
		ns := NodeStatus{NodeID: m.NodeID, Name: m.NodeName, Role: m.Role, APIAddr: m.APIAddr, RaftRole: "none",
			InstalledVersion: m.InstalledVersion, ConfigGeneration: mc.ConfigGeneration, CertExpiresAt: tp(m.CertExpiresAt)}
		c, err := s.client(cl, m, tok)
		if err == nil {
			var h *AgentHealth
			if h, err = c.Health(ctx); err == nil {
				ns.Reachable = true
				reachable++
				if tok != "" && cl.InitState == db.InitInitialized {
					if self, err := c.Self(ctx); err == nil {
						ns.Version = self.Version
					}
				}
				if h.Server != nil && !h.Server.OK {
					ns.Error = h.Server.Message
				}
			}
		}
		if err != nil {
			ns.Error = err.Error()
		}
		ns.ServiceStatus = "unknown"
		if ns.Reachable {
			ns.ServiceStatus = "active"
		}
		if IsServer(m.Role) {
			for _, sv := range raft {
				if sv.Node == mc.NodeName+"."+cl.Region || strings.HasPrefix(sv.Address, m.AdvertiseAddr+":") || sv.Node == mc.NodeName {
					ns.Voter = sv.Voter
					ns.RaftRole = "follower"
					if sv.Leader {
						ns.RaftRole = "leader"
						rep.Leader = m.NodeName
						leaderSeen = true
					}
					if ap != nil {
						for _, h := range ap.Servers {
							if h.ID == sv.ID {
								ns.AutopilotHealthy, ns.LastContact, ns.LastIndex = h.Healthy, h.LastContact, h.LastIndex
								if h.Healthy && h.Voter {
									rep.HealthyVoters++
								}
							}
						}
					}
					if sv.Voter {
						rep.Voters++
					}
				}
			}
		}
		if IsClient(m.Role) {
			rep.Clients++
			for _, n := range nodes {
				if n.Name == mc.NodeName {
					ns.ClientStatus, ns.Eligibility, ns.Draining, ns.NodePool = n.Status, n.SchedulingEligibility, n.Drain, n.NodePool
					if d, ok := n.Drivers["docker"]; ok {
						v := d.Detected && d.Healthy
						ns.DockerHealthy = &v
					}
					if n.Status == "ready" {
						rep.ReadyClients++
					}
					if mc.ClientNodeID != n.ID {
						mc.ClientNodeID = n.ID
						setMemberConfig(m, mc)
						_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, now)
					}
				}
			}
		}
		ns.VersionMismatch = ns.Version != "" && m.InstalledVersion != "" && ns.Version != m.InstalledVersion
		if ns.Version != "" && !seenVer[ns.Version] {
			seenVer[ns.Version] = true
			rep.Versions = append(rep.Versions, ns.Version)
		}
		m.ServiceStatus, m.RaftRole, m.IsVoter = ns.ServiceStatus, ns.RaftRole, ns.Voter
		_ = db.UpdateClusterNodeState(ctx, s.DB.Writer, m, now)
		rep.Nodes = append(rep.Nodes, ns)
	}
	sort.Strings(rep.Versions)
	rep.VersionsConsistent = len(rep.Versions) <= 1
	switch {
	case len(members) == 0 || reachable == 0:
		rep.Health = "unreachable"
	case cl.InitState != db.InitInitialized:
		rep.Health = "uninitialized"
	case !leaderSeen || reachable < len(members) || rep.ReadyClients < rep.Clients:
		rep.Health = "degraded"
	default:
		rep.Health = "healthy"
	}
	_ = db.SetClusterHealth(ctx, s.DB.Writer, cl.ID, rep.Health, now)
	return rep, nil
}

// DeleteUndeployed removes a cluster record that was never deployed.
func (s *Service) DeleteUndeployed(ctx context.Context, actor audit.Actor, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if s.InUse != nil {
		if why := s.InUse(ctx, clusterID); why != "" {
			return conflict("cluster_in_use", "%s", why)
		}
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.InstallState != "pending" {
			return conflict("deployed", "集群已部署，请使用卸载")
		}
	}
	if err := db.DeleteCluster(ctx, s.DB.Writer, clusterID); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.delete", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name})
}

// ExecAllowed reports whether interactive terminals are enabled on a cluster.
func (s *Service) ExecAllowed(ctx context.Context, clusterID string) (bool, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return false, err
	}
	return cl.Settings.ExecEnabled == nil || *cl.Settings.ExecEnabled, nil
}
