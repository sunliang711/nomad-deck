package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"nomad-deck/internal/api"
	"nomad-deck/internal/config"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/snapstore"
)

func TestBackupAndDashboardRoutes(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	viewer := e.makeViewer(t, root)

	// Seed a node with clock skew > 30s and a Vault cluster with expiring cert + suppressed unseal.
	ctx := context.Background()
	now := e.app.DB.Now()
	if code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": "n1", "host": "10.0.0.10", "ssh_user": "ops", "use_sudo": true}, nil); code != 201 {
		t.Fatalf("node: %d %v", code, b)
	}
	_, _ = e.app.DB.Writer.Exec(`UPDATE nodes SET status = 'online', time_sync = 'unsynced', clock_skew_ms = 45000 WHERE name = 'n1'`)

	var nodeID string
	_ = e.app.DB.Reader.QueryRow(`SELECT id FROM nodes WHERE name = 'n1'`).Scan(&nodeID)
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{
		"type": "vault", "name": "v-dash", "mode": "single",
		"nodes": []any{map[string]any{"node_id": nodeID}},
	}, nil); code != 201 {
		t.Fatalf("cluster: %d %v", code, b)
	}
	var clusterID string
	_ = e.app.DB.Reader.QueryRow(`SELECT id FROM clusters WHERE name = 'v-dash'`).Scan(&clusterID)
	expSoon := db.FormatTime(now.Add(48 * time.Hour))
	_, err := e.app.DB.Writer.Exec(`UPDATE clusters SET init_state = 'initialized', health_status = 'degraded', ca_expires_at = ? WHERE id = ?`, expSoon, clusterID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.app.DB.Writer.Exec(`UPDATE vault_secrets_custody SET initialized = 1, unseal_suppressed_reason = 'manual_seal', admin_token_expires_at = ?, updated_at = ? WHERE cluster_id = ?`,
		db.FormatTime(now.Add(2*time.Hour)), db.FormatTime(now), clusterID)
	if err != nil {
		t.Fatal(err)
	}

	// Viewer cannot access backup config or run backup.
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/v1/backup/config"},
		{"PUT", "/api/v1/backup/config"},
		{"POST", "/api/v1/backup/run"},
		{"GET", "/api/v1/settings/master-key"},
		{"POST", "/api/v1/settings/master-key/rotate"},
	} {
		if code, _ := viewer.do(tc.method, tc.path, map[string]any{}, nil); code != 403 {
			t.Fatalf("viewer %s %s got %d, want 403", tc.method, tc.path, code)
		}
	}

	// Wrong secondary password rejected on PUT /api/v1/backup/config.
	localDir := filepath.Join(t.TempDir(), "dr")
	if code, _ := root.do("PUT", "/api/v1/backup/config", map[string]any{
		"current_password": "wrong-password",
		"enabled":          true,
		"passphrase":       "backup-secret-passphrase",
		"targets":          []any{map[string]any{"name": "loc", "type": "local", "enabled": true, "path": localDir}},
	}, nil); code != 403 {
		t.Fatalf("wrong password got %d, want 403", code)
	}

	// Test target endpoint.
	if code, b := root.do("POST", "/api/v1/backup/targets/test", map[string]any{
		"name": "loc", "type": "local", "enabled": true, "path": localDir,
	}, nil); code != 200 || b["result"].(map[string]any)["ok"] != true {
		t.Fatalf("target test: %d %v", code, b)
	}

	// Save backup config with local target (no offsite -> missing_offsite_target = true).
	if code, b := root.do("PUT", "/api/v1/backup/config", map[string]any{
		"current_password": adminPass,
		"enabled":          true,
		"passphrase":       "backup-secret-passphrase",
		"include_history":  []string{"audit_logs"},
		"targets":          []any{map[string]any{"id": "t-loc", "name": "loc", "type": "local", "enabled": true, "path": localDir, "retention_count": 2}},
	}, nil); code != 200 {
		t.Fatalf("save backup config: %d %v", code, b)
	}

	// Manual backup run.
	if code, b := root.do("POST", "/api/v1/backup/run", nil, nil); code != 200 {
		t.Fatalf("manual backup: %d %v", code, b)
	}
	if code, b := root.do("GET", "/api/v1/backup/history", nil, nil); code != 200 || len(b["runs"].([]any)) != 1 {
		t.Fatalf("backup history: %d %v", code, b)
	}

	// Expanded settings validation & save.
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{
		"upgrade.max_minor_skip":       3,
		"nomad.exec_idle_minutes":      20,
		"nomad.exec_max_minutes":       180,
		"self_update.channel":          "prerelease",
		"self_update.backup_retention": 5,
	}, nil); code != 200 {
		t.Fatalf("put settings: %d %v", code, b)
	}

	// Dashboard summary accessible by viewer too.
	code, dash := viewer.do("GET", "/api/v1/dashboard/summary", nil, nil)
	if code != 200 {
		t.Fatalf("dashboard: %d %v", code, dash)
	}
	if len(dash["cert_alerts"].([]any)) == 0 {
		t.Fatalf("expected cert_alerts in dashboard: %v", dash)
	}
	if len(dash["vault_alerts"].([]any)) < 2 {
		t.Fatalf("expected vault_alerts in dashboard: %v", dash["vault_alerts"])
	}
	nodesMap := dash["nodes"].(map[string]any)
	if len(nodesMap["clock_skew_alerts"].([]any)) != 1 {
		t.Fatalf("expected clock_skew_alert: %v", nodesMap)
	}
	ba := dash["backup_alerts"].(map[string]any)
	if ba["missing_offsite_target"] != true {
		t.Fatalf("expected missing_offsite_target=true: %v", ba)
	}

	// Node log stream validates bad node membership & query args.
	if code, _ := viewer.do("GET", "/api/v1/clusters/"+clusterID+"/nodes/nonexistent/logs/stream", nil, nil); code != 404 {
		t.Fatalf("non-member node logs got %d, want 404", code)
	}
	if code, _ := viewer.do("GET", "/api/v1/clusters/"+clusterID+"/nodes/"+nodeID+"/logs/stream?lines=99999", nil, nil); code != 400 {
		t.Fatalf("invalid lines got %d, want 400", code)
	}
	_ = ctx
}

func TestMasterKeyRotationAPIAndSnapshotGuard(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)

	// Add a cluster and snapshot encrypted with current primary key.
	ctx := context.Background()
	now := e.app.DB.Now()
	if err := db.InsertCluster(ctx, e.app.DB.Writer, &db.Cluster{
		ID: "c-rot", Name: "rot-cl", Type: "vault", Mode: "single", TLSConfigJSON: "{}",
		APIEndpointsJSON: "[]", ConfigJSON: "{}", InitState: db.InitInitialized,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	snapPath := filepath.Join(e.app.Config.DataDir, "snapshots", "c-rot", "sn-rot.snap")
	w, err := snapstore.Create(e.app.Keys, snapPath, "sn-rot")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("snap"))
	sha, _ := w.Close()
	if err := db.InsertSnapshot(ctx, e.app.DB.Writer, &db.Snapshot{
		ID: "sn-rot", ClusterID: "c-rot", ClusterType: "vault", ProductVersion: "1.21.1",
		FilePath: snapPath, SizeBytes: 4, SHA256: sha, TriggerType: "manual", TriggeredBy: "root", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// Without next key, rotate returns 409.
	if code, _ := root.do("POST", "/api/v1/settings/master-key/rotate", map[string]any{"current_password": adminPass}, nil); code != 409 {
		t.Fatalf("rotate without next key got %d, want 409", code)
	}

	// Swap in a two-key keyring on e.app.Rotation and verify startup snapshot check rejects missing key.
	k1Raw := bytes.Repeat([]byte{7}, 32)
	k2Raw := bytes.Repeat([]byte{8}, 32)
	kr1, _ := crypto.NewKeyringForTest(k1Raw)
	kr2Only, _ := crypto.NewKeyringForTest(k2Raw)
	snap2 := filepath.Join(e.app.Config.DataDir, "snapshots", "c-rot", "sn-k1.snap")
	w2, _ := snapstore.Create(kr1, snap2, "sn-k1")
	_, _ = w2.Write([]byte("x"))
	sha2, _ := w2.Close()
	if err := db.InsertSnapshot(ctx, e.app.DB.Writer, &db.Snapshot{
		ID: "sn-k1", ClusterID: "c-rot", ClusterType: "vault", ProductVersion: "1.21.1",
		FilePath: snap2, SizeBytes: 1, SHA256: sha2, TriggerType: "manual", TriggeredBy: "root", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if kid, err := snapstore.HeaderKeyID(snap2); err != nil || kr2Only.Has(kid) {
		t.Fatalf("expected kr2Only not to have %q", kid)
	}
	_ = os.Remove(snap2)
	_, _ = e.app.DB.Writer.Exec(`DELETE FROM cluster_snapshots WHERE id = 'sn-k1'`)

	// Check master-key status JSON shape.
	code, b := root.do("GET", "/api/v1/settings/master-key", nil, nil)
	if code != 200 {
		t.Fatalf("master-key status: %d %v", code, b)
	}
	mk := b["master_key"].(map[string]any)
	if mk["rotation_ready"] != false || mk["primary_key_id"] == "" {
		t.Fatalf("unexpected master_key status: %s", mustRaw(mk))
	}
}

func TestMasterKeyRotationEndToEndAndStartupSelfCheck(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	k1 := bytes.Repeat([]byte{3}, 32)
	k2 := bytes.Repeat([]byte{4}, 32)
	_ = os.WriteFile(filepath.Join(dir, "master.key"), []byte(fmtHexKey(k1)), 0o600)

	cfg := config.Default()
	cfg.DataDir = dir
	cfg.Server.PublicURL = origin
	cfg.TLS.Mode = config.TLSModeProxy
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	app1, err := Open(ctx, &cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	now := app1.DB.Now()
	if err := db.InsertCluster(ctx, app1.DB.Writer, &db.Cluster{
		ID: "c-rt", Name: "rt-cl", Type: "vault", Mode: "single", TLSConfigJSON: "{}",
		APIEndpointsJSON: "[]", ConfigJSON: "{}", InitState: db.InitInitialized,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	snapPath := filepath.Join(dir, "snapshots", "c-rt", "sn-rt.snap")
	sw, err := snapstore.Create(app1.Keys, snapPath, "sn-rt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = sw.Write([]byte("raft-data"))
	sha, _ := sw.Close()
	if err := db.InsertSnapshot(ctx, app1.DB.Writer, &db.Snapshot{
		ID: "sn-rt", ClusterID: "c-rt", ClusterType: "vault", ProductVersion: "1.21.1",
		FilePath: snapPath, SizeBytes: 9, SHA256: sha, TriggerType: "manual", TriggeredBy: "root", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	app1.Close()

	// Replace master.key with k2 without rotating -> Open must refuse startup on snapshot header check.
	_ = os.WriteFile(filepath.Join(dir, "master.key"), []byte(fmtHexKey(k2)), 0o600)
	if badApp, err := Open(ctx, &cfg, log); err == nil {
		badApp.Close()
		t.Fatal("expected Open to fail when snapshot header references unloaded key")
	}

	// Restore k1 and add master.key.next = k2 -> Open succeeds and rotation runs.
	_ = os.WriteFile(filepath.Join(dir, "master.key"), []byte(fmtHexKey(k1)), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "master.key.next"), []byte(fmtHexKey(k2)), 0o600)
	app2, err := Open(ctx, &cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	defer app2.Close()

	e := &env{t: t, app: app2, srv: httptest.NewTLSServer(app2.API.Handler())}
	defer e.srv.Close()
	root := e.setup(t)

	// Hold SnapshotLock exclusively to keep rotation paused in Phase 2 while testing 409 guard.
	rel, err := app2.Ops.Locks.Acquire(ctx, []ops.LockReq{{Key: ops.SnapshotLock("c-rt"), Mode: ops.Exclusive}})
	if err != nil {
		t.Fatal(err)
	}
	code, b := root.do("POST", "/api/v1/settings/master-key/rotate", map[string]any{"current_password": adminPass}, nil)
	if code != 202 {
		rel()
		t.Fatalf("start rotate: %d %v", code, b)
	}
	// Wait briefly until Rotation.IsRunning() is true.
	for i := 0; i < 40 && !app2.Rotation.IsRunning(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/clusters/c-rt/snapshots/sn-rt/download", map[string]any{"current_password": adminPass, "passphrase": "archive-passphrase-1"}},
		{"POST", "/api/v1/clusters/c-rt/snapshots/sn-rt/restore", map[string]any{"current_password": adminPass}},
		{"DELETE", "/api/v1/clusters/c-rt/snapshots/sn-rt", nil},
	} {
		if gcode, _ := root.do(tc.method, tc.path, tc.body, nil); gcode != 409 {
			rel()
			t.Fatalf("snapshot %s %s during rotation got %d, want 409", tc.method, tc.path, gcode)
		}
	}
	rel()

	// Wait for rotation to complete.
	var state string
	for i := 0; i < 100 && state != "completed"; i++ {
		_, st := root.do("GET", "/api/v1/settings/master-key/rotation", nil, nil)
		if j, ok := st["journal"].(map[string]any); ok {
			state, _ = j["state"].(string)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if state != "completed" {
		t.Fatalf("rotation did not complete, state=%q", state)
	}
	_ = api.SessionCookie
}

func fmtHexKey(b []byte) string {
	const hx = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hx[v>>4]
		out[i*2+1] = hx[v&0x0f]
	}
	return string(out) + "\n"
}

func mustRaw(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
