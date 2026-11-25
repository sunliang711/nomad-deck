package vault

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

// vaultErr maps Vault API errors to HTTP errors for the management API.
func vaultErr(err error) error {
	if err == nil {
		return nil
	}
	var ae *APIError
	if !errors.As(err, &ae) {
		var he *auth.Error
		if errors.As(err, &he) {
			return err
		}
		return &auth.Error{Status: 502, Code: "vault_unreachable", Message: "无法访问 Vault：" + err.Error()}
	}
	msg := strings.Join(ae.Errors, "; ")
	switch {
	case ae.HasMessage("check-and-set parameter did not match"):
		return &auth.Error{Status: 409, Code: "cas_mismatch", Message: "数据已被他人修改（CAS 版本不匹配），请刷新后重新读取再保存"}
	case ae.Status == 404:
		return &auth.Error{Status: 404, Code: "not_found", Message: "Vault 中不存在该对象"}
	case ae.Status == 400:
		return &auth.Error{Status: 400, Code: "vault_rejected", Message: "Vault 拒绝了请求：" + msg}
	case ae.Status == 403:
		return &auth.Error{Status: 502, Code: "vault_permission_denied", Message: "运维 Token 权限不足或已失效：" + msg}
	default:
		return &auth.Error{Status: 502, Code: "vault_error", Message: "Vault 返回错误：" + msg}
	}
}

func (s *Service) bizClient(ctx context.Context, clusterID string) (*Client, *cluster, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	c, _, err := s.adminClient(ctx, cl)
	if err != nil {
		return nil, nil, err
	}
	return c, cl, nil
}

var (
	reMountPath  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*/?$`)
	rePolicyName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	reAuthType   = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
)

func cleanPath(p string) (string, error) {
	p = strings.Trim(strings.TrimSpace(p), "/")
	if p == "" {
		return "", nil
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, "?#%\\") {
			return "", badRequest("路径 %q 不合法", p)
		}
	}
	return p, nil
}

// ---- Auth methods ----

// AuthMount is an auth method mount.
type AuthMount struct {
	Path        string `json:"path"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Accessor    string `json:"accessor"`
}

// ListAuth lists auth methods.
func (s *Service) ListAuth(ctx context.Context, clusterID string) ([]AuthMount, error) {
	c, _, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	ms, err := c.ListAuth(ctx)
	if err != nil {
		return nil, vaultErr(err)
	}
	out := []AuthMount{}
	for p, m := range ms {
		out = append(out, AuthMount{Path: p, Type: m.Type, Description: m.Description, Accessor: m.Accessor})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// EnableAuth enables an auth method.
func (s *Service) EnableAuth(ctx context.Context, actor audit.Actor, clusterID, path, typ, description string) error {
	path = strings.Trim(path, "/")
	if !reMountPath.MatchString(path) || !reAuthType.MatchString(typ) || len(description) > 500 {
		return badRequest("Auth 路径或类型不合法")
	}
	c, cl, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return err
	}
	err = vaultErr(c.EnableAuth(ctx, path, typ, description))
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.auth_enable", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"path": path, "type": typ}, Err: err})
	return err
}

// DisableAuth disables an auth method (the token method is protected).
func (s *Service) DisableAuth(ctx context.Context, actor audit.Actor, clusterID, path string) error {
	path = strings.Trim(path, "/")
	if path == "token" || !reMountPath.MatchString(path) {
		return badRequest("不能禁用该 Auth 方法")
	}
	c, cl, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return err
	}
	err = vaultErr(c.DisableAuth(ctx, path))
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.auth_disable", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"path": path}, Err: err})
	return err
}

// ---- Policies ----

var protectedPolicies = map[string]bool{"root": true, "default": true, AdminPolicyName: true}

// ListPolicies lists ACL policies.
func (s *Service) ListPolicies(ctx context.Context, clusterID string) ([]string, error) {
	c, _, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	ps, err := c.ListPolicies(ctx)
	if ps == nil {
		ps = []string{}
	}
	return ps, vaultErr(err)
}

// GetPolicy reads an ACL policy.
func (s *Service) GetPolicy(ctx context.Context, clusterID, name string) (string, error) {
	if !rePolicyName.MatchString(name) {
		return "", badRequest("Policy 名称不合法")
	}
	c, _, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return "", err
	}
	p, err := c.GetPolicy(ctx, name)
	return p, vaultErr(err)
}

// PutPolicy writes an ACL policy (managed policies are protected).
func (s *Service) PutPolicy(ctx context.Context, actor audit.Actor, clusterID, name, hcl string) error {
	if !rePolicyName.MatchString(name) || protectedPolicies[name] {
		return badRequest("Policy 名称不合法或受保护")
	}
	if strings.TrimSpace(hcl) == "" || len(hcl) > 256<<10 {
		return badRequest("Policy 内容为空或过长")
	}
	if err := ValidateHCL(name+".hcl", hcl); err != nil {
		return badRequest("Policy HCL 语法错误：%v", err)
	}
	c, cl, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return err
	}
	err = vaultErr(c.PutPolicy(ctx, name, hcl))
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.policy_put", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"policy": name}, Err: err})
	return err
}

// DeletePolicy deletes an ACL policy.
func (s *Service) DeletePolicy(ctx context.Context, actor audit.Actor, clusterID, name string) error {
	if !rePolicyName.MatchString(name) || protectedPolicies[name] {
		return badRequest("Policy 名称不合法或受保护")
	}
	c, cl, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return err
	}
	err = vaultErr(c.DeletePolicy(ctx, name))
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.policy_delete", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"policy": name}, Err: err})
	return err
}

// ---- KV ----

// KVMount is a KV secrets engine.
type KVMount struct {
	Path        string `json:"path"`
	Version     int    `json:"version"`
	Description string `json:"description"`
}

// KVMounts lists KV engines (nested mount paths included).
func (s *Service) KVMounts(ctx context.Context, clusterID string) ([]KVMount, error) {
	c, _, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	ms, err := c.ListMounts(ctx)
	if err != nil {
		return nil, vaultErr(err)
	}
	out := []KVMount{}
	for p, m := range ms {
		if m.Type != "kv" && m.Type != "generic" {
			continue
		}
		v := 1
		if m.Options["version"] == "2" {
			v = 2
		}
		out = append(out, KVMount{Path: strings.TrimSuffix(p, "/"), Version: v, Description: m.Description})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// EnableKVMount creates a KV v2 engine for secrets managed through the UI.
func (s *Service) EnableKVMount(ctx context.Context, actor audit.Actor, clusterID, path, description string) error {
	path = strings.Trim(strings.TrimSpace(path), "/")
	if len(path) > 255 || !reMountPath.MatchString(path) || len(description) > 500 {
		return badRequest("KV 挂载路径或描述不合法")
	}
	c, cl, err := s.bizClient(ctx, clusterID)
	if err != nil {
		return err
	}
	err = vaultErr(c.Request(ctx, "POST", "sys/mounts/"+escapePath(path), map[string]any{
		"type": "kv", "description": description, "options": map[string]string{"version": "2"},
	}, nil))
	// Mount metadata is safe to audit; secret values are never included.
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.kv_mount_enable", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"path": path}, Err: err})
	return err
}

func (s *Service) kvTarget(ctx context.Context, clusterID, mount, path string, needPath bool) (*Client, *cluster, string, string, bool, error) {
	mount = strings.Trim(mount, "/")
	if !reMountPath.MatchString(mount) {
		return nil, nil, "", "", false, badRequest("mount 不合法")
	}
	p, err := cleanPath(path)
	if err != nil {
		return nil, nil, "", "", false, err
	}
	if needPath && p == "" {
		return nil, nil, "", "", false, badRequest("path 不能为空")
	}
	mounts, err := s.KVMounts(ctx, clusterID)
	if err != nil {
		return nil, nil, "", "", false, err
	}
	for _, m := range mounts {
		if m.Path == mount {
			c, cl, err := s.bizClient(ctx, clusterID)
			return c, cl, mount, p, m.Version == 2, err
		}
	}
	return nil, nil, "", "", false, badRequest("%s 不是 KV 引擎挂载点", mount)
}

// KVList lists keys under a path (metadata only, readable by viewers).
func (s *Service) KVList(ctx context.Context, clusterID, mount, path string) ([]string, error) {
	c, _, m, p, v2, err := s.kvTarget(ctx, clusterID, mount, path, false)
	if err != nil {
		return nil, err
	}
	keys, err := c.KVList(ctx, m, p, v2)
	if keys == nil {
		keys = []string{}
	}
	return keys, vaultErr(err)
}

// KVMetadata returns KV v2 metadata (no secret data, readable by viewers).
func (s *Service) KVMetadata(ctx context.Context, clusterID, mount, path string) (map[string]any, error) {
	c, _, m, p, v2, err := s.kvTarget(ctx, clusterID, mount, path, true)
	if err != nil {
		return nil, err
	}
	if !v2 {
		return map[string]any{"version": 1}, nil
	}
	md, err := c.KVMetadata(ctx, m, p)
	return md, vaultErr(err)
}

// KVRead reads secret data (admin only; audited).
func (s *Service) KVRead(ctx context.Context, actor audit.Actor, clusterID, mount, path string, version int) (*KVSecret, error) {
	c, cl, m, p, v2, err := s.kvTarget(ctx, clusterID, mount, path, true)
	if err != nil {
		return nil, err
	}
	sec, err := c.KVRead(ctx, m, p, v2, version)
	err = vaultErr(err)
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.kv_read", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"mount": m, "path": p, "version": version}, Err: err})
	return sec, err
}

// KVWrite writes secret data; KV v2 requires the expected version (cas).
func (s *Service) KVWrite(ctx context.Context, actor audit.Actor, clusterID, mount, path string, data map[string]any, cas *int) (map[string]any, error) {
	c, cl, m, p, v2, err := s.kvTarget(ctx, clusterID, mount, path, true)
	if err != nil {
		return nil, err
	}
	if v2 && cas == nil {
		return nil, badRequest("KV v2 写入必须携带 cas（新建为 0，更新为当前版本号）")
	}
	if len(data) == 0 {
		return nil, badRequest("data 不能为空")
	}
	casV := 0
	if cas != nil {
		casV = *cas
	}
	res, err := c.KVWrite(ctx, m, p, v2, data, casV)
	err = vaultErr(err)
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.kv_write", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"mount": m, "path": p, "cas": casV, "keys": keys}, Err: err})
	return res, err
}

// KVDelete deletes with one of soft-delete, destroy or delete-metadata.
func (s *Service) KVDelete(ctx context.Context, actor audit.Actor, clusterID, mount, path, mode string, versions []int) error {
	c, cl, m, p, v2, err := s.kvTarget(ctx, clusterID, mount, path, true)
	if err != nil {
		return err
	}
	if v2 {
		switch mode {
		case "soft-delete", "destroy", "delete-metadata":
		default:
			return badRequest("mode 需为 soft-delete、destroy 或 delete-metadata")
		}
		if mode == "destroy" && len(versions) == 0 {
			return badRequest("destroy 需要指定版本")
		}
	}
	err = vaultErr(c.KVDelete(ctx, m, p, v2, mode, versions))
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.kv_delete", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"mount": m, "path": p, "mode": mode, "versions": versions}, Err: err})
	return err
}
