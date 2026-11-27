package jobs

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// VaultIntegrationRef summarizes a Nomad-Vault integration for pre-submit checks.
type VaultIntegrationRef struct {
	Name             string
	Status           string
	NomadSideEnabled bool
	TargetClusterID  string
	VaultTLSEnabled  bool
	KVMountsQueried  bool
	KVMounts         []string
	Roles            []VaultRoleRef
}

// VaultRoleRef summarizes a workload role within a Nomad-Vault integration.
type VaultRoleRef struct {
	RoleName        string
	Status          string
	BoundNamespace  string
	PolicyMode      string
	SecretPaths     []string
	CustomPolicyHCL string
}

// KVSecretChecker queries a Vault KV v2 secret and returns the keys currently
// stored at (mount, logicalPath), whether the secret exists, and any error.
type KVSecretChecker func(vaultClusterID, mount, logicalPath string) (keys map[string]bool, exists bool, err error)

// JobValidationReport separates scheduling/runtime blockers from advisory warnings.
type JobValidationReport struct {
	Blocking []string
	Warnings []string
}

var (
	reTemplateSecret = regexp.MustCompile(`secret\s+"([^"]+)"`)
	reWithSecret     = regexp.MustCompile(`\{\{-?\s*with\s+secret\s+"([^"]+)"\s*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}`)
	reDataField      = regexp.MustCompile(`\.Data\.data\.([A-Za-z0-9_]+)`)
	reOptionalField  = regexp.MustCompile(`\bor\s+\.Data\.data\.([A-Za-z0-9_]+)`)
)

// LintVaultIntegration preserves the flattened list signature used by existing tests
// while returning both blocking and advisory findings from AnalyzeJobRequirements.
func LintVaultIntegration(j Job, integrations []VaultIntegrationRef, fallbackNamespace string) []string {
	rep := AnalyzeJobRequirements(j, integrations, fallbackNamespace, nil, false)
	out := make([]string, 0, len(rep.Blocking)+len(rep.Warnings))
	out = append(out, rep.Blocking...)
	out = append(out, rep.Warnings...)
	return out
}

// AnalyzeJobRequirements inspects Vault integration readiness, Role bindings,
// KV v2 mounts/secrets/required keys, write permissions, and paired gateway configs.
func AnalyzeJobRequirements(j Job, integrations []VaultIntegrationRef, fallbackNamespace string, checkKV KVSecretChecker, nomadACL bool) JobValidationReport {
	var rep JobValidationReport
	if j == nil {
		return rep
	}
	jobNS := str(j["Namespace"])
	if jobNS == "" {
		jobNS = orDefault(fallbackNamespace, "default")
	}

	knownMounts := map[string]bool{"secret": true}
	var appliedIG *VaultIntegrationRef
	for i := range integrations {
		ig := &integrations[i]
		for _, m := range ig.KVMounts {
			m = strings.Trim(m, "/")
			if m != "" {
				knownMounts[m] = true
			}
		}
		for _, r := range ig.Roles {
			for _, p := range r.SecretPaths {
				mnt, _, _ := strings.Cut(strings.Trim(p, "/"), "/")
				if mnt != "" {
					knownMounts[mnt] = true
				}
			}
		}
		if appliedIG == nil && ig.Status == "applied" && ig.NomadSideEnabled {
			appliedIG = ig
		}
	}
	if appliedIG == nil && len(integrations) > 0 {
		appliedIG = &integrations[0]
	}

	seenBlock := map[string]bool{}
	seenWarn := map[string]bool{}
	addBlock := func(msg string) {
		if msg == "" || seenBlock[msg] {
			return
		}
		seenBlock[msg] = true
		rep.Blocking = append(rep.Blocking, msg)
	}
	addWarn := func(msg string) {
		if msg == "" || seenWarn[msg] {
			return
		}
		seenWarn[msg] = true
		rep.Warnings = append(rep.Warnings, msg)
	}

	type kvResult struct {
		keys   map[string]bool
		exists bool
		err    error
	}
	kvCache := map[string]kvResult{}
	queryKV := func(vaultID, mount, path string) (map[string]bool, bool, error) {
		if checkKV == nil {
			return nil, false, fmt.Errorf("no kv checker")
		}
		k := vaultID + "\x00" + mount + "\x00" + path
		if res, ok := kvCache[k]; ok {
			return res.keys, res.exists, res.err
		}
		keys, exists, err := checkKV(vaultID, mount, path)
		kvCache[k] = kvResult{keys: keys, exists: exists, err: err}
		return keys, exists, err
	}

	for _, tgRaw := range list(j["TaskGroups"]) {
		tg := obj(tgRaw)
		if tg == nil {
			continue
		}
		for _, tRaw := range list(tg["Tasks"]) {
			task := obj(tRaw)
			if task == nil {
				continue
			}
			taskName := orDefault(str(task["Name"]), "task")

			v := obj(task["Vault"])
			roleName := ""
			var roleRef *VaultRoleRef
			if v != nil {
				roleName = str(v["Role"])
				if len(integrations) == 0 {
					addBlock(fmt.Sprintf(
						"Task %q 配置了 vault 块（role=%q），但当前 Nomad 集群尚未建立 Nomad-Vault 联动，请先前往「集群联动」创建并应用。",
						taskName, orDefault(roleName, "default"),
					))
				} else if appliedIG.Status != "applied" || !appliedIG.NomadSideEnabled {
					addBlock(fmt.Sprintf(
						"Task %q 使用了 Vault 联动，但联动配置「%s」尚未应用生效（当前状态：%s），请先在「集群联动」点击「应用联动」。",
						taskName, appliedIG.Name, orDefault(appliedIG.Status, "draft"),
					))
				} else if roleName != "" {
					for i := range appliedIG.Roles {
						if appliedIG.Roles[i].RoleName == roleName {
							roleRef = &appliedIG.Roles[i]
							break
						}
					}
					if roleRef == nil {
						addBlock(fmt.Sprintf(
							"Task %q 引用的 Vault Role %q 在联动「%s」中不存在，请先在「集群联动」添加该 Role 并点击「应用联动」。",
							taskName, roleName, appliedIG.Name,
						))
					} else {
						if roleRef.Status != "applied" {
							addBlock(fmt.Sprintf(
								"Task %q 引用的 Vault Role %q 尚未应用生效（当前状态：%s），请先在「集群联动」点击「应用联动」。",
								taskName, roleName, orDefault(roleRef.Status, "draft"),
							))
						}
						if roleRef.BoundNamespace != "" && roleRef.BoundNamespace != jobNS {
							addBlock(fmt.Sprintf(
								"Task %q 引用的 Role %q 仅允许 Nomad Namespace %q，而当前 Job 的 Namespace 为 %q，运行时会被 Vault 拒绝。",
								taskName, roleName, roleRef.BoundNamespace, jobNS,
							))
						}
					}
				}
			}

			mountedVaultMounts := map[string]bool{}
			if appliedIG != nil {
				for _, m := range appliedIG.KVMounts {
					m = strings.Trim(m, "/")
					if m != "" {
						mountedVaultMounts[m] = true
					}
				}
			}

			templates := list(task["Templates"])
			templateDestinations := map[string]bool{}
			needCertPairCheck := false
			taskWritesToVault := false

			for _, tplRaw := range templates {
				tpl := obj(tplRaw)
				if tpl == nil {
					continue
				}
				dest := strings.TrimSpace(str(tpl["DestPath"]))
				if dest != "" {
					templateDestinations[dest] = true
				}
				tmpl := str(tpl["EmbeddedTmpl"])
				if tmpl == "" {
					continue
				}

				if strings.Contains(tmpl, "$VAULT_TOKEN") &&
					(strings.Contains(tmpl, "/v1/") || strings.Contains(tmpl, "VAULT_KV_PATH")) &&
					(strings.Contains(tmpl, "-X POST") || strings.Contains(tmpl, "-X PUT")) {
					taskWritesToVault = true
				}

				// Inspect all secret "..." references (skipping pure comment lines).
				activeTmpl := stripShellOrConfigComments(tmpl)
				if v == nil && reTemplateSecret.MatchString(activeTmpl) {
					addBlock(fmt.Sprintf(
						"Task %q 的 template 使用了 Vault secret，但未配置 vault 块（请先绑定 Vault Role 或添加 vault { role = \"...\" }）。",
						taskName,
					))
				}
				for _, match := range reTemplateSecret.FindAllStringSubmatch(activeTmpl, -1) {
					secretPath := strings.Trim(match[1], "/")
					mnt, rest, ok := strings.Cut(secretPath, "/")
					if !ok || mnt == "" || rest == "" {
						continue
					}
					if knownMounts[mnt] && rest != "data" && !strings.HasPrefix(rest, "data/") &&
						rest != "metadata" && !strings.HasPrefix(rest, "metadata/") {
						addBlock(fmt.Sprintf(
							"Task %q 的 template 中读取 %q 缺少 \"/data/\"：Vault KV v2 模板路径应写成 \"%s/data/%s\"（Role 权限配置中才省略 data/）。",
							taskName, match[1], mnt, rest,
						))
						continue
					}
					if !strings.HasPrefix(rest, "data/") {
						continue
					}
					logicalSub := strings.TrimPrefix(rest, "data/")
					logicalFull := mnt + "/" + logicalSub

					// Check role path coverage when explicit paths are configured.
					if roleRef != nil && roleRef.Status == "applied" &&
						(roleRef.PolicyMode == "" || roleRef.PolicyMode == "explicit") &&
						len(roleRef.SecretPaths) > 0 && !roleCoversLogicalPath(roleRef.SecretPaths, logicalFull) {
						addBlock(fmt.Sprintf(
							"Task %q 读取路径 %q，但 Role %q 的授权路径（%s）未覆盖该路径（精确授权不包含子路径），请修改 Role 路径并重新应用。",
							taskName, logicalFull, roleName, strings.Join(roleRef.SecretPaths, ", "),
						))
					}

					// Check live Vault KV v2 mount, secret existence and required keys.
					if appliedIG != nil && appliedIG.Status == "applied" && appliedIG.KVMountsQueried {
						if !mountedVaultMounts[mnt] {
							addBlock(fmt.Sprintf(
								"Task %q 的 template 读取了 Vault 挂载点 %q，但目标 Vault 集群尚未启用该 KV v2 引擎（请先前往「Vault 集群 → Auth / Policy / KV」启用 %q）。",
								taskName, mnt, mnt,
							))
							continue
						}
						keys, exists, err := queryKV(appliedIG.TargetClusterID, mnt, logicalSub)
						if err == nil && !exists {
							addBlock(fmt.Sprintf(
								"Task %q 引用的 Vault Secret %q（逻辑路径 %s）在 Vault 中尚不存在，请先前往「Vault 集群 → Auth / Policy / KV」写入该密钥后再运行。",
								taskName, match[1], logicalFull,
							))
							continue
						}
						if err == nil && exists {
							for _, key := range requiredKeysForSecret(activeTmpl, match[1]) {
								if !keys[key] {
									addBlock(fmt.Sprintf(
										"Task %q 从 %q 读取必需字段 %q，但该 Secret 中尚未包含此字段（请在 Vault 中补全 %q）。",
										taskName, match[1], key, key,
									))
								}
							}
						}
					}
				}

				if strings.HasSuffix(dest, "nginx.conf") || strings.HasSuffix(dest, "Caddyfile") {
					if strings.Contains(activeTmpl, "/secrets/cert.pem") || strings.Contains(activeTmpl, "/secrets/cert.key") {
						needCertPairCheck = true
					}
				}
				if strings.HasSuffix(dest, "traefik.yml") {
					inspectTraefikConfig(task, taskName, activeTmpl, nomadACL, addBlock, addWarn)
				}
			}

			if taskWritesToVault && roleRef != nil {
				if roleRef.PolicyMode != "custom" ||
					(!strings.Contains(roleRef.CustomPolicyHCL, "create") && !strings.Contains(roleRef.CustomPolicyHCL, "update")) {
					addBlock(fmt.Sprintf(
						"Task %q 在运行时需使用 $VAULT_TOKEN 向 Vault 写入数据（如推送证书），但 Role %q 当前不是包含 create/update 权限的自定义 Policy，请在「集群联动」编辑该 Role → 高级选项填入写权限 Policy 并重新应用。",
						taskName, roleName,
					))
				}
			}

			if needCertPairCheck {
				if v == nil || !templateDestinations["secrets/cert.pem"] || !templateDestinations["secrets/cert.key"] {
					addBlock(fmt.Sprintf(
						"Task %q 的网关配置启用了 /secrets/cert.pem 或 /secrets/cert.key，但未同时启用 vault 块与证书 template（secrets/cert.pem、secrets/cert.key），启动时会因缺少证书文件失败。",
						taskName,
					))
				}
			}
		}
	}
	return rep
}

func stripShellOrConfigComments(src string) string {
	lines := strings.Split(src, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "#!") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func roleCoversLogicalPath(secretPaths []string, logicalFull string) bool {
	logicalFull = strings.Trim(logicalFull, "/")
	for _, p := range secretPaths {
		p = strings.Trim(strings.TrimSpace(p), "/")
		if p == "" {
			continue
		}
		if p == logicalFull || p == "*" {
			return true
		}
		if strings.HasSuffix(p, "/*") {
			prefix := strings.TrimSuffix(p, "*")
			if strings.HasPrefix(logicalFull, prefix) {
				return true
			}
		}
	}
	return false
}

func requiredKeysForSecret(tmpl, secretRef string) []string {
	req := map[string]bool{}
	foundBlock := false
	for _, m := range reWithSecret.FindAllStringSubmatch(tmpl, -1) {
		if strings.TrimSpace(m[1]) != strings.TrimSpace(secretRef) {
			continue
		}
		foundBlock = true
		body := m[2]
		opt := map[string]bool{}
		for _, om := range reOptionalField.FindAllStringSubmatch(body, -1) {
			opt[om[1]] = true
		}
		for _, fm := range reDataField.FindAllStringSubmatch(body, -1) {
			if !opt[fm[1]] {
				req[fm[1]] = true
			}
		}
	}
	if !foundBlock {
		return nil
	}
	out := make([]string, 0, len(req))
	for k := range req {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func inspectTraefikConfig(task map[string]any, taskName, activeYML string, nomadACL bool, addBlock, addWarn func(string)) {
	hasNomadProvider := regexp.MustCompile(`(?m)^\s+nomad:\s*$`).MatchString(activeYML)
	if hasNomadProvider {
		hasCAFile := strings.Contains(activeYML, "/etc/ssl/nomad-ca.pem")
		hasSkipVerify := regexp.MustCompile(`(?m)^\s*insecureSkipVerify:\s*true\b`).MatchString(activeYML)
		if hasCAFile && !hasSkipVerify {
			mounted := false
			if cfg := obj(task["Config"]); cfg != nil {
				for _, v := range list(cfg["volumes"]) {
					if s := str(v); strings.Contains(s, ":/etc/ssl/nomad-ca.pem") {
						mounted = true
						break
					}
				}
			}
			if !mounted {
				addBlock(fmt.Sprintf(
					"Task %q 的 traefik.yml 开启了 providers.nomad 并指定 ca: /etc/ssl/nomad-ca.pem，但未在 docker volumes 中挂载 Nomad CA，启动后将无法连接 Nomad TLS API。",
					taskName,
				))
			}
		}
		if nomadACL && !taskDefinesEnvVar(task, "NOMAD_TOKEN") {
			addWarn(fmt.Sprintf(
				"Task %q 开启了 traefik providers.nomad，但未检测到 NOMAD_TOKEN 注入；在开启 ACL 的 Nomad 集群上需提供只读 NOMAD_TOKEN 才能自动发现服务。",
				taskName,
			))
		}
	}

	hasAlidns := regexp.MustCompile(`(?m)^\s*provider:\s*alidns\b`).MatchString(activeYML)
	if hasAlidns {
		if !taskDefinesEnvVar(task, "ALICLOUD_ACCESS_KEY") || !taskDefinesEnvVar(task, "ALICLOUD_SECRET_KEY") {
			addBlock(fmt.Sprintf(
				"Task %q 的 traefik.yml 开启了阿里云 DNS-01 (alidns) 自动签发证书，但未注入 ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY（请取消 vault 模板注释并配置阿里云密钥）。",
				taskName,
			))
		}
	}
}

func taskDefinesEnvVar(task map[string]any, name string) bool {
	if env := obj(task["Env"]); env != nil {
		if v := str(env[name]); v != "" {
			return true
		}
	}
	for _, tplRaw := range list(task["Templates"]) {
		tpl := obj(tplRaw)
		if tpl == nil {
			continue
		}
		if envFlag, _ := tpl["Envvars"].(bool); !envFlag {
			continue
		}
		active := stripShellOrConfigComments(str(tpl["EmbeddedTmpl"]))
		for _, line := range strings.Split(active, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), name+"=") {
				return true
			}
		}
	}
	return false
}
