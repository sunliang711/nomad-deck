package jobs

import (
	"fmt"
	"regexp"
	"strings"
)

// VaultIntegrationRef summarizes a Nomad-Vault integration for pre-submit checks.
type VaultIntegrationRef struct {
	Name             string
	Status           string
	NomadSideEnabled bool
	KVMounts         []string
	Roles            []VaultRoleRef
}

// VaultRoleRef summarizes a workload role within a Nomad-Vault integration.
type VaultRoleRef struct {
	RoleName       string
	Status         string
	BoundNamespace string
	PolicyMode     string
	SecretPaths    []string
}

var reTemplateSecret = regexp.MustCompile(`secret\s+"([^"]+)"`)

// LintVaultIntegration inspects a parsed Nomad Job JSON against the cluster's
// Nomad-Vault integrations and returns human-readable warnings when common
// mistakes are detected (missing/unapplied integration, missing role, namespace
// mismatch, or KV v2 template path missing "/data/").
func LintVaultIntegration(j Job, integrations []VaultIntegrationRef, fallbackNamespace string) []string {
	if j == nil {
		return nil
	}
	jobNS := str(j["Namespace"])
	if jobNS == "" {
		jobNS = orDefault(fallbackNamespace, "default")
	}

	knownMounts := map[string]bool{"secret": true}
	for _, ig := range integrations {
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
	}

	var warns []string
	seen := map[string]bool{}
	add := func(msg string) {
		if msg == "" || seen[msg] {
			return
		}
		seen[msg] = true
		warns = append(warns, msg)
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
			taskName := str(task["Name"])
			if taskName == "" {
				taskName = "task"
			}

			// Check KV v2 template paths even if vault block uses a default role.
			for _, tplRaw := range list(task["Templates"]) {
				tpl := obj(tplRaw)
				if tpl == nil {
					continue
				}
				tmpl := str(tpl["EmbeddedTmpl"])
				if tmpl == "" {
					continue
				}
				for _, match := range reTemplateSecret.FindAllStringSubmatch(tmpl, -1) {
					secretPath := strings.Trim(match[1], "/")
					mnt, rest, ok := strings.Cut(secretPath, "/")
					if !ok || mnt == "" || rest == "" {
						continue
					}
					if knownMounts[mnt] && rest != "data" && !strings.HasPrefix(rest, "data/") &&
						rest != "metadata" && !strings.HasPrefix(rest, "metadata/") {
						add(fmt.Sprintf(
							"Task %q 的 template 中读取 %q 缺少 \"/data/\"：Vault KV v2 模板路径应写成 \"%s/data/%s\"（Role 权限配置中才省略 data/）。",
							taskName, match[1], mnt, rest,
						))
					}
				}
			}

			v := obj(task["Vault"])
			if v == nil {
				continue
			}
			roleName := str(v["Role"])
			if len(integrations) == 0 {
				add(fmt.Sprintf(
					"Task %q 配置了 vault 块（role=%q），但当前 Nomad 集群尚未建立 Nomad-Vault 联动，请先前往「集群联动」创建并应用。",
					taskName, orDefault(roleName, "default"),
				))
				continue
			}
			ig := integrations[0]
			if ig.Status != "applied" || !ig.NomadSideEnabled {
				add(fmt.Sprintf(
					"Task %q 使用了 Vault 联动，但联动配置「%s」尚未应用生效（当前状态：%s），请先在「集群联动」点击「应用联动」。",
					taskName, ig.Name, orDefault(ig.Status, "draft"),
				))
			}
			if roleName == "" {
				continue
			}
			var found *VaultRoleRef
			for i := range ig.Roles {
				if ig.Roles[i].RoleName == roleName {
					found = &ig.Roles[i]
					break
				}
			}
			if found == nil {
				add(fmt.Sprintf(
					"Task %q 引用的 Vault Role %q 在联动「%s」中不存在，请先在「集群联动」添加该 Role 并点击「应用联动」。",
					taskName, roleName, ig.Name,
				))
				continue
			}
			if found.Status != "applied" {
				add(fmt.Sprintf(
					"Task %q 引用的 Vault Role %q 尚未应用生效（当前状态：%s），请先在「集群联动」点击「应用联动」。",
					taskName, roleName, orDefault(found.Status, "draft"),
				))
			}
			if found.BoundNamespace != "" && found.BoundNamespace != jobNS {
				add(fmt.Sprintf(
					"Task %q 引用的 Role %q 仅允许 Nomad Namespace %q，而当前 Job 的 Namespace 为 %q，运行时会被 Vault 拒绝。",
					taskName, roleName, found.BoundNamespace, jobNS,
				))
			}
		}
	}
	return warns
}
