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
	if !strings.Contains(warns[0], "secret/data/apps/postgres") {
		t.Fatalf("expected /data/ hint, got: %s", warns[0])
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
	if len(warns) != 2 || !strings.Contains(warns[0], "尚未应用") || !strings.Contains(warns[1], "Namespace") {
		t.Fatalf("unexpected warnings: %v", warns)
	}

	// Clean configuration produces no warnings.
	igs[0].Roles[0].Status = "applied"
	igs[0].Roles[0].BoundNamespace = "default"
	if warns = LintVaultIntegration(job, igs, "default"); len(warns) != 0 {
		t.Fatalf("expected no warnings, got: %v", warns)
	}
}
