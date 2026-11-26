package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// DoctorInput selects the live login test.
type DoctorInput struct {
	// LoginRole runs the end-to-end JWT login test with this role: a batch
	// job in the role's namespace that only starts if the Nomad client
	// obtained a Vault token through the role.
	LoginRole string `json:"login_role"`
	// SecretPath additionally reads this KV path in the probe job.
	SecretPath string `json:"secret_path"`
	// DeniedNamespace runs the same probe from another namespace, which
	// Vault must refuse.
	DeniedNamespace string `json:"denied_namespace"`
	// Driver is the task driver of the probe job (default docker).
	Driver string `json:"driver"`
}

func (s *Service) poll() time.Duration {
	if s.PollEvery > 0 {
		return s.PollEvery
	}
	return 2 * time.Second
}

func (s *Service) probeTimeout() time.Duration {
	if s.ProbeTimeout > 0 {
		return s.ProbeTimeout
	}
	return 3 * time.Minute
}

// Doctor checks the integration in four stages: (1) the Nomad JWKS
// endpoint, its TLS chain and the issued audience; (2) the Nomad vault
// block (auth path, Vault address, CA) as seen by the agents; (3) the
// Vault JWT mount and its JWKS or static key configuration; (4) every
// role's fields, policy and KV mounts; optionally followed by a real login.
func (s *Service) Doctor(ctx context.Context, actor audit.Actor, id string, in DoctorInput) (*cluster.DoctorReport, error) {
	l, err := s.load(ctx, id)
	if err != nil {
		return nil, err
	}
	rep := &cluster.DoctorReport{Cluster: l.Name, RanAt: time.Now().UTC(), Checks: []cluster.Check{}}
	add := func(stage, name, status, msg, hint string) {
		rep.Checks = append(rep.Checks, cluster.Check{Node: stage, Name: name, Status: status, Message: msg, Hint: hint})
	}
	jwksURL, vaultAddr, warns, err := s.addresses(ctx, l)
	if err != nil {
		return nil, err
	}
	for _, w := range warns {
		add("1-nomad-jwks", "ha_endpoint", "WARN", w, "为集群配置 public_api_url")
	}
	// Stage 1: JWKS.
	if doc, err := s.fetchJWKS(ctx, l, jwksURL); err != nil {
		add("1-nomad-jwks", "jwks", "FAIL", fmt.Sprintf("无法获取 %s：%v", jwksURL, err), "检查 Nomad Server 与证书")
	} else {
		keys, _ := JWKSToPEM(doc)
		add("1-nomad-jwks", "jwks", "OK", fmt.Sprintf("%s 可达，TLS 由 Nomad CA 校验通过，发布 %d 个签名公钥", jwksURL, len(keys)), "")
	}
	if nomadSettings(l.src).VerifyHTTPSClient && l.cfg.JWKSMode == "url" {
		add("1-nomad-jwks", "mtls", "FAIL", "Nomad 开启了 verify_https_client，Vault 无法直接拉取 jwks_url", "关闭 verify_https_client 或改用 static 模式")
	}
	// Stage 2: Nomad agents.
	vs := s.vaultSide(l, vaultAddr)
	want := NomadSHA256(vs, l.dst.CACertPEM)
	switch {
	case !l.NomadSideEnabled:
		add("2-nomad-config", "rendered", "FAIL", "Nomad 侧配置尚未下发", "执行 Apply")
	case l.NomadConfigSHA256 != want:
		add("2-nomad-config", "rendered", "WARN", "Nomad 侧配置与当前渲染结果不一致（Vault 地址或 CA 已变化）", "执行 Apply 下发最新配置")
	default:
		add("2-nomad-config", "rendered", "OK", "60-vault.hcl 与 vault-ca.crt 已按当前配置下发", "")
	}
	ms, _ := db.ListClusterNodes(ctx, s.DB.Reader, l.src.ID)
	if api, err := s.Nomad.API(ctx, l.src.ID); err == nil {
		for _, m := range ms {
			c, err := s.Nomad.AnonClient(ctx, l.src.ID, m)
			if err != nil {
				continue
			}
			c = c.WithToken(api.Token)
			var self struct {
				Config struct {
					Vaults []struct {
						Enabled            *bool  `json:"Enabled"`
						Addr               string `json:"Addr"`
						JWTAuthBackendPath string `json:"JWTAuthBackendPath"`
						TLSCaFile          string `json:"TLSCaFile"`
					} `json:"Vaults"`
				} `json:"config"`
			}
			if err := c.Request(ctx, http.MethodGet, "agent/self", nil, &self); err != nil {
				add("2-nomad-config", "agent", "FAIL", fmt.Sprintf("%s：无法读取 Agent 配置：%v", m.NodeName, err), "")
				continue
			}
			ok := false
			for _, v := range self.Config.Vaults {
				if v.Enabled == nil || !*v.Enabled {
					continue
				}
				if nomad.IsClient(m.Role) && (v.Addr != vaultAddr || v.JWTAuthBackendPath != l.AuthPath || l.dst.TLSEnabled && v.TLSCaFile == "") {
					add("2-nomad-config", "agent", "FAIL", fmt.Sprintf("%s：vault 块为 address=%s path=%s ca=%s，期望 %s / %s", m.NodeName,
						v.Addr, v.JWTAuthBackendPath, v.TLSCaFile, vaultAddr, l.AuthPath), "执行 Apply")
					ok = true
					break
				}
				ok = true
				add("2-nomad-config", "agent", "OK", fmt.Sprintf("%s（%s）：vault 块已启用并指向 %s", m.NodeName, m.Role, l.AuthPath), "")
			}
			if !ok {
				add("2-nomad-config", "agent", "FAIL", fmt.Sprintf("%s：vault 块未启用", m.NodeName), "执行 Apply")
			}
		}
	} else {
		add("2-nomad-config", "agent", "FAIL", err.Error(), "")
	}
	// Stage 3: Vault mount.
	vc, err := s.Vault.AdminClient(ctx, l.dst.ID)
	if err != nil {
		add("3-vault-auth", "admin_token", "FAIL", err.Error(), "")
	} else {
		mounts, err := vc.ListAuth(ctx)
		mnt, ok := mounts[l.AuthPath+"/"]
		switch {
		case err != nil:
			add("3-vault-auth", "mount", "FAIL", err.Error(), "")
		case !ok:
			add("3-vault-auth", "mount", "FAIL", "JWT Auth 挂载 "+l.AuthPath+" 不存在", "执行 Apply")
		case !strings.Contains(mnt.Description, ownerTag(l.ID)):
			add("3-vault-auth", "mount", "FAIL", "挂载不归属本联动", "")
		default:
			add("3-vault-auth", "mount", "OK", "JWT Auth 挂载 "+l.AuthPath+" 存在且归属本联动", "")
			var cfg struct {
				Data struct {
					JWKSURL   string   `json:"jwks_url"`
					JWKSCAPEM string   `json:"jwks_ca_pem"`
					PubKeys   []string `json:"jwt_validation_pubkeys"`
				} `json:"data"`
			}
			if err := vc.Request(ctx, http.MethodGet, "auth/"+l.AuthPath+"/config", nil, &cfg); err != nil {
				add("3-vault-auth", "config", "FAIL", err.Error(), "")
			} else if l.cfg.JWKSMode == "static" {
				if len(cfg.Data.PubKeys) == 0 {
					add("3-vault-auth", "config", "FAIL", "static 模式但未写入任何公钥", "执行 Apply")
				} else {
					add("3-vault-auth", "config", "OK", fmt.Sprintf("static 模式，已写入 %d 个公钥", len(cfg.Data.PubKeys)), "")
				}
			} else {
				st := "OK"
				msg := "jwks_url=" + cfg.Data.JWKSURL
				if cfg.Data.JWKSURL != jwksURL {
					st, msg = "FAIL", fmt.Sprintf("jwks_url 为 %q，期望 %q", cfg.Data.JWKSURL, jwksURL)
				} else if l.src.TLSEnabled && strings.TrimSpace(cfg.Data.JWKSCAPEM) != strings.TrimSpace(l.src.CACertPEM) {
					st, msg = "FAIL", "jwks_ca_pem 与 Nomad 集群当前 CA 不一致"
				}
				add("3-vault-auth", "config", st, msg, map[string]string{"FAIL": "执行 Apply"}[st])
			}
		}
		// Stage 4: roles.
		kv, _ := vc.ListMounts(ctx)
		for _, r := range l.roles {
			sp := specOf(r)
			var role struct {
				Data map[string]any `json:"data"`
			}
			if err := vc.Request(ctx, http.MethodGet, "auth/"+l.AuthPath+"/role/"+sp.Name, nil, &role); err != nil {
				add("4-vault-role", sp.Name, "FAIL", "Role 不存在或无法读取："+err.Error(), "执行 Apply")
				continue
			}
			d := role.Data
			bound, _ := d["bound_claims"].(map[string]any)
			switch {
			case d["role_type"] != "jwt":
				add("4-vault-role", sp.Name, "FAIL", fmt.Sprintf("role_type 为 %v", d["role_type"]), "执行 Apply")
			case d["user_claim_json_pointer"] != true:
				add("4-vault-role", sp.Name, "FAIL", "user_claim_json_pointer 未开启", "执行 Apply")
			case bound == nil || bound["nomad_namespace"] == nil:
				add("4-vault-role", sp.Name, "FAIL", "bound_claims 缺少 nomad_namespace", "执行 Apply")
			default:
				add("4-vault-role", sp.Name, "OK", fmt.Sprintf("role_type=jwt，bound_claims=%v", bound), "")
			}
			if _, err := vc.GetPolicy(ctx, sp.Policy); err != nil {
				add("4-vault-role", sp.Name+"/policy", "FAIL", "Policy "+sp.Policy+" 不存在", "执行 Apply")
			}
			for _, p := range mountsOf(sp) {
				if _, ok := kv[p+"/"]; !ok {
					add("4-vault-role", sp.Name+"/kv", "WARN", "Secret Engine 挂载 "+p+" 不存在", "在 Vault 中启用 KV v2 挂载")
				}
			}
		}
	}
	// Live login test.
	if in.LoginRole != "" {
		s.loginProbe(ctx, l, in, add)
	}
	ok, warn, fail := 0, 0, 0
	for _, c := range rep.Checks {
		switch c.Status {
		case "OK":
			ok++
		case "WARN":
			warn++
		default:
			fail++
		}
	}
	rep.Summary = fmt.Sprintf("%d OK / %d WARN / %d FAIL", ok, warn, fail)
	b, _ := json.Marshal(rep)
	_ = db.SetIntegrationDoctor(ctx, s.DB.Writer, id, string(b), s.DB.Now())
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "integration.doctor", ResourceType: "integration", ResourceID: id,
		ResourceName: l.Name, Summary: map[string]any{"summary": rep.Summary, "login_role": in.LoginRole}})
	return rep, nil
}

func mountsOf(sp RoleSpec) []string {
	if sp.Mode == "templated" {
		if len(sp.SecretPaths) == 0 {
			return []string{"secret"}
		}
		return sp.SecretPaths
	}
	seen := map[string]bool{}
	var out []string
	for _, p := range sp.SecretPaths {
		m, _, _ := strings.Cut(strings.Trim(p, "/"), "/")
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// loginProbe runs the probe job with the role in its own namespace (must
// succeed) and, optionally, in another namespace (Vault must refuse).
func (s *Service) loginProbe(ctx context.Context, l *loaded, in DoctorInput, add func(stage, name, status, msg, hint string)) {
	var sp *RoleSpec
	for _, r := range l.roles {
		if r.RoleName == in.LoginRole {
			x := specOf(r)
			sp = &x
		}
	}
	if sp == nil {
		add("5-login", in.LoginRole, "FAIL", "Role 不存在", "")
		return
	}
	api, err := s.Nomad.API(ctx, l.src.ID)
	if err != nil {
		add("5-login", sp.Name, "FAIL", err.Error(), "")
		return
	}
	run := func(ns string) (bool, string) {
		driver := in.Driver
		if driver == "" {
			driver = "docker"
		}
		if driver != "raw_exec" && driver != "docker" {
			return false, "不支持的探测 Driver：" + driver
		}
		jobID := fmt.Sprintf("nomad-deck-vault-probe-%d", time.Now().UnixNano())
		q := "?namespace=" + url.QueryEscape(ns)
		if j := sp.BoundClaims["nomad_job_id"]; j != "" && ns == sp.BoundClaims["nomad_namespace"] {
			var existing json.RawMessage
			if err := api.Request(ctx, http.MethodGet, "job/"+url.PathEscape(j)+q, nil, &existing); err == nil {
				return false, fmt.Sprintf("Role 绑定了已存在的生产 Job (%s)，禁止覆盖探测", j)
			}
			jobID = j
		}
		task := map[string]any{"Name": "probe", "Driver": driver, "Vault": map[string]any{"Role": sp.Name},
			"Config":    map[string]any{"command": "/bin/sh", "args": []string{"-c", `test -s "$NOMAD_SECRETS_DIR/vault_token"`}},
			"Resources": map[string]any{"CPU": 50, "MemoryMB": 32}}
		if driver == "docker" {
			task["Config"] = map[string]any{"image": "busybox:1.36", "command": "/bin/sh",
				"args": []string{"-c", `test -s "$NOMAD_SECRETS_DIR/vault_token"`}}
		}
		if in.SecretPath != "" {
			trimmed := strings.Trim(in.SecretPath, "/")
			if !reKVPath.MatchString(trimmed) || strings.Contains(in.SecretPath, "..") {
				return false, "secret_path 格式不合法"
			}
			mnt, rest, _ := strings.Cut(trimmed, "/")
			task["Templates"] = []any{map[string]any{"DestPath": "secrets/probe.env",
				"EmbeddedTmpl": fmt.Sprintf(`{{ with secret %s }}ok{{ end }}`, strconv.Quote(mnt+"/data/"+rest))}}
		}
		job := map[string]any{
			"EnforceIndex":   true,
			"JobModifyIndex": 0,
			"Job": map[string]any{"ID": jobID, "Name": jobID, "Namespace": ns, "Type": "batch", "Datacenters": []string{"*"},
				"TaskGroups": []any{map[string]any{"Name": "probe", "Count": 1, "Tasks": []any{task},
					"RestartPolicy":    map[string]any{"Attempts": 0, "Mode": "fail"},
					"ReschedulePolicy": map[string]any{"Attempts": 0, "Unlimited": false}}}},
		}
		if err := api.Request(ctx, http.MethodPut, "jobs"+q, job, nil); err != nil {
			return false, "提交探测 Job 失败：" + err.Error()
		}
		defer func() {
			_ = api.Request(context.Background(), http.MethodDelete, "job/"+url.PathEscape(jobID)+q+"&purge=true", nil, nil)
		}()
		deadline := time.Now().Add(s.probeTimeout())
		for time.Now().Before(deadline) {
			var allocs []struct {
				ID           string `json:"ID"`
				ClientStatus string `json:"ClientStatus"`
				TaskStates   map[string]struct {
					Events []struct {
						Type           string `json:"Type"`
						DisplayMessage string `json:"DisplayMessage"`
					} `json:"Events"`
				} `json:"TaskStates"`
			}
			_ = api.Request(ctx, http.MethodGet, "job/"+url.PathEscape(jobID)+"/allocations"+q, nil, &allocs)
			for _, a := range allocs {
				var last string
				for _, ts := range a.TaskStates {
					for _, e := range ts.Events {
						if e.DisplayMessage != "" {
							last = e.Type + "：" + e.DisplayMessage
						}
					}
				}
				switch a.ClientStatus {
				case "complete":
					return true, "Allocation " + a.ID[:8] + " 已完成"
				case "failed", "lost":
					return false, last
				}
				if strings.Contains(strings.ToLower(last), "vault") && strings.Contains(strings.ToLower(last), "fail") {
					return false, last
				}
			}
			select {
			case <-ctx.Done():
				return false, ctx.Err().Error()
			case <-time.After(s.poll()):
			}
		}
		return false, "等待探测 Job 结果超时"
	}
	ns := sp.BoundClaims["nomad_namespace"]
	if ok, msg := run(ns); ok {
		add("5-login", sp.Name, "OK", fmt.Sprintf("Namespace %s 中的 Job 经 JWT Login 换取 Vault Token 成功（%s）", ns, msg), "")
	} else {
		add("5-login", sp.Name, "FAIL", fmt.Sprintf("Namespace %s 中的 Job 登录 Vault 失败：%s", ns, msg), "检查 Role 的 bound_claims、Policy 与 Nomad vault 块")
	}
	if in.DeniedNamespace != "" && in.DeniedNamespace != ns {
		if ok, msg := run(in.DeniedNamespace); ok {
			add("5-login", sp.Name+"/deny", "FAIL", fmt.Sprintf("越权 Namespace %s 的 Job 竟然登录成功", in.DeniedNamespace), "检查 bound_claims")
		} else {
			add("5-login", sp.Name+"/deny", "OK", fmt.Sprintf("越权 Namespace %s 的 Job 被 Vault 拒绝（%s）", in.DeniedNamespace, msg), "")
		}
	}
}
