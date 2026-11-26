package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/vault"
)

// TypeNomadVault is the Nomad -> Vault workload identity integration.
const TypeNomadVault = "nomad_vault_jwt"

// Service manages integrations.
type Service struct {
	DB    *db.DB
	Keys  *crypto.Keyring
	Audit *audit.Recorder
	Ops   *ops.Engine
	Nomad *nomad.Service
	Vault *vault.Service
	Log   *slog.Logger
	// PollEvery and ProbeTimeout tune the Doctor login probe (tests).
	PollEvery    time.Duration
	ProbeTimeout time.Duration
}

var (
	badRequest  = cluster.BadRequest
	conflict    = cluster.Conflict
	errNotFound = &auth.Error{Status: 404, Code: "not_found", Message: "联动配置不存在"}
	reName      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
	reAuthPath  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
	reRoleName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
	reClaimKey  = regexp.MustCompile(`^nomad_(namespace|job_id|task|allocation_id|group)$`)
	reKVPath    = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.*+-]+)+$`)
	reKVMount   = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$`)
)

// Wire installs the integration hooks on the product services.
func (s *Service) Wire() {
	s.Nomad.ExtraFiles = s.extraFiles
	s.Nomad.InUse = s.inUse
	s.Nomad.OnCAChange = s.onNomadCA
	s.Vault.InUse = s.inUse
	s.Vault.OnCAChange = s.onVaultCA
}

func (s *Service) inUse(ctx context.Context, clusterID string) string {
	is, err := db.ListIntegrations(ctx, s.DB.Reader, clusterID)
	if err != nil || len(is) == 0 {
		return ""
	}
	return fmt.Sprintf("集群仍被联动配置 %s 引用，请先删除该联动", is[0].Name)
}

// ---- Loading ----

type loaded struct {
	*db.Integration
	cfg   Config
	src   *db.Cluster
	dst   *db.Cluster
	roles []*db.IntegrationRole
}

func (s *Service) load(ctx context.Context, id string) (*loaded, error) {
	i, err := db.GetIntegration(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	l := &loaded{Integration: i}
	_ = json.Unmarshal([]byte(i.ConfigJSON), &l.cfg)
	l.cfg.defaults()
	if l.src, err = db.GetCluster(ctx, s.DB.Reader, i.SourceClusterID); err != nil {
		return nil, err
	}
	if l.dst, err = db.GetCluster(ctx, s.DB.Reader, i.TargetClusterID); err != nil {
		return nil, err
	}
	if l.roles, err = db.ListRoles(ctx, s.DB.Reader, id); err != nil {
		return nil, err
	}
	return l, nil
}

func specOf(r *db.IntegrationRole) RoleSpec {
	sp := RoleSpec{Name: r.RoleName, Policy: r.PolicyName, Mode: r.PolicyMode, CustomHCL: r.CustomPolicyHCL, TokenPeriod: r.TokenPeriod}
	_ = json.Unmarshal([]byte(r.SecretPathsJSON), &sp.SecretPaths)
	_ = json.Unmarshal([]byte(r.BoundClaimsJSON), &sp.BoundClaims)
	return sp
}

// ---- Views ----

// View is an integration with its roles.
type View struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Type              string          `json:"integration_type"`
	SourceClusterID   string          `json:"source_cluster_id"`
	SourceCluster     string          `json:"source_cluster"`
	TargetClusterID   string          `json:"target_cluster_id"`
	TargetCluster     string          `json:"target_cluster"`
	AuthPath          string          `json:"auth_path"`
	Config            Config          `json:"config"`
	Status            string          `json:"status"`
	NomadSideEnabled  bool            `json:"nomad_side_enabled"`
	NomadConfigSHA256 string          `json:"nomad_config_sha256"`
	LastAppliedAt     *time.Time      `json:"last_applied_at"`
	LastDoctor        json.RawMessage `json:"last_doctor"`
	Roles             []RoleView      `json:"roles"`
}

// RoleView is a workload role.
type RoleView struct {
	ID            string            `json:"id"`
	RoleName      string            `json:"role_name"`
	PolicyName    string            `json:"policy_name"`
	PolicyMode    string            `json:"policy_mode"`
	SecretPaths   []string          `json:"secret_paths"`
	CustomPolicy  string            `json:"custom_policy_hcl"`
	BoundClaims   map[string]string `json:"bound_claims"`
	TokenPeriod   string            `json:"token_period"`
	Status        string            `json:"status"`
	LastAppliedAt *time.Time        `json:"last_applied_at"`
}

func tp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (l *loaded) view() View {
	v := View{ID: l.ID, Name: l.Name, Type: l.Type, SourceClusterID: l.src.ID, SourceCluster: l.src.Name, TargetClusterID: l.dst.ID,
		TargetCluster: l.dst.Name, AuthPath: l.AuthPath, Config: l.cfg, Status: l.Status, NomadSideEnabled: l.NomadSideEnabled,
		NomadConfigSHA256: l.NomadConfigSHA256, LastAppliedAt: tp(l.LastAppliedAt), LastDoctor: json.RawMessage(l.LastDoctorJSON),
		Roles: []RoleView{}}
	for i := range v.Config.StaticKeys {
		v.Config.StaticKeys[i].PEM = ""
	}
	for _, r := range l.roles {
		sp := specOf(r)
		if sp.SecretPaths == nil {
			sp.SecretPaths = []string{}
		}
		v.Roles = append(v.Roles, RoleView{ID: r.ID, RoleName: r.RoleName, PolicyName: r.PolicyName, PolicyMode: r.PolicyMode,
			SecretPaths: sp.SecretPaths, CustomPolicy: r.CustomPolicyHCL, BoundClaims: sp.BoundClaims, TokenPeriod: r.TokenPeriod,
			Status: r.Status, LastAppliedAt: tp(r.LastAppliedAt)})
	}
	return v
}

// List lists integrations.
func (s *Service) List(ctx context.Context) ([]View, error) {
	is, err := db.ListIntegrations(ctx, s.DB.Reader, "")
	if err != nil {
		return nil, err
	}
	out := []View{}
	for _, i := range is {
		l, err := s.load(ctx, i.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, l.view())
	}
	return out, nil
}

// Get returns one integration.
func (s *Service) Get(ctx context.Context, id string) (*View, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	v := l.view()
	return &v, nil
}

// ---- Create / update / roles ----

// Input creates or edits an integration.
type Input struct {
	Name            string   `json:"name"`
	SourceClusterID string   `json:"source_cluster_id"`
	TargetClusterID string   `json:"target_cluster_id"`
	AuthPath        string   `json:"auth_path"`
	Audience        []string `json:"aud"`
	JWKSMode        string   `json:"jwks_mode"`
	JWKSURL         string   `json:"jwks_url"`
	VaultAddr       string   `json:"vault_address"`
	DefaultRole     string   `json:"default_role"`
	IdentityTTL     string   `json:"identity_ttl"`
}

func (in *Input) apply(cfg *Config) error {
	if in.Audience != nil {
		cfg.Audience = in.Audience
	}
	if in.JWKSMode != "" {
		cfg.JWKSMode = in.JWKSMode
	}
	cfg.JWKSURL, cfg.VaultAddr, cfg.DefaultRole = in.JWKSURL, in.VaultAddr, in.DefaultRole
	if in.IdentityTTL != "" {
		cfg.IdentityTTL = in.IdentityTTL
	}
	cfg.defaults()
	if cfg.JWKSMode != "url" && cfg.JWKSMode != "static" {
		return badRequest("jwks_mode 需为 url 或 static")
	}
	for _, a := range cfg.Audience {
		if a == "" || len(a) > 256 || strings.ContainsAny(a, "\"\n") {
			return badRequest("aud 不合法")
		}
	}
	if d, err := time.ParseDuration(cfg.IdentityTTL); err != nil || d < time.Minute {
		return badRequest("identity_ttl 格式不正确")
	}
	for _, u := range []string{cfg.JWKSURL, cfg.VaultAddr} {
		if u == "" {
			continue
		}
		pu, err := url.Parse(u)
		if err != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" {
			return badRequest("地址 %q 需为 http(s) URL", u)
		}
	}
	if cfg.DefaultRole != "" && !reRoleName.MatchString(cfg.DefaultRole) {
		return badRequest("default_role 不合法")
	}
	return nil
}

// Create registers a draft integration.
func (s *Service) Create(ctx context.Context, actor audit.Actor, in Input) (*View, error) {
	if !reName.MatchString(in.Name) {
		return nil, badRequest("联动名称需为 1～63 位字母、数字、点、下划线或连字符")
	}
	src, err := db.GetCluster(ctx, s.DB.Reader, in.SourceClusterID)
	if err != nil || src.Type != "nomad" {
		return nil, badRequest("源集群需为 Nomad 集群")
	}
	dst, err := db.GetCluster(ctx, s.DB.Reader, in.TargetClusterID)
	if err != nil || dst.Type != "vault" {
		return nil, badRequest("目标集群需为 Vault 集群")
	}
	if in.AuthPath == "" {
		in.AuthPath = defaultAuthPath(src.Name)
	}
	if !reAuthPath.MatchString(in.AuthPath) {
		return nil, badRequest("auth_path 只能包含字母、数字、下划线与连字符")
	}
	var cfg Config
	if err := in.apply(&cfg); err != nil {
		return nil, err
	}
	if err := s.checkCreateConflict(ctx, in.Name, src, dst, in.AuthPath); err != nil {
		return nil, err
	}
	b, _ := json.Marshal(cfg)
	now := s.DB.Now()
	i := &db.Integration{ID: db.NewID(), Name: in.Name, Type: TypeNomadVault, SourceClusterID: src.ID, TargetClusterID: dst.ID,
		AuthPath: in.AuthPath, ConfigJSON: string(b), CreatedAt: now, UpdatedAt: now}
	if err := db.InsertIntegration(ctx, s.DB.Writer, i); err != nil {
		if errors.Is(err, db.ErrUnique) {
			if cerr := s.checkCreateConflict(ctx, in.Name, src, dst, in.AuthPath); cerr != nil {
				return nil, cerr
			}
			return nil, conflict("integration_conflict", "名称已存在、该 Vault 集群上的 Auth 路径已被占用，或该 Nomad 集群已绑定另一个 Vault 集群")
		}
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.create", ResourceType: "integration", ResourceID: i.ID,
		ResourceName: i.Name, Summary: map[string]any{"source": src.Name, "target": dst.Name, "auth_path": i.AuthPath}})
	return s.Get(ctx, i.ID)
}

func authSlug(name string) string {
	s := strings.ToLower(regexp.MustCompile(`[^A-Za-z0-9_-]+`).ReplaceAllString(name, "-"))
	s = strings.Trim(s, "-_")
	if s == "" {
		s = "cluster"
	}
	return s
}

func defaultAuthPath(srcName string) string {
	p := "jwt-nomad-" + authSlug(srcName)
	if len(p) > 63 {
		p = strings.TrimRight(p[:63], "-_")
	}
	return p
}

func (s *Service) checkCreateConflict(ctx context.Context, name string, src, dst *db.Cluster, authPath string) error {
	existing, err := db.ListIntegrations(ctx, s.DB.Reader, "")
	if err != nil {
		return nil
	}
	for _, e := range existing {
		if e.SourceClusterID == src.ID && e.Type == TypeNomadVault {
			targetName := e.TargetClusterID
			if tc, err := db.GetCluster(ctx, s.DB.Reader, e.TargetClusterID); err == nil {
				targetName = tc.Name
			}
			return conflict("integration_source_bound", "Nomad 集群「%s」已绑定联动「%s」（目标 Vault：%s），每个 Nomad 集群只能绑定一个 Vault 集群", src.Name, e.Name, targetName)
		}
		if e.Name == name {
			return conflict("integration_name_taken", "联动名称「%s」已存在，请换一个名称", name)
		}
		if e.TargetClusterID == dst.ID && e.AuthPath == authPath {
			return conflict("integration_auth_path_taken", "Vault 集群「%s」上的 Auth 路径「%s」已被联动「%s」占用，请在高级参数中改用其他路径（例如 %s）", dst.Name, authPath, e.Name, defaultAuthPath(src.Name))
		}
	}
	return nil
}

// Update edits a draft or applied integration (a new Apply rolls it out).
func (s *Service) Update(ctx context.Context, actor audit.Actor, id string, in Input) (*View, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	if in.SourceClusterID != "" && in.SourceClusterID != l.SourceClusterID || in.TargetClusterID != "" && in.TargetClusterID != l.TargetClusterID ||
		in.AuthPath != "" && in.AuthPath != l.AuthPath {
		return nil, badRequest("源集群、目标集群与 Auth 路径创建后不能修改，请新建联动")
	}
	if in.Name != "" {
		if !reName.MatchString(in.Name) {
			return nil, badRequest("联动名称不合法")
		}
		l.Name = in.Name
	}
	keys := l.cfg.StaticKeys
	if err := in.apply(&l.cfg); err != nil {
		return nil, err
	}
	l.cfg.StaticKeys = keys
	b, _ := json.Marshal(l.cfg)
	l.ConfigJSON = string(b)
	if err := db.UpdateIntegrationConfig(ctx, s.DB.Writer, l.Integration, s.DB.Now()); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("name_taken", "联动名称已存在")
		}
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.update", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name})
	return s.Get(ctx, id)
}

// RoleInput creates or edits a workload role.
type RoleInput struct {
	RoleName        string            `json:"role_name"`
	PolicyName      string            `json:"policy_name"`
	PolicyMode      string            `json:"policy_mode"`
	SecretPaths     []string          `json:"secret_paths"`
	CustomPolicyHCL string            `json:"custom_policy_hcl"`
	BoundClaims     map[string]string `json:"bound_claims"`
	TokenPeriod     string            `json:"token_period"`
}

func (in *RoleInput) validate(integrationName string) error {
	if !reRoleName.MatchString(in.RoleName) {
		return badRequest("Role 名称只能包含字母、数字、下划线与连字符")
	}
	if in.PolicyName == "" {
		in.PolicyName = "nomad-" + integrationName + "-" + in.RoleName
	}
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).MatchString(in.PolicyName) {
		return badRequest("Policy 名称不合法")
	}
	if in.PolicyMode == "" {
		in.PolicyMode = "explicit"
	}
	switch in.PolicyMode {
	case "explicit":
		if len(in.SecretPaths) == 0 && strings.TrimSpace(in.CustomPolicyHCL) == "" {
			return badRequest("explicit 模式至少需要一个密钥路径（格式 <KV 挂载>/<路径>）")
		}
		for _, p := range in.SecretPaths {
			if !reKVPath.MatchString(strings.Trim(p, "/")) || strings.Contains(p, "..") {
				return badRequest("密钥路径 %q 不合法（格式 <KV 挂载>/<路径>）", p)
			}
		}
	case "templated":
		for _, m := range in.SecretPaths {
			if !reKVMount.MatchString(strings.Trim(m, "/")) {
				return badRequest("templated 模式的 KV 挂载 %q 不合法", m)
			}
		}
	default:
		return badRequest("policy_mode 需为 explicit 或 templated")
	}
	if in.BoundClaims["nomad_namespace"] == "" {
		return badRequest("bound_claims 必须包含 nomad_namespace")
	}
	for k, v := range in.BoundClaims {
		if !reClaimKey.MatchString(k) || v == "" || len(v) > 256 {
			return badRequest("bound_claims 的 %q 不合法", k)
		}
	}
	if in.TokenPeriod == "" {
		in.TokenPeriod = "1h"
	}
	if d, err := time.ParseDuration(in.TokenPeriod); err != nil || d < time.Minute {
		return badRequest("token_period 格式不正确")
	}
	return nil
}

// PutRole creates (empty roleID) or edits a role; the change reaches Vault
// with the next Apply and never restarts Nomad.
func (s *Service) PutRole(ctx context.Context, actor audit.Actor, id, roleID string, in RoleInput) (*View, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := in.validate(l.Name); err != nil {
		return nil, err
	}
	now := s.DB.Now()
	r := &db.IntegrationRole{ID: roleID, IntegrationID: id, Status: "draft", CreatedAt: now}
	if roleID == "" {
		r.ID = db.NewID()
	} else {
		old, err := db.GetRole(ctx, s.DB.Reader, roleID)
		if err != nil || old.IntegrationID != id {
			return nil, &auth.Error{Status: 404, Code: "not_found", Message: "Role 不存在"}
		}
		if old.RoleName != in.RoleName {
			return nil, badRequest("Role 名称创建后不能修改")
		}
	}
	paths, _ := json.Marshal(in.SecretPaths)
	claims, _ := json.Marshal(in.BoundClaims)
	r.RoleName, r.PolicyName, r.PolicyMode, r.SecretPathsJSON = in.RoleName, in.PolicyName, in.PolicyMode, string(paths)
	r.CustomPolicyHCL, r.BoundClaimsJSON, r.TokenPeriod = in.CustomPolicyHCL, string(claims), in.TokenPeriod
	if err := db.UpsertRole(ctx, s.DB.Writer, r, now); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("role_exists", "Role %s 已存在", in.RoleName)
		}
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.role_put", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name, Summary: map[string]any{"role": in.RoleName, "mode": in.PolicyMode, "bound_claims": in.BoundClaims}})
	return s.Get(ctx, id)
}

// DeleteRole removes a role; an applied role is removed from Vault first.
func (s *Service) DeleteRole(ctx context.Context, actor audit.Actor, id, roleID string) error {
	l, err := s.load(ctx, id)
	if err != nil {
		return err
	}
	release, err := s.Ops.Locks.Acquire(ctx, []ops.LockReq{{Key: ops.ClusterLock(l.TargetClusterID), Mode: ops.Exclusive}})
	if err != nil {
		return err
	}
	defer release()
	r, err := db.GetRole(ctx, s.DB.Reader, roleID)
	if err != nil || r.IntegrationID != id {
		return &auth.Error{Status: 404, Code: "not_found", Message: "Role 不存在"}
	}
	if r.Status != "draft" {
		vc, err := s.Vault.AdminClient(ctx, l.TargetClusterID)
		if err != nil {
			return err
		}
		if err := vc.Request(ctx, http.MethodDelete, "auth/"+l.AuthPath+"/role/"+r.RoleName, nil, nil); err != nil && vault.StatusOf(err) != 404 {
			return fmt.Errorf("删除 Vault Role 失败：%w", err)
		}
		if err := vc.DeletePolicy(ctx, r.PolicyName); err != nil && vault.StatusOf(err) != 404 {
			return fmt.Errorf("删除 Vault Policy 失败：%w", err)
		}
	}
	if err := db.DeleteRole(ctx, s.DB.Writer, roleID); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.role_delete", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name, Summary: map[string]any{"role": r.RoleName}})
}

// ---- Endpoints ----

func endpoint(c *db.Cluster, members []*db.ClusterNode, pick func(*db.ClusterNode) bool) (string, bool) {
	if c.PublicAPIURL != "" {
		return c.PublicAPIURL, true
	}
	for _, m := range members {
		if m.InstallState == "installed" && pick(m) {
			return m.APIAddr, len(members) <= 1
		}
	}
	return "", false
}

// addresses computes the JWKS URL and Vault address (overrides first),
// reporting single points of failure.
func (s *Service) addresses(ctx context.Context, l *loaded) (jwksURL, vaultAddr string, warnings []string, err error) {
	sm, err := db.ListClusterNodes(ctx, s.DB.Reader, l.src.ID)
	if err != nil {
		return "", "", nil, err
	}
	vm, err := db.ListClusterNodes(ctx, s.DB.Reader, l.dst.ID)
	if err != nil {
		return "", "", nil, err
	}
	jwksURL = l.cfg.JWKSURL
	if jwksURL == "" {
		base, ha := endpoint(l.src, sm, func(m *db.ClusterNode) bool { return nomad.IsServer(m.Role) })
		if base != "" {
			jwksURL = strings.TrimRight(base, "/") + "/.well-known/jwks.json"
		}
		if !ha && len(sm) > 1 {
			warnings = append(warnings, "Nomad 集群未配置统一入口（public_api_url），jwks_url 回退为单台 Server 地址，存在单点故障")
		}
	}
	vaultAddr = l.cfg.VaultAddr
	if vaultAddr == "" {
		base, ha := endpoint(l.dst, vm, func(*db.ClusterNode) bool { return true })
		vaultAddr = base
		if !ha && len(vm) > 1 {
			warnings = append(warnings, "Vault 集群未配置统一入口（public_api_url），vault.address 回退为单台节点地址，存在单点故障")
		}
	}
	if jwksURL == "" || vaultAddr == "" {
		return "", "", warnings, conflict("not_deployed", "源或目标集群尚未部署，无法确定访问地址")
	}
	return jwksURL, vaultAddr, warnings, nil
}

func (s *Service) vaultSide(l *loaded, vaultAddr string) VaultSide {
	return VaultSide{Address: vaultAddr, AuthPath: l.AuthPath, Audience: l.cfg.Audience, TTL: l.cfg.IdentityTTL, HasCA: l.dst.TLSEnabled}
}

func nomadSettings(c *db.Cluster) nomad.Settings {
	var st nomad.Settings
	_ = json.Unmarshal([]byte(c.ConfigJSON), &st)
	return st
}

// ---- Hooks ----

// extraFiles returns the Nomad-side fragments of the source cluster's
// active integration for one member.
func (s *Service) extraFiles(ctx context.Context, c *db.Cluster, m *db.ClusterNode, gen int) (map[string]string, error) {
	is, err := db.ListIntegrations(ctx, s.DB.Reader, c.ID)
	if err != nil {
		return nil, err
	}
	for _, i := range is {
		if i.SourceClusterID != c.ID || !i.NomadSideEnabled {
			continue
		}
		l, err := s.load(ctx, i.ID)
		if err != nil {
			return nil, err
		}
		_, vaultAddr, _, err := s.addresses(ctx, l)
		if err != nil {
			return nil, err
		}
		caPath := nomad.GenerationDir(gen) + "/tls/vault-ca.crt"
		out := map[string]string{"60-vault.hcl": RenderNomadVault(s.vaultSide(l, vaultAddr), m.Role, caPath)}
		if l.dst.TLSEnabled {
			out["tls/vault-ca.crt"] = l.dst.CACertPEM
		}
		return out, nil
	}
	return nil, nil
}

// onNomadCA pushes the source cluster's CA bundle to the jwks_ca_pem of
// every applied integration it feeds.
func (s *Service) onNomadCA(ctx context.Context, clusterID string, log func(string, ...any)) error {
	is, err := db.ListIntegrations(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	for _, i := range is {
		if i.SourceClusterID != clusterID || i.Status == "draft" {
			continue
		}
		l, err := s.load(ctx, i.ID)
		if err != nil {
			return err
		}
		if err := s.writeAuthConfig(ctx, l, log); err != nil {
			return fmt.Errorf("更新联动 %s 的 jwks_ca_pem 失败：%w", l.Name, err)
		}
		log("联动 %s：已将 Nomad CA 信任链写入 Vault jwks_ca_pem", l.Name)
	}
	return nil
}

// onVaultCA rolls the new Vault CA bundle out to the Nomad clusters that
// trust it, and waits for the rollout so Vault only moves its certificates
// once every Nomad node trusts the new CA.
func (s *Service) onVaultCA(ctx context.Context, clusterID string, log func(string, ...any)) error {
	is, err := db.ListIntegrations(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	for _, i := range is {
		if i.TargetClusterID != clusterID || !i.NomadSideEnabled {
			continue
		}
		locks, err := s.Nomad.RolloutLocks(ctx, i.SourceClusterID)
		if err != nil {
			return err
		}
		src := i.SourceClusterID
		task, err := s.Ops.Submit(ctx, ops.Spec{Action: "integration.vault_ca_rollout", TargetType: "cluster", TargetID: src,
			Locks: locks, TriggeredBy: "system:vault-ca-rotation", Params: map[string]any{"integration": i.Name},
			Run: func(ctx context.Context, t *ops.Task) error {
				// Nomad must trust the new Vault CA before Vault moves to it;
				// a single-server cluster restarts briefly for that.
				return s.Nomad.Rollout(ctx, t, src, "下发新的 Vault CA", true)
			}})
		if err != nil {
			return err
		}
		log("联动 %s：已提交 Nomad 侧 vault-ca.crt 滚动下发任务 %s（单 Server 集群会短暂中断），等待完成", i.Name, task.ID)
		if err := s.waitTask(ctx, task.ID); err != nil {
			if ctx.Err() != nil {
				s.Ops.Cancel(task.ID)
			}
			return fmt.Errorf("联动 %s 的 Nomad 侧 Vault CA 下发失败：%w", i.Name, err)
		}
		if err := s.markNomadSHA(ctx, i.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) waitTask(ctx context.Context, id string) error {
	for {
		t, err := db.GetTask(ctx, s.DB.Reader, id)
		if err != nil {
			return err
		}
		switch t.Status {
		case db.TaskPending, db.TaskRunning:
		case db.TaskSuccess:
			return nil
		default:
			return fmt.Errorf("任务 %s 结束状态 %s：%s", id, t.Status, t.ErrorMessage)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (s *Service) markNomadSHA(ctx context.Context, id string) error {
	l, err := s.load(ctx, id)
	if err != nil {
		return err
	}
	_, vaultAddr, _, err := s.addresses(ctx, l)
	if err != nil {
		return err
	}
	l.NomadConfigSHA256 = NomadSHA256(s.vaultSide(l, vaultAddr), l.dst.CACertPEM)
	return db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now())
}

// ---- Plan ----

// Plan is the preview of an Apply.
type Plan struct {
	Scope             string                    `json:"scope"` // vault_only | vault_and_nomad
	Errors            []string                  `json:"errors"`
	Warnings          []string                  `json:"warnings"`
	AuthPath          string                    `json:"auth_path"`
	JWKSURL           string                    `json:"jwks_url"`
	VaultAddress      string                    `json:"vault_address"`
	AuthConfig        map[string]any            `json:"auth_config"`
	Policies          map[string]string         `json:"policies"`
	Roles             map[string]map[string]any `json:"roles"`
	NomadServerHCL    string                    `json:"nomad_server_hcl"`
	NomadClientHCL    string                    `json:"nomad_client_hcl"`
	NomadConfigSHA256 string                    `json:"nomad_config_sha256"`
	MountAccessor     string                    `json:"mount_accessor,omitempty"`
}

// ownerTag marks the JWT auth mount as owned by an integration.
func ownerTag(id string) string { return "Managed by NomadDeck integration " + id }

// plan computes the preview and the checks; it does not change anything.
func (s *Service) plan(ctx context.Context, l *loaded) (*Plan, error) {
	p := &Plan{Errors: []string{}, Warnings: []string{}, AuthPath: l.AuthPath, Policies: map[string]string{},
		Roles: map[string]map[string]any{}}
	fail := func(format string, args ...any) { p.Errors = append(p.Errors, fmt.Sprintf(format, args...)) }
	jwksURL, vaultAddr, warns, err := s.addresses(ctx, l)
	if err != nil {
		return nil, err
	}
	p.JWKSURL, p.VaultAddress, p.Warnings = jwksURL, vaultAddr, append(p.Warnings, warns...)
	if l.src.InitState != db.InitInitialized {
		fail("Nomad 集群 %s 尚未完成部署", l.src.Name)
	}
	st := nomadSettings(l.src)
	if st.VerifyHTTPSClient && l.cfg.JWKSMode == "url" {
		fail("Nomad 集群开启了 verify_https_client，Vault 拉取 jwks_url 不支持客户端证书：请关闭 verify_https_client（或在 JWKS 路径前置受限只读代理并改用其地址），或切换为 static 公钥模式")
	}
	// Vault readiness and ownership.
	vstatus, health, err := s.Vault.SyncStatus(ctx, l.dst.ID)
	if err != nil {
		return nil, err
	}
	switch {
	case l.dst.InitState != db.InitInitialized:
		fail("Vault 集群 %s 尚未初始化", l.dst.Name)
	case health != "healthy":
		fail("Vault 集群状态为 %s，需全部节点已解封", health)
	}
	for _, n := range vstatus {
		if n.Reachable && n.Sealed {
			fail("Vault 节点 %s 处于密封状态", n.Name)
		}
	}
	accessor := "<mount_accessor>"
	if vc, err := s.Vault.AdminClient(ctx, l.dst.ID); err != nil {
		fail("Vault 运维 Token 不可用：%v", err)
	} else {
		if _, err := vc.LookupSelf(ctx); err != nil {
			fail("Vault 运维 Token 无效：%v", err)
		}
		mounts, err := vc.ListAuth(ctx)
		if err != nil {
			fail("读取 Vault Auth 挂载失败：%v", err)
		} else if mnt, ok := mounts[l.AuthPath+"/"]; ok {
			if mnt.Type != "jwt" || !strings.Contains(mnt.Description, ownerTag(l.ID)) {
				fail("Vault 上的 %s 已被其他用途占用（类型 %s，描述 %q），不能覆盖", l.AuthPath, mnt.Type, mnt.Description)
			}
			accessor, p.MountAccessor = mnt.Accessor, mnt.Accessor
		}
	}
	// JWKS reachability (from the control plane).
	if l.src.InitState == db.InitInitialized {
		if _, err := s.fetchJWKS(ctx, l, jwksURL); err != nil {
			fail("无法访问 Nomad JWKS 端点 %s：%v", jwksURL, err)
		}
	}
	p.AuthConfig = s.authConfigPreview(l, jwksURL)
	for _, r := range l.roles {
		sp := specOf(r)
		p.Policies[sp.Policy] = RenderPolicy(sp, accessor)
		p.Roles[sp.Name] = RenderRole(sp, l.cfg.Audience)
	}
	if len(l.roles) == 0 {
		p.Warnings = append(p.Warnings, "尚未添加工作负载 Role，Apply 只会建立 Auth 挂载与 Nomad 侧配置")
	}
	vs := s.vaultSide(l, vaultAddr)
	p.NomadServerHCL = RenderNomadVault(vs, nomad.RoleServer, "<generation>/tls/vault-ca.crt")
	p.NomadClientHCL = RenderNomadVault(vs, nomad.RoleClient, "<generation>/tls/vault-ca.crt")
	p.NomadConfigSHA256 = NomadSHA256(vs, l.dst.CACertPEM)
	p.Scope = "vault_only"
	if p.NomadConfigSHA256 != l.NomadConfigSHA256 || !l.NomadSideEnabled {
		p.Scope = "vault_and_nomad"
	}
	return p, nil
}

// PlanFor previews an Apply.
func (s *Service) PlanFor(ctx context.Context, id string) (*Plan, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.plan(ctx, l)
}

// fetchJWKS reads the Nomad JWKS document through the control plane's
// trust in the Nomad CA.
func (s *Service) fetchJWKS(ctx context.Context, l *loaded, jwksURL string) ([]byte, error) {
	ms, err := db.ListClusterNodes(ctx, s.DB.Reader, l.src.ID)
	if err != nil || len(ms) == 0 {
		return nil, errors.New("Nomad 集群没有成员")
	}
	c, err := s.Nomad.AnonClient(ctx, l.src.ID, ms[0])
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if _, err := JWKSToPEM(body); err != nil {
		return nil, err
	}
	return body, nil
}

func (s *Service) authConfigPreview(l *loaded, jwksURL string) map[string]any {
	cfg := map[string]any{"jwt_supported_algs": []string{"RS256", "EdDSA"}}
	if l.cfg.DefaultRole != "" {
		cfg["default_role"] = l.cfg.DefaultRole
	}
	if l.cfg.JWKSMode == "static" {
		cfg["jwt_validation_pubkeys"] = fmt.Sprintf("<%d 个从 Nomad JWKS 同步的公钥>", len(l.cfg.StaticKeys))
	} else {
		cfg["jwks_url"] = jwksURL
		if l.src.TLSEnabled {
			cfg["jwks_ca_pem"] = "<Nomad 集群 CA 信任链>"
		}
	}
	return cfg
}

// writeAuthConfig writes the JWT auth configuration (jwks_url with the
// Nomad CA, or static public keys merged with the previously published
// ones so tokens signed by a retiring key stay valid until they expire).
func (s *Service) writeAuthConfig(ctx context.Context, l *loaded, log func(string, ...any)) error {
	vc, err := s.Vault.AdminClient(ctx, l.dst.ID)
	if err != nil {
		return err
	}
	jwksURL, _, _, err := s.addresses(ctx, l)
	if err != nil {
		return err
	}
	cfg := map[string]any{"jwt_supported_algs": []string{"RS256", "EdDSA"}, "default_role": l.cfg.DefaultRole}
	if l.cfg.JWKSMode == "static" {
		doc, err := s.fetchJWKS(ctx, l, jwksURL)
		if err != nil {
			return err
		}
		keys, err := JWKSToPEM(doc)
		if err != nil {
			return err
		}
		now := time.Now().UTC().Format(time.RFC3339)
		known := map[string]bool{}
		var merged []StaticKey
		for _, k := range sortedKeys(keys) {
			merged = append(merged, StaticKey{KeyID: k, PEM: keys[k], LastSeen: now})
			known[k] = true
		}
		ttl, _ := time.ParseDuration(l.cfg.IdentityTTL)
		for _, old := range l.cfg.StaticKeys {
			seen, _ := time.Parse(time.RFC3339, old.LastSeen)
			if !known[old.KeyID] && time.Since(seen) < ttl+time.Hour {
				merged = append(merged, old) // retiring key: keep until its tokens expire
			}
		}
		var pems []string
		for _, k := range merged {
			pems = append(pems, k.PEM)
		}
		cfg["jwt_validation_pubkeys"] = pems
		l.cfg.StaticKeys = merged
		b, _ := json.Marshal(l.cfg)
		l.ConfigJSON = string(b)
		if err := db.UpdateIntegrationConfig(ctx, s.DB.Writer, l.Integration, s.DB.Now()); err != nil {
			return err
		}
		log("已同步 %d 个 Nomad 签名公钥（含保留中的退休公钥）", len(pems))
	} else {
		cfg["jwks_url"] = jwksURL
		if l.src.TLSEnabled {
			cfg["jwks_ca_pem"] = l.src.CACertPEM
		}
	}
	return vc.Request(ctx, http.MethodPost, "auth/"+l.AuthPath+"/config", cfg, nil)
}

// SyncStaticKeys refreshes the published public keys of a static-mode
// integration (scheduled for key rotation overlap).
func (s *Service) SyncStaticKeys(ctx context.Context, id string, log func(string, ...any)) error {
	l, err := s.load(ctx, id)
	if err != nil {
		return err
	}
	if l.cfg.JWKSMode != "static" || l.Status == "draft" {
		return nil
	}
	return s.writeAuthConfig(ctx, l, log)
}

// ---- Apply ----

func (s *Service) locks(ctx context.Context, l *loaded) ([]ops.LockReq, error) {
	locks, err := s.Nomad.RolloutLocks(ctx, l.src.ID)
	if err != nil {
		return nil, err
	}
	return append(locks, ops.LockReq{Key: ops.ClusterLock(l.dst.ID), Mode: ops.Exclusive}), nil
}

// ApplyInput starts an Apply.
type ApplyInput struct {
	ConfirmSingle bool `json:"confirm_single_node"`
}

// Apply pushes the integration: the Vault JWT mount, its configuration,
// every role and policy, and (only when the Nomad-side content changed)
// the Vault CA and 60-vault.hcl as a new config generation rolled out with
// restarts through the quorum gate. Both clusters are locked.
func (s *Service) Apply(ctx context.Context, actor audit.Actor, id string, in ApplyInput) (*db.OperationTask, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	p, err := s.plan(ctx, l)
	if err != nil {
		return nil, err
	}
	if len(p.Errors) > 0 {
		return nil, conflict("plan_failed", "预检未通过：\n%s", strings.Join(p.Errors, "\n"))
	}
	locks, err := s.locks(ctx, l)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "integration.apply", TargetType: "integration", TargetID: id, Locks: locks,
		TriggeredBy: actor.Name, Params: map[string]any{"scope": p.Scope, "roles": len(l.roles)},
		Run: func(ctx context.Context, t *ops.Task) error {
			err := s.runApply(ctx, t, id, in)
			if err != nil {
				if l, e := s.load(ctx, id); e == nil {
					l.Status = "failed"
					_ = db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now())
				}
			}
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.apply", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name, OperationTaskID: task.ID, Summary: map[string]any{"scope": p.Scope}})
	return task, nil
}

func (s *Service) runApply(ctx context.Context, t *ops.Task, id string, in ApplyInput) error {
	l, err := s.load(ctx, id)
	if err != nil {
		return err
	}
	step, err := t.Step("Vault 侧：JWT Auth 挂载与配置", "")
	if err != nil {
		return err
	}
	var accessor string
	err = func() error {
		vc, err := s.Vault.AdminClient(ctx, l.dst.ID)
		if err != nil {
			return err
		}
		mounts, err := vc.ListAuth(ctx)
		if err != nil {
			return err
		}
		mnt, ok := mounts[l.AuthPath+"/"]
		if !ok {
			if err := vc.EnableAuth(ctx, l.AuthPath, "jwt", ownerTag(l.ID)); err != nil {
				return fmt.Errorf("启用 JWT Auth 挂载失败：%w", err)
			}
			step.Logf("已启用 JWT Auth 挂载 %s", l.AuthPath)
			if mounts, err = vc.ListAuth(ctx); err != nil {
				return err
			}
			mnt = mounts[l.AuthPath+"/"]
		} else if mnt.Type != "jwt" || !strings.Contains(mnt.Description, ownerTag(l.ID)) {
			return conflict("auth_path_taken", "Vault 上的 %s 已被其他用途占用", l.AuthPath)
		}
		accessor = mnt.Accessor
		if err := s.writeAuthConfig(ctx, l, step.Logf); err != nil {
			return fmt.Errorf("写入 JWT Auth 配置失败：%w", err)
		}
		step.Logf("JWT Auth 配置已写入（%s）", l.cfg.JWKSMode)
		return nil
	}()
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	if len(l.roles) > 0 {
		step, err = t.Step("Vault 侧：工作负载 Role 与 Policy", "")
		if err != nil {
			return err
		}
		err = func() error {
			vc, err := s.Vault.AdminClient(ctx, l.dst.ID)
			if err != nil {
				return err
			}
			for _, r := range l.roles {
				sp := specOf(r)
				if err := vc.PutPolicy(ctx, sp.Policy, RenderPolicy(sp, accessor)); err != nil {
					_ = db.SetRoleStatus(ctx, s.DB.Writer, r.ID, "failed", s.DB.Now())
					return fmt.Errorf("写入 Policy %s 失败：%w", sp.Policy, err)
				}
				if err := vc.Request(ctx, http.MethodPost, "auth/"+l.AuthPath+"/role/"+sp.Name, RenderRole(sp, l.cfg.Audience), nil); err != nil {
					_ = db.SetRoleStatus(ctx, s.DB.Writer, r.ID, "failed", s.DB.Now())
					return fmt.Errorf("写入 Role %s 失败：%w", sp.Name, err)
				}
				_ = db.SetRoleStatus(ctx, s.DB.Writer, r.ID, "applied", s.DB.Now())
				step.Logf("Role %s（%s，bound_claims %v）与 Policy %s 已写入", sp.Name, sp.Mode, sp.BoundClaims, sp.Policy)
			}
			return nil
		}()
		step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	_, vaultAddr, _, err := s.addresses(ctx, l)
	if err != nil {
		return err
	}
	sha := NomadSHA256(s.vaultSide(l, vaultAddr), l.dst.CACertPEM)
	if sha != l.NomadConfigSHA256 || !l.NomadSideEnabled {
		l.NomadSideEnabled = true
		l.Status = "failed" // until the rollout completes
		if err := db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now()); err != nil {
			return err
		}
		if err := s.Nomad.Rollout(ctx, t, l.src.ID, "下发 Vault 联动配置", in.ConfirmSingle); err != nil {
			return err
		}
		l.NomadConfigSHA256 = sha
	} else {
		step, _ := t.Step("Nomad 侧配置未变化，不重启任何 Nomad 节点", "")
		if step != nil {
			step.Finish(nil, nil)
		}
	}
	l.Status, l.LastAppliedAt = "applied", s.DB.Now()
	return db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now())
}

// ---- Delete ----

// Delete tears an integration down: the Nomad side is removed with a
// rolling rollout, then the roles, policies and the owned JWT mount are
// removed from Vault, and the record deleted.
func (s *Service) Delete(ctx context.Context, actor audit.Actor, id string, in ApplyInput) (*db.OperationTask, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	if l.Status == "draft" && !l.NomadSideEnabled {
		if err := db.DeleteIntegration(ctx, s.DB.Writer, id); err != nil {
			return nil, err
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.delete", ResourceType: "integration", ResourceID: id,
			ResourceName: l.Name})
		return nil, nil
	}
	locks, err := s.locks(ctx, l)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "integration.delete", TargetType: "integration", TargetID: id, Locks: locks,
		TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			l, err := s.load(ctx, id)
			if err != nil {
				return err
			}
			if l.NomadSideEnabled {
				l.NomadSideEnabled = false
				if err := db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now()); err != nil {
					return err
				}
				if err := s.Nomad.Rollout(ctx, t, l.src.ID, "移除 Vault 联动配置", in.ConfirmSingle); err != nil {
					l.NomadSideEnabled = true
					_ = db.UpdateIntegrationState(ctx, s.DB.Writer, l.Integration, s.DB.Now())
					return err
				}
			}
			step, err := t.Step("Vault 侧：移除 Role、Policy 与 JWT Auth 挂载", "")
			if err != nil {
				return err
			}
			err = func() error {
				vc, err := s.Vault.AdminClient(ctx, l.dst.ID)
				if err != nil {
					return err
				}
				for _, r := range l.roles {
					if err := vc.DeletePolicy(ctx, r.PolicyName); err != nil && vault.StatusOf(err) != 404 {
						return err
					}
				}
				mounts, err := vc.ListAuth(ctx)
				if err != nil {
					return err
				}
				if mnt, ok := mounts[l.AuthPath+"/"]; ok && strings.Contains(mnt.Description, ownerTag(l.ID)) {
					if err := vc.DisableAuth(ctx, l.AuthPath); err != nil {
						return err
					}
					step.Logf("已禁用 JWT Auth 挂载 %s（其下 Role 一并删除）", l.AuthPath)
				}
				return nil
			}()
			step.Finish(err, nil)
			if err != nil {
				return err
			}
			return db.DeleteIntegration(ctx, s.DB.Writer, id)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.delete", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name, OperationTaskID: task.ID})
	return task, nil
}

// JobExample renders a test job for a role.
func (s *Service) JobExample(ctx context.Context, id, roleID, secretPath string) (string, error) {
	return s.JobExampleWithOptions(ctx, id, roleID, JobExampleOptions{SecretPath: secretPath})
}

// JobExampleWithOptions renders an example job for a role with delivery options.
func (s *Service) JobExampleWithOptions(ctx context.Context, id, roleID string, opt JobExampleOptions) (string, error) {
	switch opt.TemplateKind {
	case "", "probe", "docker_env", "docker_file":
	default:
		return "", badRequest("template_kind 需为 probe、docker_env 或 docker_file")
	}
	l, err := s.load(ctx, id)
	if err != nil {
		return "", err
	}
	for _, r := range l.roles {
		if r.ID == roleID || r.RoleName == roleID {
			sp := specOf(r)
			if opt.SecretPath == "" && sp.Mode == "explicit" && len(sp.SecretPaths) > 0 && !strings.Contains(sp.SecretPaths[0], "*") {
				opt.SecretPath = sp.SecretPaths[0]
			}
			return JobExampleWithOptions(sp, opt), nil
		}
	}
	return "", &auth.Error{Status: 404, Code: "not_found", Message: "Role 不存在"}
}
