package jobs

import (
	"fmt"
	"regexp"
	"strings"
)

// VaultIntegrationRef summarizes a Nomad-Vault integration for pre-submit checks.
type VaultIntegrationRef struct {
	ID                string
	Name              string
	Status            string
	NomadSideEnabled  bool
	TargetClusterID   string
	TargetClusterName string
	VaultTLSEnabled   bool
	ConfigDrifted     bool
	DriftReasons      []string
	KVMountsQueried   bool
	KVMounts          []string
	Roles             []VaultRoleRef
}

// VaultRoleRef summarizes a workload role within a Nomad-Vault integration.
type VaultRoleRef struct {
	ID              string
	RoleName        string
	PolicyName      string
	Status          string
	BoundNamespace  string
	PolicyMode      string
	SecretPaths     []string
	CustomPolicyHCL string
	TokenPeriod     string
}

// KVSecretChecker queries a Vault KV v2 secret and returns the keys currently
// stored at (mount, logicalPath), whether the secret exists, and any error.
type KVSecretChecker func(vaultClusterID, mount, logicalPath string) (keys map[string]bool, exists bool, err error)

// JobValidationReport separates scheduling/runtime blockers from advisory warnings
// and includes structured preflight check items for UI rendering and quick fixes.
type JobValidationReport struct {
	Blocking []string
	Warnings []string
	Checks   []PreflightCheck
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
	seenCheck := map[string]bool{}
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
	addCheck := func(chk PreflightCheck) {
		if chk.ID == "" || seenCheck[chk.ID] {
			return
		}
		seenCheck[chk.ID] = true
		rep.Checks = append(rep.Checks, chk)
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

	mountedVaultMounts := map[string]bool{}
	if appliedIG != nil {
		for _, m := range appliedIG.KVMounts {
			m = strings.Trim(m, "/")
			if m != "" {
				mountedVaultMounts[m] = true
			}
		}
	}

	// Aggregators for structured per-role and per-secret checks across all tasks/templates.
	type roleAgg struct {
		roleName       string
		tasks          []string
		readPaths      map[string]bool
		writeDataPaths map[string]bool
		writesToVault  bool
	}
	type secretAgg struct {
		mount        string
		logicalSub   string
		logicalFull  string
		templateRef  string
		requiredKeys map[string]bool
		optionalKeys map[string]bool
	}
	roleOrder := []string{}
	rolesByName := map[string]*roleAgg{}
	secretOrder := []string{}
	secretsByPath := map[string]*secretAgg{}
	missingMounts := map[string]bool{}
	usesVault := false

	getRoleAgg := func(roleName string) *roleAgg {
		if existing, ok := rolesByName[roleName]; ok {
			return existing
		}
		ra := &roleAgg{
			roleName:       roleName,
			readPaths:      map[string]bool{},
			writeDataPaths: map[string]bool{},
		}
		rolesByName[roleName] = ra
		roleOrder = append(roleOrder, roleName)
		return ra
	}
	getSecretAgg := func(mnt, logicalSub, templateRef string) *secretAgg {
		full := mnt + "/" + logicalSub
		if existing, ok := secretsByPath[full]; ok {
			return existing
		}
		sa := &secretAgg{
			mount:        mnt,
			logicalSub:   logicalSub,
			logicalFull:  full,
			templateRef:  templateRef,
			requiredKeys: map[string]bool{},
			optionalKeys: map[string]bool{},
		}
		secretsByPath[full] = sa
		secretOrder = append(secretOrder, full)
		return sa
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
			var curRoleAgg *roleAgg
			if v != nil {
				usesVault = true
				roleName = str(v["Role"])
				if roleName != "" {
					curRoleAgg = getRoleAgg(roleName)
					curRoleAgg.tasks = append(curRoleAgg.tasks, taskName)
				}
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
				} else {
					if appliedIG.ConfigDrifted {
						detail := strings.Join(appliedIG.DriftReasons, "；")
						if detail == "" {
							detail = "Vault/Nomad CA 或联动地址已变更"
						}
						addBlock(fmt.Sprintf(
							"Task %q 使用的联动「%s」存在配置漂移（%s），请先前往「集群联动」点击「重新应用联动」同步最新 CA 与配置。",
							taskName, appliedIG.Name, detail,
						))
					}
					if roleName != "" {
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
					usesVault = true
					msg := fmt.Sprintf(
						"Task %q 的 template 使用了 Vault secret，但未配置 vault 块（请先绑定 Vault Role 或添加 vault { role = \"...\" }）。",
						taskName,
					)
					addBlock(msg)
					addCheck(PreflightCheck{
						ID:       "vault_block_missing:" + taskName,
						Kind:     "vault_config",
						Status:   "error",
						Title:    fmt.Sprintf("Task %q 缺少 vault 块", taskName),
						TitleEn:  fmt.Sprintf("Task %q missing vault block", taskName),
						Detail:   msg,
						DetailEn: fmt.Sprintf("Task %q reads a Vault secret in template without configuring a vault { role = \"...\" } block.", taskName),
					})
				}
				for _, match := range reTemplateSecret.FindAllStringSubmatch(activeTmpl, -1) {
					usesVault = true
					secretPath := strings.Trim(match[1], "/")
					mnt, rest, ok := strings.Cut(secretPath, "/")
					if !ok || mnt == "" || rest == "" {
						continue
					}
					if knownMounts[mnt] && rest != "data" && !strings.HasPrefix(rest, "data/") &&
						rest != "metadata" && !strings.HasPrefix(rest, "metadata/") {
						msg := fmt.Sprintf(
							"Task %q 的 template 中读取 %q 缺少 \"/data/\"：Vault KV v2 模板路径应写成 \"%s/data/%s\"（Role 权限配置中才省略 data/）。",
							taskName, match[1], mnt, rest,
						)
						addBlock(msg)
						addCheck(PreflightCheck{
							ID:       "vault_kv_path:" + taskName + ":" + match[1],
							Kind:     "vault_config",
							Status:   "error",
							Title:    fmt.Sprintf("KV v2 模板路径缺少 /data/（%s）", match[1]),
							TitleEn:  fmt.Sprintf("KV v2 template path missing /data/ (%s)", match[1]),
							Detail:   msg,
							DetailEn: fmt.Sprintf("Vault KV v2 template path %q must include /data/ (write \"%s/data/%s\").", match[1], mnt, rest),
						})
						continue
					}
					if !strings.HasPrefix(rest, "data/") {
						continue
					}
					logicalSub := strings.TrimPrefix(rest, "data/")
					logicalFull := mnt + "/" + logicalSub
					if curRoleAgg != nil {
						curRoleAgg.readPaths[logicalFull] = true
					}
					sa := getSecretAgg(mnt, logicalSub, match[1])
					reqKeys, optKeys := keysForSecret(activeTmpl, match[1])
					for _, k := range reqKeys {
						sa.requiredKeys[k] = true
					}
					for _, k := range optKeys {
						sa.optionalKeys[k] = true
					}

					// Check role path coverage when explicit paths are configured (skipped when CustomPolicyHCL overrides).
					if roleRef != nil && roleRef.Status == "applied" &&
						strings.TrimSpace(roleRef.CustomPolicyHCL) == "" &&
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
							missingMounts[mnt] = true
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
							for _, key := range reqKeys {
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
					inspectTraefikConfig(task, taskName, activeTmpl, nomadACL, func(msg string) {
						addBlock(msg)
						addCheck(PreflightCheck{
							ID:       "traefik_block:" + taskName + ":" + msg,
							Kind:     "gateway_config",
							Status:   "error",
							Title:    fmt.Sprintf("Traefik 配置缺失前置项（%s）", taskName),
							TitleEn:  fmt.Sprintf("Traefik config prerequisite missing (%s)", taskName),
							Detail:   msg,
							DetailEn: msg,
						})
					}, func(msg string) {
						addWarn(msg)
						addCheck(PreflightCheck{
							ID:       "traefik_warn:" + taskName + ":" + msg,
							Kind:     "gateway_config",
							Status:   "warning",
							Title:    fmt.Sprintf("Traefik ACL 提示（%s）", taskName),
							TitleEn:  fmt.Sprintf("Traefik ACL reminder (%s)", taskName),
							Detail:   msg,
							DetailEn: msg,
						})
					})
				}
			}

			if taskWritesToVault {
				if curRoleAgg != nil {
					curRoleAgg.writesToVault = true
					for _, wp := range detectVaultWritePaths(templates) {
						curRoleAgg.writeDataPaths[wp] = true
					}
				}
				if roleRef != nil {
					customHCL := strings.TrimSpace(roleRef.CustomPolicyHCL)
					if customHCL == "" || (!strings.Contains(customHCL, "create") && !strings.Contains(customHCL, "update")) {
						addBlock(fmt.Sprintf(
							"Task %q 在运行时需使用 $VAULT_TOKEN 向 Vault 写入数据（如推送证书），但 Role %q 当前不是包含 create/update 权限的自定义 Policy，请在「集群联动」编辑该 Role → 展开高级选项填入写权限 Policy（可点「填入 acme-cert-sync 读写证书策略」）并重新应用。",
							taskName, roleName,
						))
					}
				}
			}

			if needCertPairCheck {
				if v == nil || !templateDestinations["secrets/cert.pem"] || !templateDestinations["secrets/cert.key"] {
					msg := fmt.Sprintf(
						"Task %q 的网关配置启用了 /secrets/cert.pem 或 /secrets/cert.key，但未同时启用 vault 块与证书 template（secrets/cert.pem、secrets/cert.key），启动时会因缺少证书文件失败。",
						taskName,
					)
					addBlock(msg)
					addCheck(PreflightCheck{
						ID:       "gateway_certs:" + taskName,
						Kind:     "gateway_config",
						Status:   "error",
						Title:    fmt.Sprintf("Task %q 缺少 Vault 证书模板", taskName),
						TitleEn:  fmt.Sprintf("Task %q missing Vault cert templates", taskName),
						Detail:   msg,
						DetailEn: fmt.Sprintf("Task %q references /secrets/cert.pem or /secrets/cert.key without enabling vault and cert templates.", taskName),
					})
				}
			}
		}
	}

	// Emit structured Vault integration, Role, KV mount, and KV secret checks.
	if usesVault {
		if len(integrations) == 0 {
			addCheck(PreflightCheck{
				ID:       "vault_integration",
				Kind:     "vault_integration",
				Status:   "error",
				Title:    "尚未建立 Nomad-Vault 集群联动",
				TitleEn:  "Nomad-Vault integration not configured",
				Detail:   "当前模板依赖 Vault 密钥，请先前往「集群联动」创建并应用 Nomad-Vault 联动。",
				DetailEn: "This template requires Vault secrets. Create and apply a Nomad-Vault integration first.",
				FixAction: &PreflightFixAction{
					Type:    "link",
					Path:    "/integrations",
					Label:   "前往集群联动",
					LabelEn: "Open Integrations",
				},
			})
		} else if appliedIG.Status != "applied" || !appliedIG.NomadSideEnabled {
			addCheck(PreflightCheck{
				ID:       "vault_integration",
				Kind:     "vault_integration",
				Status:   "error",
				Title:    fmt.Sprintf("联动「%s」尚未应用生效", appliedIG.Name),
				TitleEn:  fmt.Sprintf("Integration %q not applied yet", appliedIG.Name),
				Detail:   fmt.Sprintf("联动当前状态为 %s，需先应用联动后任务才能向 Vault 换取密钥。", orDefault(appliedIG.Status, "draft")),
				DetailEn: fmt.Sprintf("Integration status is %s. Apply it before tasks can fetch secrets from Vault.", orDefault(appliedIG.Status, "draft")),
				FixAction: &PreflightFixAction{
					Type:            "vault_role",
					Label:           "应用联动",
					LabelEn:         "Apply Integration",
					IntegrationID:   appliedIG.ID,
					IntegrationName: appliedIG.Name,
					NeedsApplyOnly:  true,
				},
			})
		} else if appliedIG.ConfigDrifted {
			detail := strings.Join(appliedIG.DriftReasons, "；")
			if detail == "" {
				detail = "Vault/Nomad CA 或联动地址已变更"
			}
			addCheck(PreflightCheck{
				ID:       "vault_integration",
				Kind:     "vault_integration",
				Status:   "error",
				Title:    fmt.Sprintf("联动「%s」存在配置漂移", appliedIG.Name),
				TitleEn:  fmt.Sprintf("Integration %q configuration drifted", appliedIG.Name),
				Detail:   fmt.Sprintf("检测到配置漂移（%s），请重新应用联动同步最新 CA 与配置。", detail),
				DetailEn: fmt.Sprintf("Configuration drift detected (%s). Re-apply the integration to sync CA and config.", detail),
				FixAction: &PreflightFixAction{
					Type:            "vault_role",
					Label:           "重新应用联动",
					LabelEn:         "Re-apply Integration",
					IntegrationID:   appliedIG.ID,
					IntegrationName: appliedIG.Name,
					NeedsApplyOnly:  true,
				},
			})
		} else {
			addCheck(PreflightCheck{
				ID:       "vault_integration",
				Kind:     "vault_integration",
				Status:   "ok",
				Title:    fmt.Sprintf("Nomad-Vault 联动已就绪（%s）", appliedIG.Name),
				TitleEn:  fmt.Sprintf("Nomad-Vault integration ready (%s)", appliedIG.Name),
				Detail:   fmt.Sprintf("已连接到 Vault 集群「%s」。", orDefault(appliedIG.TargetClusterName, appliedIG.TargetClusterID)),
				DetailEn: fmt.Sprintf("Connected to Vault cluster %q.", orDefault(appliedIG.TargetClusterName, appliedIG.TargetClusterID)),
			})
		}

		// Per-role checks.
		for _, rName := range roleOrder {
			ra := rolesByName[rName]
			readPaths := mapKeysSorted(ra.readPaths)
			writeDataPaths := mapKeysSorted(ra.writeDataPaths)

			if appliedIG == nil {
				addCheck(PreflightCheck{
					ID:       "vault_role:" + rName,
					Kind:     "vault_role",
					Status:   "error",
					Title:    fmt.Sprintf("需要 Vault Role %q", rName),
					TitleEn:  fmt.Sprintf("Vault Role %q required", rName),
					Detail:   fmt.Sprintf("建立联动后需创建 Role %q 并授权路径：%s。", rName, orDefault(strings.Join(readPaths, ", "), "默认路径")),
					DetailEn: fmt.Sprintf("Create Role %q after setting up the integration (paths: %s).", rName, orDefault(strings.Join(readPaths, ", "), "default")),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    "/integrations",
						Label:   "前往集群联动",
						LabelEn: "Open Integrations",
					},
				})
				continue
			}

			var roleRef *VaultRoleRef
			for i := range appliedIG.Roles {
				if appliedIG.Roles[i].RoleName == rName {
					roleRef = &appliedIG.Roles[i]
					break
				}
			}

			var reasonsZh []string
			var reasonsEn []string
			needsRoleEdit := false
			customPolicy := ""
			if roleRef != nil {
				customPolicy = strings.TrimSpace(roleRef.CustomPolicyHCL)
			}

			if roleRef == nil {
				needsRoleEdit = true
				reasonsZh = append(reasonsZh, fmt.Sprintf("联动「%s」中尚不存在 Role %q", appliedIG.Name, rName))
				reasonsEn = append(reasonsEn, fmt.Sprintf("Role %q does not exist in integration %q", rName, appliedIG.Name))
				if ra.writesToVault {
					customPolicy = buildWriteRolePolicyHCL(readPaths, writeDataPaths)
				}
			} else {
				if roleRef.Status != "applied" {
					reasonsZh = append(reasonsZh, fmt.Sprintf("当前状态为 %s，尚未应用生效", orDefault(roleRef.Status, "draft")))
					reasonsEn = append(reasonsEn, fmt.Sprintf("Status is %s (not applied yet)", orDefault(roleRef.Status, "draft")))
				}
				if roleRef.BoundNamespace != "" && roleRef.BoundNamespace != jobNS {
					needsRoleEdit = true
					reasonsZh = append(reasonsZh, fmt.Sprintf("当前绑定 Namespace 为 %q，与任务 Namespace %q 不匹配", roleRef.BoundNamespace, jobNS))
					reasonsEn = append(reasonsEn, fmt.Sprintf("Bound namespace %q does not match job namespace %q", roleRef.BoundNamespace, jobNS))
				}
				if customPolicy == "" && (roleRef.PolicyMode == "" || roleRef.PolicyMode == "explicit") && len(readPaths) > 0 {
					var uncovered []string
					for _, lp := range readPaths {
						if !roleCoversLogicalPath(roleRef.SecretPaths, lp) {
							uncovered = append(uncovered, lp)
						}
					}
					if len(uncovered) > 0 {
						needsRoleEdit = true
						reasonsZh = append(reasonsZh, fmt.Sprintf("授权路径未覆盖 %s", strings.Join(uncovered, "、")))
						reasonsEn = append(reasonsEn, fmt.Sprintf("Authorized paths do not cover %s", strings.Join(uncovered, ", ")))
					}
				}
				if ra.writesToVault && (customPolicy == "" || (!strings.Contains(customPolicy, "create") && !strings.Contains(customPolicy, "update"))) {
					needsRoleEdit = true
					reasonsZh = append(reasonsZh, "缺少写权限自定义 Policy（create / update）")
					reasonsEn = append(reasonsEn, "Missing custom Policy with create/update capabilities")
					customPolicy = buildWriteRolePolicyHCL(readPaths, writeDataPaths)
				}
			}

			if len(reasonsZh) == 0 {
				addCheck(PreflightCheck{
					ID:       "vault_role:" + rName,
					Kind:     "vault_role",
					Status:   "ok",
					Title:    fmt.Sprintf("Vault Role %q 已生效", rName),
					TitleEn:  fmt.Sprintf("Vault Role %q active", rName),
					Detail:   fmt.Sprintf("联动「%s」中的 Role %q 已覆盖所需权限与命名空间（%s）。", appliedIG.Name, rName, jobNS),
					DetailEn: fmt.Sprintf("Role %q in integration %q covers required paths and namespace (%s).", rName, appliedIG.Name, jobNS),
				})
			} else {
				mergedPaths := readPaths
				roleID := ""
				policyName := ""
				tokenPeriod := ""
				if roleRef != nil {
					roleID = roleRef.ID
					policyName = roleRef.PolicyName
					tokenPeriod = roleRef.TokenPeriod
					mergedPaths = mergeSortedUnique(roleRef.SecretPaths, readPaths)
				}
				labelZh := "一键创建并应用 Role"
				labelEn := "Create & Apply Role"
				if roleRef != nil && !needsRoleEdit {
					labelZh = "立即应用联动"
					labelEn = "Apply Integration"
				} else if roleRef != nil {
					labelZh = "一键修复 Role"
					labelEn = "Fix & Apply Role"
				}
				addCheck(PreflightCheck{
					ID:       "vault_role:" + rName,
					Kind:     "vault_role",
					Status:   "error",
					Title:    fmt.Sprintf("Vault Role %q 未就绪", rName),
					TitleEn:  fmt.Sprintf("Vault Role %q not ready", rName),
					Detail:   strings.Join(reasonsZh, "；") + "。",
					DetailEn: strings.Join(reasonsEn, "; ") + ".",
					FixAction: &PreflightFixAction{
						Type:            "vault_role",
						Label:           labelZh,
						LabelEn:         labelEn,
						IntegrationID:   appliedIG.ID,
						IntegrationName: appliedIG.Name,
						RoleID:          roleID,
						RoleName:        rName,
						PolicyName:      policyName,
						TokenPeriod:     tokenPeriod,
						Namespace:       jobNS,
						PolicyMode:      "explicit",
						SecretPaths:     mergedPaths,
						CustomPolicyHCL: customPolicy,
						NeedsApplyOnly:  roleRef != nil && !needsRoleEdit,
					},
				})
			}
		}

		// Missing KV mounts.
		for _, mnt := range mapKeysSorted(missingMounts) {
			vaultPath := "/vault"
			if appliedIG != nil && appliedIG.TargetClusterID != "" {
				vaultPath = "/vault?id=" + appliedIG.TargetClusterID
			}
			addCheck(PreflightCheck{
				ID:       "vault_kv_mount:" + mnt,
				Kind:     "vault_kv_mount",
				Status:   "error",
				Title:    fmt.Sprintf("Vault KV v2 挂载点 %q 未启用", mnt),
				TitleEn:  fmt.Sprintf("Vault KV v2 mount %q not enabled", mnt),
				Detail:   fmt.Sprintf("目标 Vault 集群尚未启用 KV v2 引擎 %q，请先前往 Vault 集群页面启用。", mnt),
				DetailEn: fmt.Sprintf("KV v2 engine %q is not enabled on the target Vault cluster.", mnt),
				FixAction: &PreflightFixAction{
					Type:    "link",
					Path:    vaultPath,
					Label:   "前往 Vault 集群",
					LabelEn: "Open Vault Cluster",
				},
			})
		}

		// Per-secret checks (aggregated across all templates reading the same path).
		for _, full := range secretOrder {
			sa := secretsByPath[full]
			if missingMounts[sa.mount] {
				continue
			}
			// Remove any key from optionalKeys if another template requires it.
			for k := range sa.requiredKeys {
				delete(sa.optionalKeys, k)
			}
			reqKeys := mapKeysSorted(sa.requiredKeys)
			optKeys := mapKeysSorted(sa.optionalKeys)

			if appliedIG == nil || appliedIG.TargetClusterID == "" {
				keyHint := strings.Join(reqKeys, "、")
				keyHintEn := strings.Join(reqKeys, ", ")
				if keyHint == "" {
					keyHint = "密钥数据"
					keyHintEn = "secret fields"
				}
				addCheck(PreflightCheck{
					ID:       "vault_kv_secret:" + full,
					Kind:     "vault_kv_secret",
					Status:   "warning",
					Title:    fmt.Sprintf("需要 Vault 密钥 %s", full),
					TitleEn:  fmt.Sprintf("Vault secret %s required", full),
					Detail:   fmt.Sprintf("建立联动后需在 Vault 路径 %s 写入字段：%s。", full, keyHint),
					DetailEn: fmt.Sprintf("Write required fields (%s) at Vault path %s after setting up integration.", keyHintEn, full),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    "/vault",
						Label:   "前往 Vault 密钥",
						LabelEn: "Open Vault KV",
					},
				})
				continue
			}

			if appliedIG.KVMountsQueried && !mountedVaultMounts[sa.mount] {
				continue
			}

			keys, exists, err := queryKV(appliedIG.TargetClusterID, sa.mount, sa.logicalSub)
			if err != nil {
				// Could not inspect live KV (e.g. Vault sealed or checker absent); emit non-blocking reminder with quick write action.
				addCheck(PreflightCheck{
					ID:       "vault_kv_secret:" + full,
					Kind:     "vault_kv_secret",
					Status:   "warning",
					Title:    fmt.Sprintf("Vault 密钥 %s 待核对", full),
					TitleEn:  fmt.Sprintf("Vault secret %s needs verification", full),
					Detail:   fmt.Sprintf("暂时无法在线核对 %s（请确保 Vault 已解封）；必需字段：%s。", full, orDefault(strings.Join(reqKeys, "、"), "无固定字段")),
					DetailEn: fmt.Sprintf("Could not inspect %s live (ensure Vault is unsealed); required keys: %s.", full, orDefault(strings.Join(reqKeys, ", "), "none")),
					FixAction: &PreflightFixAction{
						Type:           "vault_kv",
						Label:          "写入密钥",
						LabelEn:        "Write Secret",
						VaultClusterID: appliedIG.TargetClusterID,
						VaultCluster:   appliedIG.TargetClusterName,
						Mount:          sa.mount,
						SecretPath:     sa.logicalSub,
						RequiredKeys:   reqKeys,
						OptionalKeys:   optKeys,
						MissingKeys:    reqKeys,
					},
				})
				continue
			}

			existingKeys := mapKeysSorted(keys)
			if !exists {
				fieldDescZh := "请写入所需密钥数据"
				fieldDescEn := "Write the required secret data"
				if len(reqKeys) > 0 {
					fieldDescZh = fmt.Sprintf("必需字段：%s", strings.Join(reqKeys, "、"))
					fieldDescEn = fmt.Sprintf("Required keys: %s", strings.Join(reqKeys, ", "))
				}
				addCheck(PreflightCheck{
					ID:       "vault_kv_secret:" + full,
					Kind:     "vault_kv_secret",
					Status:   "error",
					Title:    fmt.Sprintf("缺少 Vault 密钥 %s", full),
					TitleEn:  fmt.Sprintf("Missing Vault secret %s", full),
					Detail:   fmt.Sprintf("Vault 路径 %s 尚不存在（%s）。", full, fieldDescZh),
					DetailEn: fmt.Sprintf("Vault path %s does not exist yet (%s).", full, fieldDescEn),
					FixAction: &PreflightFixAction{
						Type:           "vault_kv",
						Label:          "一键写入密钥",
						LabelEn:        "Write Secret",
						VaultClusterID: appliedIG.TargetClusterID,
						VaultCluster:   appliedIG.TargetClusterName,
						Mount:          sa.mount,
						SecretPath:     sa.logicalSub,
						RequiredKeys:   reqKeys,
						OptionalKeys:   optKeys,
						MissingKeys:    reqKeys,
					},
				})
				continue
			}

			var missing []string
			for _, k := range reqKeys {
				if !keys[k] {
					missing = append(missing, k)
				}
			}
			if len(missing) > 0 {
				addCheck(PreflightCheck{
					ID:       "vault_kv_secret:" + full,
					Kind:     "vault_kv_secret",
					Status:   "error",
					Title:    fmt.Sprintf("Vault 密钥 %s 缺少字段", full),
					TitleEn:  fmt.Sprintf("Vault secret %s missing fields", full),
					Detail:   fmt.Sprintf("路径 %s 已存在，但缺少必需字段：%s。", full, strings.Join(missing, "、")),
					DetailEn: fmt.Sprintf("Path %s exists, but is missing required keys: %s.", full, strings.Join(missing, ", ")),
					FixAction: &PreflightFixAction{
						Type:           "vault_kv",
						Label:          "补全缺失字段",
						LabelEn:        "Fill Missing Keys",
						VaultClusterID: appliedIG.TargetClusterID,
						VaultCluster:   appliedIG.TargetClusterName,
						Mount:          sa.mount,
						SecretPath:     sa.logicalSub,
						RequiredKeys:   reqKeys,
						OptionalKeys:   optKeys,
						ExistingKeys:   existingKeys,
						MissingKeys:    missing,
					},
				})
			} else {
				addCheck(PreflightCheck{
					ID:       "vault_kv_secret:" + full,
					Kind:     "vault_kv_secret",
					Status:   "ok",
					Title:    fmt.Sprintf("Vault 密钥 %s 已就绪", full),
					TitleEn:  fmt.Sprintf("Vault secret %s ready", full),
					Detail:   fmt.Sprintf("已包含全部必需字段（%s）。", orDefault(strings.Join(reqKeys, "、"), "已存在")),
					DetailEn: fmt.Sprintf("All required keys present (%s).", orDefault(strings.Join(reqKeys, ", "), "exists")),
				})
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

func keysForSecret(tmpl, secretRef string) (required []string, optional []string) {
	req := map[string]bool{}
	optAll := map[string]bool{}
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
			optAll[om[1]] = true
		}
		for _, fm := range reDataField.FindAllStringSubmatch(body, -1) {
			if !opt[fm[1]] {
				req[fm[1]] = true
			}
		}
	}
	if !foundBlock {
		return nil, nil
	}
	for k := range req {
		delete(optAll, k)
	}
	return mapKeysSorted(req), mapKeysSorted(optAll)
}

func requiredKeysForSecret(tmpl, secretRef string) []string {
	req, _ := keysForSecret(tmpl, secretRef)
	return req
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
