package rotation

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"nomad-deck/internal/audit"
	_ "nomad-deck/internal/backup"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	_ "nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/snapstore"
)

func seedAllEncrypted(t *testing.T, d *db.DB, keys *crypto.Keyring, snapPath string) {
	t.Helper()
	enc := func(pt, aad string) string {
		ct, err := keys.EncryptString(pt, aad)
		if err != nil {
			t.Fatal(err)
		}
		return ct
	}
	now := d.NowString()
	stmts := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO system_settings (key, value, is_secret, updated_at) VALUES ('proxy.password', ?, 1, ?), ('backup.targets', ?, 1, ?)`,
			[]any{enc("pw", db.SettingAAD("proxy.password")), now, enc(`[{"id":"t1"}]`, db.SettingAAD("backup.targets")), now}},
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
		if _, err := d.Writer.Exec(st.q, st.args...); err != nil {
			t.Fatalf("%s: %v", st.q, err)
		}
	}
	if snapPath != "" {
		w, err := snapstore.Create(keys, snapPath, "sn1")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte("snapshot-body"))
		sha, err := w.Close()
		if err != nil {
			t.Fatal(err)
		}
		if err := db.InsertSnapshot(context.Background(), d.Writer, &db.Snapshot{
			ID: "sn1", ClusterID: "c1", ClusterType: "vault", ProductVersion: "1.21.1",
			FilePath: snapPath, SizeBytes: 13, SHA256: sha, TriggerType: "manual", TriggeredBy: "root", CreatedAt: d.Now(),
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRotationResumableAndVerified(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "main.db")
	d, err := db.Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	k1 := bytes.Repeat([]byte{1}, 32)
	k2 := bytes.Repeat([]byte{2}, 32)
	kr1, _ := crypto.NewKeyringForTest(k1)
	kr12, _ := crypto.NewKeyringForTest(k1, k2)
	kr2, _ := crypto.NewKeyringForTest(k2)

	snapPath := filepath.Join(dir, "snapshots", "c1", "sn1.snap")
	seedAllEncrypted(t, d, kr1, snapPath)

	// Create a pre-upgrade DB backup encrypted with k1.
	backupDir := filepath.Join(dir, "backups")
	_ = os.MkdirAll(backupDir, 0o700)
	prePath := filepath.Join(backupDir, "pre-upgrade-0.1.0-0.2.0.db")
	preDB, err := db.Open(ctx, prePath)
	if err != nil {
		t.Fatal(err)
	}
	seedAllEncrypted(t, preDB, kr1, "")
	preDB.Close()

	// Prematurely dropping k1 before rotation must fail self-check.
	probs, err := db.CheckKeyIDs(ctx, d.Reader, crypto.KeyIDOf, kr2.Has)
	if err != nil || len(probs) == 0 {
		t.Fatalf("expected problems when k1 missing before rotation, got %v err=%v", probs, err)
	}

	// Simulate an interrupted prior journal row for (k1, k2).
	if err := db.InsertKeyRotation(ctx, d.Writer, &db.KeyRotationJournal{
		ID: "rot-1", OldKeyID: kr1.Primary().ID, NewKeyID: kr2.Primary().ID,
		State: "running", ProgressJSON: `{"db_fields":{}}`, StartedBy: "root", StartedAt: d.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &Service{
		DB: d, Keys: kr12, Audit: &audit.Recorder{DB: d, Log: log},
		Ops: ops.NewEngine(d, log, dir), DataDir: dir, Log: log,
	}
	jv, err := svc.RunSync(ctx, audit.Actor{Name: "root"})
	if err != nil {
		t.Fatalf("RunSync: %v", err)
	}
	if jv.ID != "rot-1" || jv.State != "completed" || !jv.Progress.VerifiedClean || jv.Progress.SnapshotsDone != 1 || jv.Progress.BackupsDone != 1 {
		t.Fatalf("unexpected journal result: %+v", jv)
	}

	// Reload with k2 only: DB, snapshot header and pre-upgrade DB must all pass.
	if probs, err := db.CheckKeyIDs(ctx, d.Reader, crypto.KeyIDOf, kr2.Has); err != nil || len(probs) > 0 {
		t.Fatalf("k2-only DB check failed: %v err=%v", probs, err)
	}
	kid, err := snapstore.HeaderKeyID(snapPath)
	if err != nil || kid != kr2.Primary().ID {
		t.Fatalf("snapshot header key_id=%q err=%v", kid, err)
	}
	sn, _ := db.GetSnapshot(ctx, d.Reader, "sn1")
	sr, err := snapstore.Open(kr2, snapPath, "sn1", sn.SHA256)
	if err != nil {
		t.Fatalf("open snapshot with k2 only: %v", err)
	}
	gotSnap, _ := io.ReadAll(sr)
	sr.Close()
	if string(gotSnap) != "snapshot-body" {
		t.Fatalf("snapshot body mismatch: %q", gotSnap)
	}

	preCheck, err := sql.Open("sqlite", "file:"+prePath+"?_pragma=query_only(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer preCheck.Close()
	if probs, err := db.CheckKeyIDs(ctx, preCheck, crypto.KeyIDOf, kr2.Has); err != nil || len(probs) > 0 {
		t.Fatalf("k2-only pre-upgrade DB check failed: %v err=%v", probs, err)
	}
}
