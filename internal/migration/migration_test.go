package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	_ "nomad-deck/internal/nomad" // registers the Docker proxy encrypted fields
	"nomad-deck/internal/ops"
)

// Every encrypted location known to the startup self-check must be
// handled by bundles.
func TestSecretRegistryCoversEncryptedFields(t *testing.T) {
	known := map[string]bool{}
	for _, c := range db.SecretColumns {
		known[c.Field] = true
		if !contains(insertOrder, c.Table) {
			t.Errorf("secret column %s is in a table bundles never carry", c.Field)
		}
	}
	for _, f := range db.EncryptedFields {
		if !known[f.Name] {
			t.Errorf("encrypted field %s has no SecretColumn", f.Name)
		}
	}
}

func instance(t *testing.T, keyByte byte) *Service {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{keyByte}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := ops.NewEngine(d, log, dir)
	return &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Ops: engine, DataDir: dir, Log: log}
}

func TestEverySecretRoundTrips(t *testing.T) {
	ctx := context.Background()
	src := instance(t, 1)
	enc := func(pt, aad string) string {
		ct, err := src.Keys.EncryptString(pt, aad)
		if err != nil {
			t.Fatal(err)
		}
		return ct
	}
	now := src.DB.NowString()
	stmts := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO system_settings (key, value, is_secret, updated_at) VALUES ('proxy.password', ?, 1, ?), ('control_plane.activated', 'true', 0, ?)`,
			[]any{enc("pw", db.SettingAAD("proxy.password")), now, now}},
		{`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
			VALUES ('k1', 'k', 'ed25519', 'p', ?, 'fp', 1, ?, ?)`, []any{enc("ssh-private", db.SSHKeyAAD("k1")), now, now}},
		{`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, docker_config_json, created_at, updated_at)
			VALUES ('n1', 'n', '10.0.0.1', 'root', 'k1', ?, ?, ?)`,
			[]any{`{"pull_proxy":{"url":"http://p:3128","password_encrypted":"` + enc("node-proxy", db.NodePullProxyAAD("n1")) + `"}}`, now, now}},
		{`INSERT INTO clusters (id, name, type, mode, ca_key_encrypted, client_key_encrypted, gossip_key_encrypted, gossip_key_pending_encrypted,
			admin_token_encrypted, config_json, created_at, updated_at) VALUES ('c1', 'c', 'vault', 'single', ?, ?, ?, ?, ?, ?, ?, ?)`,
			[]any{enc("ca", db.ClusterCAKeyAAD("c1")), enc("client", db.ClusterClientKeyAAD("c1")), enc("gossip", db.ClusterGossipKeyAAD("c1")),
				enc("pending", db.ClusterGossipPendingAAD("c1")), enc("token", db.ClusterAdminTokenAAD("c1")),
				`{"docker_defaults":{"pull_proxy":{"password_encrypted":"` + enc("cluster-proxy", db.ClusterPullProxyAAD("c1")) + `"}}}`, now, now}},
		{`INSERT INTO vault_secrets_custody (cluster_id, bootstrap_root_token_encrypted, admin_token_encrypted, updated_at) VALUES ('c1', ?, ?, ?)`,
			[]any{enc("root", db.VaultRootTokenAAD("c1")), enc("vault-admin", db.VaultAdminTokenAAD("c1")), now}},
		{`INSERT INTO vault_unseal_key_generations (cluster_id, generation, key_shares, key_threshold, unseal_keys_encrypted, state, created_at)
			VALUES ('c1', 2, 5, 3, ?, 'active', ?)`, []any{enc(`["k1","k2"]`, db.VaultUnsealKeysAAD("c1", 2)), now}},
		{`INSERT INTO job_revisions (id, cluster_id, namespace, job_id, revision_no, source, edit_mode, variables_encrypted, job_json_encrypted,
			submit_status, created_at) VALUES ('r1', 'c1', 'default', 'web', 1, 'workbench', 'hcl', ?, ?, 'confirmed', ?)`,
			[]any{enc("vars", db.JobVariablesAAD("r1")), enc("{}", db.JobJSONAAD("r1")), now}},
	}
	for _, st := range stmts {
		if _, err := src.DB.Writer.Exec(st.q, st.args...); err != nil {
			t.Fatalf("%s: %v", st.q, err)
		}
	}
	var buf bytes.Buffer
	m, err := src.Export(ctx, ExportOptions{Include: []string{"job_revisions"}, Passphrase: "long-enough-pass", CreatedBy: "t"}, &buf)
	if err != nil {
		t.Fatal(err)
	}
	if m.Rows["system_settings"] != 1 {
		t.Fatalf("instance-local settings are not exported: %v", m.Rows)
	}
	for _, s := range []string{"ssh-private", "vault-admin", "node-proxy"} {
		if bytes.Contains(buf.Bytes(), []byte(s)) {
			t.Fatalf("%s visible in the bundle", s)
		}
	}
	if got, err := ReadManifest(io.NopCloser(bytes.NewReader(buf.Bytes())), "long-enough-pass"); err != nil || got.Rows["clusters"] != 1 {
		t.Fatalf("manifest: %+v %v", got, err)
	}

	dst := instance(t, 2)
	if _, err := dst.DB.Writer.Exec(`INSERT INTO admins (id, username, password_hash, role, created_at, updated_at) VALUES ('a', 'root', 'x', 'admin', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	rep, err := dst.Preview(ctx, "s", "a", bytes.NewReader(buf.Bytes()), "long-enough-pass", StrategyReplace)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dst.Apply(ctx, audit.Actor{Name: "root"}, "other-session", "a", rep.PreviewToken); err == nil {
		t.Fatal("a preview token is bound to its session")
	}
	rep, _ = dst.Preview(ctx, "s", "a", bytes.NewReader(buf.Bytes()), "long-enough-pass", StrategyReplace)
	if _, err := dst.Apply(ctx, audit.Actor{Name: "root"}, "s", "a", rep.PreviewToken); err != nil {
		t.Fatal(err)
	}
	if dst.Ops.Barrier() != "" {
		t.Fatal("the barrier is lowered after the import")
	}
	// Every secret decrypts with the target key under its row binding.
	for _, sc := range db.SecretColumns {
		rows, err := dst.DB.Reader.Query(`SELECT * FROM ` + sc.Table)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		found := false
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			_ = rows.Scan(ptrs...)
			row := map[string]any{}
			for i, c := range cols {
				row[c] = vals[i]
			}
			if sc.Applies != nil && !sc.Applies(row) {
				continue
			}
			ct := db.RowString(row, sc.Column)
			if len(sc.JSONPath) > 0 {
				doc := map[string]any{}
				_ = jsonUnmarshal(ct, &doc)
				parent, leaf := walk(doc, sc.JSONPath, false)
				if parent == nil {
					continue
				}
				ct, _ = parent[leaf].(string)
			}
			if ct == "" {
				continue
			}
			if _, err := src.Keys.Decrypt(ct, sc.AAD(row)); err == nil {
				t.Errorf("%s still uses the source key", sc.Field)
			}
			if _, err := dst.Keys.Decrypt(ct, sc.AAD(row)); err != nil {
				t.Errorf("%s: %v", sc.Field, err)
			}
			found = true
		}
		rows.Close()
		if !found {
			t.Errorf("%s was not restored", sc.Field)
		}
	}
	// A bundle with a different schema version is refused.
	if _, err := dst.DB.Writer.Exec(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', ?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := dst.Preview(ctx, "s", "a", bytes.NewReader(buf.Bytes()), "long-enough-pass", StrategyReplace); err == nil ||
		!strings.Contains(err.Error(), "结构版本") {
		t.Fatalf("schema mismatch: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dst.DataDir, "tmp", "imports"))
	if len(entries) != 0 {
		t.Fatalf("uploaded bundles are removed, %d left", len(entries))
	}
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
