package jobs

import (
	"strings"
	"testing"
)

func TestLintVaultIntegration(t *testing.T) {
	job := Job{
		"Namespace": "default",
		"TaskGroups": []any{
			map[string]any{
				"Name": "db",
				"Tasks": []any{
					map[string]any{
						"Name":  "postgres",
						"Vault": map[string]any{"Role": "postgres"},
						"Templates": []any{
							map[string]any{
								"EmbeddedTmpl": `{{ with secret "secret/apps/postgres" }}{{ .Data.data.password }}{{ end }}`,
							},
						},
					},
				},
			},
		},
	}

	// Missing integration + missing /data/ in KV v2 path.
	warns := LintVaultIntegration(job, nil, "default")
	if len(warns) != 2 {
		t.Fatalf("expected 2 warnings, got %d: %v", len(warns), warns)
	}
	if !strings.Contains(warns[1], "secret/data/apps/postgres") && !strings.Contains(warns[0], "secret/data/apps/postgres") {
		t.Fatalf("expected /data/ hint, got: %v", warns)
	}

	// Unapplied role + namespace mismatch.
	igs := []VaultIntegrationRef{{
		Name:             "nomad-vault",
		Status:           "applied",
		NomadSideEnabled: true,
		KVMounts:         []string{"secret"},
		Roles: []VaultRoleRef{{
			RoleName:       "postgres",
			Status:         "draft",
			BoundNamespace: "prod",
		}},
	}}
	job["TaskGroups"].([]any)[0].(map[string]any)["Tasks"].([]any)[0].(map[string]any)["Templates"] = []any{
		map[string]any{"EmbeddedTmpl": `{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}`},
	}
	warns = LintVaultIntegration(job, igs, "default")
	joined := strings.Join(warns, "\n")
	if len(warns) != 2 || !strings.Contains(joined, "尚未应用") || !strings.Contains(joined, "Namespace") {
		t.Fatalf("unexpected warnings: %v", warns)
	}

	// Clean configuration produces no warnings.
	igs[0].Roles[0].Status = "applied"
	igs[0].Roles[0].BoundNamespace = "default"
	if warns = LintVaultIntegration(job, igs, "default"); len(warns) != 0 {
		t.Fatalf("expected no warnings, got: %v", warns)
	}

	// Drifted integration must produce a blocking error.
	igs[0].ConfigDrifted = true
	igs[0].DriftReasons = []string{"Vault 集群 CA 证书已变更"}
	rep := AnalyzeJobRequirements(job, igs, "default", nil, false)
	if len(rep.Blocking) == 0 || !strings.Contains(strings.Join(rep.Blocking, "\n"), "配置漂移") {
		t.Fatalf("expected drifted integration blocker, got: %+v", rep)
	}
}

func TestAnalyzeJobRequirementsKVAndPairedConfigs(t *testing.T) {
	pgJob := Job{
		"Namespace": "default",
		"TaskGroups": []any{
			map[string]any{
				"Name": "db",
				"Tasks": []any{
					map[string]any{
						"Name":  "postgres",
						"Vault": map[string]any{"Role": "postgres"},
						"Templates": []any{
							map[string]any{
								"DestPath": "secrets/pg.env",
								"EmbeddedTmpl": `{{ with secret "secret/data/apps/postgres" }}
USER={{ .Data.data.username | toJSON }}
PASS={{ .Data.data.password | toJSON }}
OPT={{ or .Data.data.optional_note "" | toJSON }}
{{ end }}`,
							},
						},
					},
				},
			},
		},
	}

	// 1. KV mount queried and missing "secret".
	igs := []VaultIntegrationRef{{
		Name:             "nomad-vault",
		Status:           "applied",
		NomadSideEnabled: true,
		TargetClusterID:  "v1",
		KVMountsQueried:  true,
		KVMounts:         []string{},
		Roles: []VaultRoleRef{{
			RoleName:       "postgres",
			Status:         "applied",
			BoundNamespace: "default",
			PolicyMode:     "explicit",
			SecretPaths:    []string{"secret/apps/postgres"},
		}},
	}}
	rep := AnalyzeJobRequirements(pgJob, igs, "default", nil, false)
	if len(rep.Blocking) == 0 || !strings.Contains(strings.Join(rep.Blocking, "\n"), "尚未启用该 KV v2 引擎") {
		t.Fatalf("expected missing KV mount blocker, got: %+v", rep)
	}

	// 2. Role exact path mismatch (secret/apps does not cover secret/apps/postgres).
	igs[0].KVMounts = []string{"secret"}
	igs[0].Roles[0].SecretPaths = []string{"secret/apps"}
	rep = AnalyzeJobRequirements(pgJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return map[string]bool{"username": true, "password": true}, true, nil
	}, false)
	if !strings.Contains(strings.Join(rep.Blocking, "\n"), "未覆盖该路径") {
		t.Fatalf("expected role path mismatch blocker, got: %+v", rep)
	}

	// 3. Missing secret in Vault.
	igs[0].Roles[0].SecretPaths = []string{"secret/apps/*"}
	rep = AnalyzeJobRequirements(pgJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return nil, false, nil
	}, false)
	if !strings.Contains(strings.Join(rep.Blocking, "\n"), "在 Vault 中尚不存在") {
		t.Fatalf("expected missing secret blocker, got: %+v", rep)
	}

	// 4. Secret exists but missing required key "password"; missing optional_note must NOT trigger.
	rep = AnalyzeJobRequirements(pgJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return map[string]bool{"username": true}, true, nil
	}, false)
	joined := strings.Join(rep.Blocking, "\n")
	if !strings.Contains(joined, `"password"`) || strings.Contains(joined, "optional_note") {
		t.Fatalf("expected missing required key password without optional_note false positive, got: %+v", rep)
	}

	// 5. All required keys present -> passes cleanly.
	rep = AnalyzeJobRequirements(pgJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return map[string]bool{"username": true, "password": true}, true, nil
	}, false)
	if len(rep.Blocking) != 0 {
		t.Fatalf("expected zero blockers when keys exist, got: %+v", rep)
	}

	// 6. acme-cert-sync write permission check.
	acmeJob := Job{
		"Namespace": "default",
		"TaskGroups": []any{map[string]any{
			"Name": "acme",
			"Tasks": []any{map[string]any{
				"Name":  "renew",
				"Vault": map[string]any{"Role": "acme-cert-sync"},
				"Templates": []any{map[string]any{
					"DestPath":     "local/sync.sh",
					"EmbeddedTmpl": "curl -fsS -X POST -H \"X-Vault-Token: $VAULT_TOKEN\" \"$VAULT_ADDR/v1/$VAULT_KV_PATH\"",
				}},
			}},
		}},
	}
	igs[0].Roles = append(igs[0].Roles, VaultRoleRef{
		RoleName: "acme-cert-sync", Status: "applied", PolicyMode: "explicit", SecretPaths: []string{"secret/certs/*"},
	})
	rep = AnalyzeJobRequirements(acmeJob, igs, "default", nil, false)
	if !strings.Contains(strings.Join(rep.Blocking, "\n"), "create/update") {
		t.Fatalf("expected write policy blocker for acme-cert-sync, got: %+v", rep)
	}

	// CustomPolicyHCL with create/update on policy_mode="explicit" (real UI form mode) must pass.
	igs[0].Roles[1].CustomPolicyHCL = `path "secret/data/certs/tls" { capabilities = ["create", "update", "read"] }`
	rep = AnalyzeJobRequirements(acmeJob, igs, "default", nil, false)
	if len(rep.Blocking) != 0 {
		t.Fatalf("expected custom write policy under explicit mode to pass, got: %+v", rep)
	}

	// 7. Nginx active /secrets/cert.pem without vault/cert template, and Traefik alidns without AK/SK.
	gwJob := Job{
		"Namespace": "default",
		"TaskGroups": []any{map[string]any{
			"Name": "gw",
			"Tasks": []any{
				map[string]any{
					"Name": "nginx",
					"Templates": []any{map[string]any{
						"DestPath":     "local/nginx.conf",
						"EmbeddedTmpl": "server {\n  listen 443 ssl;\n  ssl_certificate /secrets/cert.pem;\n}",
					}},
				},
				map[string]any{
					"Name":   "traefik",
					"Config": map[string]any{"volumes": []any{"local/traefik.yml:/etc/traefik/traefik.yml"}},
					"Templates": []any{map[string]any{
						"DestPath": "local/traefik.yml",
						"EmbeddedTmpl": `providers:
  nomad:
    endpoint:
      tls:
        ca: /etc/ssl/nomad-ca.pem
certificatesResolvers:
  alidns:
    acme:
      dnsChallenge:
        provider: alidns`,
					}},
				},
			},
		}},
	}
	rep = AnalyzeJobRequirements(gwJob, nil, "default", nil, true)
	msg := strings.Join(rep.Blocking, "\n")
	if !strings.Contains(msg, "secrets/cert.pem") || !strings.Contains(msg, "nomad-ca.pem") || !strings.Contains(msg, "ALICLOUD_ACCESS_KEY") {
		t.Fatalf("expected paired nginx/traefik blockers, got: %+v", rep)
	}
	if !strings.Contains(strings.Join(rep.Warnings, "\n"), "NOMAD_TOKEN") {
		t.Fatalf("expected NOMAD_TOKEN ACL warning for traefik providers.nomad, got: %+v", rep)
	}
}

func TestAnalyzeJobRequirementsStructuredChecksAndFixActions(t *testing.T) {
	// Multi-template job reading the same secret path (like postgres blueprint).
	pgJob := Job{
		"Namespace": "default",
		"TaskGroups": []any{
			map[string]any{
				"Name": "database",
				"Tasks": []any{
					map[string]any{
						"Name":  "postgres",
						"Vault": map[string]any{"Role": "postgres"},
						"Templates": []any{
							map[string]any{
								"DestPath":     "secrets/postgres-password",
								"EmbeddedTmpl": `{{ with secret "secret/data/apps/postgres" }}{{ .Data.data.password }}{{ end }}`,
							},
							map[string]any{
								"DestPath": "secrets/postgres.env",
								"EmbeddedTmpl": `{{ with secret "secret/data/apps/postgres" }}
POSTGRES_USER={{ .Data.data.username | toJSON }}
POSTGRES_DB={{ .Data.data.database | toJSON }}
EXTRA={{ or .Data.data.extra_note "" | toJSON }}
{{ end }}`,
							},
						},
					},
				},
			},
		},
	}

	igs := []VaultIntegrationRef{{
		ID:                "ig-1",
		Name:              "nomad-vault",
		Status:            "applied",
		NomadSideEnabled:  true,
		TargetClusterID:   "vault-1",
		TargetClusterName: "prod-vault",
		KVMountsQueried:   true,
		KVMounts:          []string{"secret"},
		Roles:             nil,
	}}

	// Role missing, secret partially exists (only username).
	rep := AnalyzeJobRequirements(pgJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return map[string]bool{"username": true}, true, nil
	}, false)

	var igChk, roleChk, kvChk *PreflightCheck
	for i := range rep.Checks {
		switch rep.Checks[i].Kind {
		case "vault_integration":
			igChk = &rep.Checks[i]
		case "vault_role":
			roleChk = &rep.Checks[i]
		case "vault_kv_secret":
			kvChk = &rep.Checks[i]
		}
	}
	if igChk == nil || igChk.Status != "ok" {
		t.Fatalf("expected ok vault_integration check, got: %+v", igChk)
	}
	if roleChk == nil || roleChk.Status != "error" || roleChk.FixAction == nil {
		t.Fatalf("expected error vault_role check with fix_action, got: %+v", roleChk)
	}
	if roleChk.FixAction.Type != "vault_role" || roleChk.FixAction.IntegrationID != "ig-1" || roleChk.FixAction.RoleName != "postgres" {
		t.Fatalf("unexpected role fix_action: %+v", roleChk.FixAction)
	}
	if len(roleChk.FixAction.SecretPaths) != 1 || roleChk.FixAction.SecretPaths[0] != "secret/apps/postgres" {
		t.Fatalf("expected role secret_paths [secret/apps/postgres], got: %+v", roleChk.FixAction.SecretPaths)
	}
	if kvChk == nil || kvChk.Status != "error" || kvChk.FixAction == nil {
		t.Fatalf("expected error vault_kv_secret check with fix_action, got: %+v", kvChk)
	}
	if kvChk.FixAction.Type != "vault_kv" || kvChk.FixAction.VaultClusterID != "vault-1" || kvChk.FixAction.Mount != "secret" || kvChk.FixAction.SecretPath != "apps/postgres" {
		t.Fatalf("unexpected kv fix_action: %+v", kvChk.FixAction)
	}
	// Aggregated required keys across BOTH templates: database, password, username.
	if got := strings.Join(kvChk.FixAction.RequiredKeys, ","); got != "database,password,username" {
		t.Fatalf("expected aggregated required_keys database,password,username, got: %s", got)
	}
	if got := strings.Join(kvChk.FixAction.MissingKeys, ","); got != "database,password" {
		t.Fatalf("expected missing_keys database,password, got: %s", got)
	}
	if got := strings.Join(kvChk.FixAction.OptionalKeys, ","); got != "extra_note" {
		t.Fatalf("expected optional_keys extra_note, got: %s", got)
	}

	// acme-cert-sync write role should synthesize custom_policy_hcl with read + create/update.
	acmeJob := Job{
		"Namespace": "default",
		"TaskGroups": []any{map[string]any{
			"Name": "acme",
			"Tasks": []any{map[string]any{
				"Name":  "renew",
				"Vault": map[string]any{"Role": "acme-cert-sync"},
				"Templates": []any{
					map[string]any{
						"DestPath": "secrets/acme.env",
						"EmbeddedTmpl": `{{ with secret "secret/data/certs/dns" }}
DOMAIN={{ .Data.data.domain | toJSON }}
VAULT_KV_PATH={{ or .Data.data.vault_kv_path "secret/data/certs/tls" | toJSON }}
{{ end }}`,
					},
					map[string]any{
						"DestPath":     "local/sync.sh",
						"EmbeddedTmpl": `curl -fsS -X POST -H "X-Vault-Token: $VAULT_TOKEN" "$BASE_URL/v1/$VAULT_KV_PATH"`,
					},
				},
			}},
		}},
	}
	rep = AnalyzeJobRequirements(acmeJob, igs, "default", func(_, _, _ string) (map[string]bool, bool, error) {
		return nil, false, nil
	}, false)
	var acmeRoleChk *PreflightCheck
	for i := range rep.Checks {
		if rep.Checks[i].Kind == "vault_role" {
			acmeRoleChk = &rep.Checks[i]
		}
	}
	if acmeRoleChk == nil || acmeRoleChk.FixAction == nil {
		t.Fatalf("expected acme role check with fix action, got: %+v", rep.Checks)
	}
	pol := acmeRoleChk.FixAction.CustomPolicyHCL
	if !strings.Contains(pol, `"secret/data/certs/dns"`) || !strings.Contains(pol, `"secret/data/certs/tls"`) || !strings.Contains(pol, `"create"`) {
		t.Fatalf("expected synthesized custom policy HCL for acme-cert-sync, got:\n%s", pol)
	}
}
