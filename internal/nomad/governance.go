package nomad

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

// Governance objects (namespaces, node pools, ACL policies, roles and
// tokens) are managed through the Nomad HTTP API with the control plane's
// management token.

var reObjectName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// nomadErr maps Nomad API errors to API errors.
func nomadErr(err error) error {
	var ae *APIError
	if !errors.As(err, &ae) {
		return err
	}
	switch {
	case ae.Status == 404:
		return &auth.Error{Status: 404, Code: "not_found", Message: "Nomad 返回：对象不存在"}
	case ae.Status == 400 || ae.Status == 409:
		return &auth.Error{Status: 400, Code: "nomad_rejected", Message: "Nomad 拒绝了请求：" + ae.Message}
	case ae.Status == 403:
		return &auth.Error{Status: 502, Code: "nomad_permission", Message: "托管的 Management Token 被拒绝：" + ae.Message}
	}
	return &auth.Error{Status: 502, Code: "nomad_error", Message: ae.Error()}
}

// govClient returns a management client for an operable cluster.
func (s *Service) govClient(ctx context.Context, clusterID string) (*Client, *nomadCluster, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, nil, conflict("not_initialized", "集群尚未完成部署与 ACL Bootstrap")
	}
	api, _, err := s.apiClient(ctx, cl, "")
	return api, cl, err
}

func (s *Service) govAudit(ctx context.Context, actor audit.Actor, cl *nomadCluster, action string, summary map[string]any) {
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: action, ResourceType: "cluster", ResourceID: cl.ID,
		ResourceName: cl.Name, Summary: summary})
}

func validName(kind, name string) error {
	if !reObjectName.MatchString(name) {
		return badRequest("%s名称需为 1～128 位字母、数字、下划线或连字符", kind)
	}
	return nil
}

func validMeta(meta map[string]string) error {
	for k, v := range meta {
		if !reMetaKey.MatchString(k) || len(v) > 1024 {
			return badRequest("Meta %q 不合法", k)
		}
	}
	return nil
}

// ---- Namespaces ----

// Namespace is a Nomad namespace.
type Namespace struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Meta        map[string]string `json:"meta,omitempty"`
}

// ListNamespaces lists namespaces.
func (s *Service) ListNamespaces(ctx context.Context, clusterID string) ([]Namespace, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name        string            `json:"Name"`
		Description string            `json:"Description"`
		Meta        map[string]string `json:"Meta"`
	}
	if err := api.Request(ctx, http.MethodGet, "namespaces", nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []Namespace{}
	for _, n := range raw {
		out = append(out, Namespace{Name: n.Name, Description: n.Description, Meta: n.Meta})
	}
	return out, nil
}

// PutNamespace creates or updates a namespace.
func (s *Service) PutNamespace(ctx context.Context, actor audit.Actor, clusterID string, ns Namespace, create bool) error {
	if err := validName("Namespace ", ns.Name); err != nil {
		return err
	}
	if len(ns.Description) > 256 {
		return badRequest("描述最长 256 个字符")
	}
	if err := validMeta(ns.Meta); err != nil {
		return err
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	path := "namespace/" + url.PathEscape(ns.Name)
	exists := api.Request(ctx, http.MethodGet, path, nil, nil) == nil
	if create && exists {
		return conflict("exists", "Namespace %s 已存在", ns.Name)
	}
	if !create && !exists {
		return &auth.Error{Status: 404, Code: "not_found", Message: "Namespace 不存在"}
	}
	body := map[string]any{"Name": ns.Name, "Description": ns.Description, "Meta": ns.Meta}
	if err := api.Request(ctx, http.MethodPost, path, body, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.namespace_put", map[string]any{"namespace": ns.Name, "create": create})
	return nil
}

type jobStub struct {
	ID        string `json:"ID"`
	Namespace string `json:"Namespace"`
	Status    string `json:"Status"`
	NodePool  string `json:"NodePool"`
}

// DeleteNamespace deletes a namespace that has no live jobs.
func (s *Service) DeleteNamespace(ctx context.Context, actor audit.Actor, clusterID, name string) error {
	if name == "default" {
		return conflict("builtin", "default Namespace 不能删除")
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	var jobs []jobStub
	if err := api.Request(ctx, http.MethodGet, "jobs?namespace="+url.QueryEscape(name), nil, &jobs); err != nil {
		return nomadErr(err)
	}
	for _, j := range jobs {
		if j.Status != "dead" {
			return conflict("namespace_in_use", "Namespace %s 中还有未停止的 Job（%s），不能删除", name, j.ID)
		}
	}
	if err := api.Request(ctx, http.MethodDelete, "namespace/"+url.PathEscape(name), nil, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.namespace_delete", map[string]any{"namespace": name})
	return nil
}

// ---- Node pools ----

// NodePool is a Nomad node pool with usage counts.
type NodePool struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Meta        map[string]string `json:"meta,omitempty"`
	Builtin     bool              `json:"builtin"`
	Nodes       int               `json:"nodes"`
	RunningJobs int               `json:"running_jobs"`
}

// ListNodePools lists node pools with node and running job counts.
func (s *Service) ListNodePools(ctx context.Context, clusterID string) ([]NodePool, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name        string            `json:"Name"`
		Description string            `json:"Description"`
		Meta        map[string]string `json:"Meta"`
	}
	if err := api.Request(ctx, http.MethodGet, "node/pools", nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	nodes, _ := api.Nodes(ctx)
	var jobs []jobStub
	_ = api.Request(ctx, http.MethodGet, "jobs?namespace=*", nil, &jobs)
	out := []NodePool{}
	for _, p := range raw {
		np := NodePool{Name: p.Name, Description: p.Description, Meta: p.Meta, Builtin: p.Name == "all" || p.Name == "default"}
		for _, n := range nodes {
			if n.NodePool == p.Name || p.Name == "all" {
				np.Nodes++
			}
		}
		for _, j := range jobs {
			if j.NodePool == p.Name && j.Status != "dead" {
				np.RunningJobs++
			}
		}
		out = append(out, np)
	}
	return out, nil
}

// PutNodePool creates or updates a node pool.
func (s *Service) PutNodePool(ctx context.Context, actor audit.Actor, clusterID string, np NodePool, create bool) error {
	if err := validName("Node Pool ", np.Name); err != nil {
		return err
	}
	if np.Name == "all" || (np.Name == "default" && create) {
		return conflict("builtin", "内置 Node Pool %s 不能创建或修改", np.Name)
	}
	if err := validMeta(np.Meta); err != nil {
		return err
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	exists := api.Request(ctx, http.MethodGet, "node/pool/"+url.PathEscape(np.Name), nil, nil) == nil
	if create && exists {
		return conflict("exists", "Node Pool %s 已存在", np.Name)
	}
	if !create && !exists {
		return &auth.Error{Status: 404, Code: "not_found", Message: "Node Pool 不存在"}
	}
	body := map[string]any{"Name": np.Name, "Description": np.Description, "Meta": np.Meta}
	if err := api.Request(ctx, http.MethodPost, "node/pools", body, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.node_pool_put", map[string]any{"node_pool": np.Name, "create": create})
	return nil
}

// DeleteNodePool deletes a node pool that no node or live job references.
func (s *Service) DeleteNodePool(ctx context.Context, actor audit.Actor, clusterID, name string) error {
	if name == "all" || name == "default" {
		return conflict("builtin", "内置 Node Pool %s 不能删除", name)
	}
	pools, err := s.ListNodePools(ctx, clusterID)
	if err != nil {
		return err
	}
	for _, p := range pools {
		if p.Name == name && (p.Nodes > 0 || p.RunningJobs > 0) {
			return conflict("node_pool_in_use", "Node Pool %s 仍有 %d 个节点、%d 个运行中的 Job，不能删除", name, p.Nodes, p.RunningJobs)
		}
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := api.Request(ctx, http.MethodDelete, "node/pool/"+url.PathEscape(name), nil, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.node_pool_delete", map[string]any{"node_pool": name})
	return nil
}

// ---- ACL policies ----

// ACLPolicy is a Nomad ACL policy.
type ACLPolicy struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Rules       string `json:"rules,omitempty"`
}

// PolicyTemplates are starting points for common ACL policies.
var PolicyTemplates = []ACLPolicy{
	{Name: "readonly-operator", Description: "只读运维：查看全部 Namespace 的 Job、节点与 Agent 状态", Rules: `namespace "*" {
  policy = "read"
}

node {
  policy = "read"
}

agent {
  policy = "read"
}

operator {
  policy = "read"
}

node_pool "*" {
  policy = "read"
}
`},
	{Name: "deployer-<namespace>", Description: "单 Namespace 部署者：在指定 Namespace 中提交、管理 Job 与读取日志", Rules: `namespace "<namespace>" {
  policy       = "write"
  capabilities = ["alloc-lifecycle", "read-logs"]
}

node {
  policy = "read"
}

node_pool "*" {
  policy = "read"
}
`},
}

// ValidatePolicyHCL checks that policy rules parse as HCL.
func ValidatePolicyHCL(rules string) error {
	if strings.TrimSpace(rules) == "" {
		return badRequest("策略内容不能为空")
	}
	if len(rules) > 64<<10 {
		return badRequest("策略内容过长")
	}
	if _, diags := hclsyntax.ParseConfig([]byte(rules), "policy.hcl", hcl.InitialPos); diags.HasErrors() {
		return badRequest("策略 HCL 语法错误：%s", diags.Error())
	}
	return nil
}

// ListPolicies lists ACL policies (names and descriptions).
func (s *Service) ListPolicies(ctx context.Context, clusterID string) ([]ACLPolicy, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name        string `json:"Name"`
		Description string `json:"Description"`
	}
	if err := api.Request(ctx, http.MethodGet, "acl/policies", nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []ACLPolicy{}
	for _, p := range raw {
		out = append(out, ACLPolicy{Name: p.Name, Description: p.Description})
	}
	return out, nil
}

// GetPolicy reads one ACL policy with its rules.
func (s *Service) GetPolicy(ctx context.Context, clusterID, name string) (*ACLPolicy, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Name        string `json:"Name"`
		Description string `json:"Description"`
		Rules       string `json:"Rules"`
	}
	if err := api.Request(ctx, http.MethodGet, "acl/policy/"+url.PathEscape(name), nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	return &ACLPolicy{Name: raw.Name, Description: raw.Description, Rules: raw.Rules}, nil
}

// PutPolicy creates or updates an ACL policy after local HCL validation;
// Nomad validates the policy semantics.
func (s *Service) PutPolicy(ctx context.Context, actor audit.Actor, clusterID string, p ACLPolicy) error {
	if err := validName("策略", p.Name); err != nil {
		return err
	}
	if err := ValidatePolicyHCL(p.Rules); err != nil {
		return err
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	body := map[string]any{"Name": p.Name, "Description": p.Description, "Rules": p.Rules}
	if err := api.Request(ctx, http.MethodPost, "acl/policy/"+url.PathEscape(p.Name), body, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_policy_put", map[string]any{"policy": p.Name})
	return nil
}

// DeletePolicy deletes an ACL policy.
func (s *Service) DeletePolicy(ctx context.Context, actor audit.Actor, clusterID, name string) error {
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := api.Request(ctx, http.MethodDelete, "acl/policy/"+url.PathEscape(name), nil, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_policy_delete", map[string]any{"policy": name})
	return nil
}

// ---- ACL roles ----

// ACLRole is a Nomad ACL role aggregating policies.
type ACLRole struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Policies    []string `json:"policies"`
}

type rawRole struct {
	ID          string `json:"ID,omitempty"`
	Name        string `json:"Name"`
	Description string `json:"Description"`
	Policies    []struct {
		Name string `json:"Name"`
	} `json:"Policies"`
}

func (r rawRole) view() ACLRole {
	out := ACLRole{ID: r.ID, Name: r.Name, Description: r.Description, Policies: []string{}}
	for _, p := range r.Policies {
		out.Policies = append(out.Policies, p.Name)
	}
	return out
}

// ListRoles lists ACL roles.
func (s *Service) ListRoles(ctx context.Context, clusterID string) ([]ACLRole, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []rawRole
	if err := api.Request(ctx, http.MethodGet, "acl/roles", nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []ACLRole{}
	for _, r := range raw {
		out = append(out, r.view())
	}
	return out, nil
}

// PutRole creates (empty ID) or updates an ACL role.
func (s *Service) PutRole(ctx context.Context, actor audit.Actor, clusterID string, r ACLRole) (*ACLRole, error) {
	if err := validName("角色", r.Name); err != nil {
		return nil, err
	}
	if len(r.Policies) == 0 {
		return nil, badRequest("角色至少需要关联一个策略")
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var links []map[string]string
	for _, p := range r.Policies {
		if err := validName("策略", p); err != nil {
			return nil, err
		}
		links = append(links, map[string]string{"Name": p})
	}
	body := map[string]any{"Name": r.Name, "Description": r.Description, "Policies": links}
	path := "acl/role"
	if r.ID != "" {
		body["ID"] = r.ID
		path += "/" + url.PathEscape(r.ID)
	}
	var out rawRole
	if err := api.Request(ctx, http.MethodPost, path, body, &out); err != nil {
		return nil, nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_role_put", map[string]any{"role": r.Name, "policies": r.Policies, "create": r.ID == ""})
	v := out.view()
	return &v, nil
}

// DeleteRole deletes an ACL role.
func (s *Service) DeleteRole(ctx context.Context, actor audit.Actor, clusterID, id string) error {
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	if err := api.Request(ctx, http.MethodDelete, "acl/role/"+url.PathEscape(id), nil, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_role_delete", map[string]any{"role_id": id})
	return nil
}

// ---- ACL tokens ----

// TokenView is an ACL token without its secret.
type TokenView struct {
	AccessorID     string     `json:"accessor_id"`
	Name           string     `json:"name"`
	Type           string     `json:"type"`
	Policies       []string   `json:"policies"`
	Roles          []string   `json:"roles"`
	CreateTime     time.Time  `json:"create_time"`
	ExpirationTime *time.Time `json:"expiration_time,omitempty"`
}

func tokenView(t ACLToken) TokenView {
	v := TokenView{AccessorID: t.AccessorID, Name: t.Name, Type: t.Type, Policies: t.Policies, Roles: []string{},
		CreateTime: t.CreateTime, ExpirationTime: t.ExpirationTime}
	if v.Policies == nil {
		v.Policies = []string{}
	}
	for _, r := range t.Roles {
		v.Roles = append(v.Roles, r.Name)
	}
	return v
}

// ListTokens lists ACL tokens, never exposing secrets and omitting the
// control plane's own management token.
func (s *Service) ListTokens(ctx context.Context, clusterID string) ([]TokenView, error) {
	api, _, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	self, err := api.TokenSelf(ctx)
	if err != nil {
		return nil, nomadErr(err)
	}
	var raw []ACLToken
	if err := api.Request(ctx, http.MethodGet, "acl/tokens", nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []TokenView{}
	for _, t := range raw {
		if t.AccessorID == self.AccessorID {
			continue
		}
		out = append(out, tokenView(t))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreateTime.After(out[j].CreateTime) })
	return out, nil
}

// TokenInput issues a client token.
type TokenInput struct {
	Name     string   `json:"name"`
	Policies []string `json:"policies"`
	Roles    []string `json:"roles"`
	// TTL is the token lifetime (e.g. 720h); empty means no expiry.
	TTL string `json:"ttl"`
}

// IssuedToken is an ACL token with its SecretID (returned on creation or
// password-verified reveal; the secret is never persisted in the control plane DB).
type IssuedToken struct {
	TokenView
	SecretID string `json:"secret_id"`
}

// CreateToken issues a client token bound to policies and/or roles.
func (s *Service) CreateToken(ctx context.Context, actor audit.Actor, clusterID string, in TokenInput) (*IssuedToken, error) {
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 128 {
		return nil, badRequest("请填写 Token 名称（最长 128 个字符）")
	}
	if len(in.Policies) == 0 && len(in.Roles) == 0 {
		return nil, badRequest("Token 至少需要绑定一个策略或角色")
	}
	if in.TTL != "" {
		d, err := time.ParseDuration(in.TTL)
		if err != nil || d < time.Minute {
			return nil, badRequest("有效期格式不正确（至少 1m，如 720h）")
		}
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"Name": in.Name, "Type": "client", "Policies": in.Policies, "Global": false}
	var roles []map[string]string
	for _, r := range in.Roles {
		roles = append(roles, map[string]string{"Name": r})
	}
	if roles != nil {
		body["Roles"] = roles
	}
	if in.TTL != "" {
		body["ExpirationTTL"] = in.TTL
	}
	var t ACLToken
	if err := api.Request(ctx, http.MethodPost, "acl/token", body, &t); err != nil {
		return nil, nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_token_create", map[string]any{"accessor_id": t.AccessorID, "name": in.Name,
		"policies": in.Policies, "roles": in.Roles, "ttl": in.TTL})
	return &IssuedToken{TokenView: tokenView(t), SecretID: t.SecretID}, nil
}

// RevealToken reads a single ACL token (including its SecretID) from Nomad for
// audited admin access. The control plane's own management token is protected
// and must be revealed through RevealManagementToken instead.
func (s *Service) RevealToken(ctx context.Context, actor audit.Actor, clusterID, accessor string) (*IssuedToken, error) {
	accessor = strings.TrimSpace(accessor)
	if accessor == "" {
		return nil, badRequest("缺少 Token Accessor ID")
	}
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	self, err := api.TokenSelf(ctx)
	if err != nil {
		return nil, nomadErr(err)
	}
	if self.AccessorID == accessor {
		return nil, conflict("protected_token", "请通过「查看 Management Token」入口查看控制面自身持有的 Management Token")
	}
	var t ACLToken
	if err := api.Request(ctx, http.MethodGet, "acl/token/"+url.PathEscape(accessor), nil, &t); err != nil {
		return nil, nomadErr(err)
	}
	if t.SecretID == "" {
		return nil, &auth.Error{Status: 502, Code: "nomad_error", Message: "Nomad 未返回该 Token 的 Secret ID"}
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_token_reveal", map[string]any{
		"accessor_id": t.AccessorID,
		"name":        t.Name,
		"type":        t.Type,
	})
	return &IssuedToken{TokenView: tokenView(t), SecretID: t.SecretID}, nil
}

// RevokeToken deletes a token; the control plane's own token is protected.
func (s *Service) RevokeToken(ctx context.Context, actor audit.Actor, clusterID, accessor string) error {
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return err
	}
	self, err := api.TokenSelf(ctx)
	if err != nil {
		return nomadErr(err)
	}
	if self.AccessorID == accessor {
		return conflict("protected_token", "不能吊销控制面自身持有的 Management Token")
	}
	if err := api.Request(ctx, http.MethodDelete, "acl/token/"+url.PathEscape(accessor), nil, nil); err != nil {
		return nomadErr(err)
	}
	s.govAudit(ctx, actor, cl, "nomad.acl_token_revoke", map[string]any{"accessor_id": accessor})
	return nil
}

// UILoginLink is a short-lived single-use Nomad UI login URL backed by an OTT.
type UILoginLink struct {
	LoginURL      string `json:"login_url"`
	OTTTTLSeconds int    `json:"ott_ttl_seconds"`
	TokenTTL      string `json:"token_ttl"`
}

// CreateUILogin mints a short-lived (1h) temporary management token, wraps it
// in a Nomad single-use one-time token (OTT), and returns the Nomad UI URL
// carrying ?ott=... so the UI automatically exchanges and clears the query param.
func (s *Service) CreateUILogin(ctx context.Context, actor audit.Actor, clusterID, targetURL string) (*UILoginLink, error) {
	api, cl, err := s.govClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.MaintenanceMode {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	if cl.Settings.UI.Disabled {
		return nil, conflict("ui_disabled", "Nomad 原生 UI 已在集群配置中停用")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	baseURL, err := s.resolveUIBaseURL(ctx, cl, members, targetURL)
	if err != nil {
		return nil, err
	}
	const tokenTTL = "1h"
	var temp ACLToken
	reqBody := map[string]any{
		"Name":          "nomad-deck-ui-" + actor.Name,
		"Type":          "management",
		"Global":        false,
		"ExpirationTTL": tokenTTL,
	}
	if err := api.Request(ctx, http.MethodPost, "acl/token", reqBody, &temp); err != nil {
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.ui_login_link", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"target_url": baseURL}, Err: err})
		return nil, nomadErr(err)
	}
	ott, ottErr := api.WithToken(temp.SecretID).CreateOneTimeToken(ctx)
	if ottErr != nil {
		_ = api.Request(ctx, http.MethodDelete, "acl/token/"+url.PathEscape(temp.AccessorID), nil, nil)
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.ui_login_link", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"target_url": baseURL}, Err: ottErr})
		return nil, nomadErr(ottErr)
	}
	ttlSec := int(time.Until(ott.ExpiresAt).Seconds())
	if ttlSec <= 0 {
		ttlSec = 600
	}
	loginURL := strings.TrimRight(baseURL, "/") + "/ui/?ott=" + url.QueryEscape(ott.OneTimeSecretID)
	s.govAudit(ctx, actor, cl, "nomad.ui_login_link", map[string]any{"target_url": baseURL, "token_ttl": tokenTTL, "accessor_id": temp.AccessorID})
	return &UILoginLink{LoginURL: loginURL, OTTTTLSeconds: ttlSec, TokenTTL: tokenTTL}, nil
}

func (s *Service) resolveUIBaseURL(ctx context.Context, cl *nomadCluster, members []*db.ClusterNode, targetURL string) (string, error) {
	req := strings.TrimRight(strings.TrimSpace(targetURL), "/")
	if req == "" {
		if pub := strings.TrimRight(strings.TrimSpace(cl.PublicAPIURL), "/"); pub != "" {
			return pub, nil
		}
		if leader := s.leaderMember(ctx, cl, members); leader != nil && leader.APIAddr != "" {
			return strings.TrimRight(strings.TrimSpace(leader.APIAddr), "/"), nil
		}
		for _, m := range servers(members) {
			if api := strings.TrimRight(strings.TrimSpace(m.APIAddr), "/"); api != "" {
				return api, nil
			}
		}
		return "", conflict("no_server", "没有可用的 Nomad Server 入口")
	}
	if pub := strings.TrimRight(strings.TrimSpace(cl.PublicAPIURL), "/"); pub != "" && req == pub {
		return pub, nil
	}
	for _, m := range members {
		if api := strings.TrimRight(strings.TrimSpace(m.APIAddr), "/"); api != "" && req == api {
			return api, nil
		}
		if adv := strings.TrimRight(strings.TrimSpace(m.AdvertiseAddr), "/"); adv != "" && req == adv {
			return adv, nil
		}
	}
	return "", badRequest("目标地址不属于当前 Nomad 集群")
}
