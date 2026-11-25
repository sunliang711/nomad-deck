package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"nomad-deck/internal/cron"
	"nomad-deck/internal/db"
)

func (c *client) raw(method, path string, body any) (int, []byte) {
	c.e.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, c.e.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", c.csrf)
	resp, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func (c *client) upload(path string, fields map[string]string, file []byte) (int, map[string]any) {
	c.e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, k := range []string{"passphrase", "strategy"} {
		if v, ok := fields[k]; ok {
			_ = mw.WriteField(k, v)
		}
	}
	fw, _ := mw.CreateFormFile("file", "bundle.ndbundle")
	_, _ = fw.Write(file)
	_ = mw.Close()
	req, _ := http.NewRequest("POST", c.e.srv.URL+path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", c.csrf)
	resp, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

const bundlePass = "bundle-passphrase-1"

// seedSource creates hosts, a cluster, a proxy password, a custom cron job
// and a job template, and returns the cluster id.
func seedSource(t *testing.T, e *env, root *client, clusterName string) string {
	t.Helper()
	code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": "n-" + clusterName, "host": "10.9.0." + map[string]string{"src": "1", "other": "2"}[clusterName],
		"ssh_user": "ops", "use_sudo": true}, nil)
	if code != 201 {
		t.Fatalf("node: %d %v", code, b)
	}
	nid := b["node"].(map[string]any)["id"].(string)
	code, b = root.do("POST", "/api/v1/clusters", map[string]any{"type": "nomad", "name": clusterName, "mode": "single",
		"nodes": []any{map[string]any{"node_id": nid}}}, nil)
	if code != 201 {
		t.Fatalf("cluster: %d %v", code, b)
	}
	cid := b["cluster"].(map[string]any)["id"].(string)
	if code, b := root.do("POST", "/api/v1/job-templates", map[string]any{"name": "web", "edit_mode": "hcl", "hcl": "job \"web\" {}"}, nil); code != 200 {
		t.Fatalf("template: %d %v", code, b)
	}
	if code, b := root.do("POST", "/api/v1/cron-jobs", map[string]any{"name": "snap", "cron_expr": "0 5 * * *",
		"payload": map[string]any{"type": "cluster_snapshot", "cluster_id": cid}}, nil); code != 201 {
		t.Fatalf("cron: %d %v", code, b)
	}
	return cid
}

func TestMigrationReplace(t *testing.T) {
	ctx := context.Background()
	src := newEnv(t)
	sroot := src.setup(t)
	if code, b := sroot.do("PUT", "/api/v1/settings/proxy", map[string]any{"enabled": true, "type": "http", "host": "10.0.0.1",
		"port": 3128, "username": "u", "password": "proxy-secret"}, nil); code != 200 {
		t.Fatalf("proxy: %d %v", code, b)
	}
	cid := seedSource(t, src, sroot, "src")
	// A finished task with a step log travels with the history.
	logDir := src.app.Ops.LogDir("T1")
	_ = os.MkdirAll(logDir, 0o700)
	_ = os.WriteFile(filepath.Join(logDir, "1.log"), []byte("step output\n"), 0o600)
	now := db.FormatTime(src.app.DB.Now())
	if _, err := src.app.DB.Writer.Exec(`INSERT INTO operation_tasks (id, action, target_type, target_id, lock_mode, remote_op_id, status, created_at)
		VALUES ('T1', 'cluster.snapshot', 'cluster', ?, 'shared', 'T1', 'success', ?)`, cid, now); err != nil {
		t.Fatal(err)
	}
	if _, err := src.app.DB.Writer.Exec(`INSERT INTO operation_task_steps (id, task_id, step_order, name, status, log_path)
		VALUES ('S1', 'T1', 1, 'x', 'success', ?)`, filepath.Join(logDir, "1.log")); err != nil {
		t.Fatal(err)
	}

	if code, _ := sroot.raw("POST", "/api/v1/migration/export", map[string]any{"current_password": "wrong", "passphrase": bundlePass}); code != 401 && code != 403 {
		t.Fatalf("export requires the current password: %d", code)
	}
	if code, _ := sroot.raw("POST", "/api/v1/migration/export", map[string]any{"current_password": adminPass, "passphrase": "short"}); code != 400 {
		t.Fatalf("short passphrase: %d", code)
	}
	code, bundle := sroot.raw("POST", "/api/v1/migration/export", map[string]any{"current_password": adminPass, "passphrase": bundlePass,
		"include": []string{"admins", "operation_tasks", "audit_logs"}})
	if code != 200 || len(bundle) < 100 {
		t.Fatalf("export: %d %s", code, bundle)
	}
	if bytes.Contains(bundle, []byte("proxy-secret")) || bytes.Contains(bundle, []byte("BEGIN OPENSSH")) {
		t.Fatal("bundle must be encrypted")
	}

	// Target instance with its own master key and account.
	dst := newEnv(t)
	droot := dst.setup(t)
	if err := dst.app.Cron.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(dst.app.Cron.Stop)
	viewer := dst.makeViewer(t, droot)
	if code, _ := viewer.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": bundlePass, "strategy": "replace"}, bundle); code != 403 {
		t.Fatal("viewer cannot import")
	}
	if code, b := droot.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": "wrong-passphrase", "strategy": "replace"}, bundle); code != 400 {
		t.Fatalf("wrong passphrase: %d %v", code, b)
	}
	code, b := droot.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": bundlePass, "strategy": "replace"}, bundle)
	if code != 200 {
		t.Fatalf("preview: %d %v", code, b)
	}
	rep := b["report"].(map[string]any)
	accounts := rep["login_accounts"].([]any)
	if len(accounts) != 1 || accounts[0].(map[string]any)["username"] != "root" {
		t.Fatalf("login accounts come from the bundle: %v", accounts)
	}
	token := rep["preview_token"].(string)
	// A change after the preview makes it stale.
	if code, b := droot.do("POST", "/api/v1/nodes", map[string]any{"name": "late", "host": "10.9.9.9", "ssh_user": "ops", "use_sudo": true}, nil); code != 201 {
		t.Fatalf("late node: %d %v", code, b)
	}
	if code, b := droot.do("POST", "/api/v1/migration/import/apply", map[string]any{"preview_token": token, "current_password": adminPass}, nil); code != 409 || errCode(b) != "preview_stale" {
		t.Fatalf("stale preview: %d %v", code, b)
	}
	if code, b := droot.do("POST", "/api/v1/migration/import/apply", map[string]any{"preview_token": token, "current_password": adminPass}, nil); code != 409 || errCode(b) != "preview_invalid" {
		t.Fatalf("a preview token is single use: %d %v", code, b)
	}
	_, b = droot.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": bundlePass, "strategy": "replace"}, bundle)
	token = b["report"].(map[string]any)["preview_token"].(string)
	code, b = droot.do("POST", "/api/v1/migration/import/apply", map[string]any{"preview_token": token, "current_password": adminPass}, nil)
	if code != 200 {
		t.Fatalf("apply: %d %v", code, b)
	}
	// Every session ended; the source account signs in.
	if code, _ := droot.do("GET", "/api/v1/auth/sessions", nil, nil); code != 401 {
		t.Fatalf("sessions must be invalidated: %d", code)
	}
	if code, _ := viewer.do("GET", "/api/v1/nodes", nil, nil); code != 401 {
		t.Fatal("viewer session must be invalidated")
	}
	nroot := dst.client()
	if nroot.login("root", adminPass) != 200 {
		t.Fatal("source admin must sign in on the target")
	}
	// Secrets were re-encrypted with the target's master key.
	_, pw, err := dst.app.API.Proxy.Load(ctx)
	if err != nil || pw != "proxy-secret" {
		t.Fatalf("proxy password: %q %v", pw, err)
	}
	keys, _ := db.ListSSHKeys(ctx, dst.app.DB.Reader)
	for _, k := range keys {
		if _, err := dst.app.Keys.Decrypt(k.PrivateKeyEncrypted, db.SSHKeyAAD(k.ID)); err != nil {
			t.Fatalf("ssh key %s: %v", k.Name, err)
		}
	}
	c, err := db.GetCluster(ctx, dst.app.DB.Reader, cid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dst.app.Keys.Decrypt(c.CAKeyEncrypted, db.ClusterCAKeyAAD(cid)); err != nil {
		t.Fatalf("cluster CA key: %v", err)
	}
	if _, err := db.GetNode(ctx, dst.app.DB.Reader, "late"); err == nil {
		t.Fatal("replace removes rows that are not in the bundle")
	}
	// Step logs were restored under this data directory and stored as a DataDir-relative path.
	var lp string
	_ = dst.app.DB.Reader.QueryRow(`SELECT log_path FROM operation_task_steps WHERE id = 'S1'`).Scan(&lp)
	fullLogPath := filepath.Join(dst.app.Config.DataDir, lp)
	if got, err := os.ReadFile(fullLogPath); err != nil || string(got) != "step output\n" || lp != filepath.Join("ops", "T1", "1.log") {
		t.Fatalf("step log: %s (%s) %q %v", lp, fullLogPath, got, err)
	}
	// The control plane waits for activation; scheduled jobs pause.
	if cron.Activated(ctx, dst.app.DB) {
		t.Fatal("imported control plane must await activation")
	}
	var audits int
	_ = dst.app.DB.Reader.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'migration.import' AND result = 'success'`).Scan(&audits)
	if audits != 1 {
		t.Fatalf("import is audited: %d", audits)
	}
	if code, b := nroot.do("POST", "/api/v1/migration/activate", map[string]any{"current_password": adminPass}, nil); code != 200 {
		t.Fatalf("activate: %d %v", code, b)
	}
	if !cron.Activated(ctx, dst.app.DB) {
		t.Fatal("activation flag")
	}
}

func TestMigrationMerge(t *testing.T) {
	ctx := context.Background()
	src := newEnv(t)
	sroot := src.setup(t)
	cid := seedSource(t, src, sroot, "src")
	_, bundle := sroot.raw("POST", "/api/v1/migration/export", map[string]any{"current_password": adminPass, "passphrase": bundlePass})

	dst := newEnv(t)
	droot := dst.setup(t)
	seedSource(t, dst, droot, "other") // its own template named "web"
	code, b := droot.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": bundlePass, "strategy": "merge"}, bundle)
	if code != 200 {
		t.Fatalf("preview: %d %v", code, b)
	}
	rep := b["report"].(map[string]any)
	if rn, _ := rep["renamed"].([]any); len(rn) == 0 {
		t.Fatalf("clashing names are reported: %v", rep)
	}
	code, b = droot.do("POST", "/api/v1/migration/import/apply", map[string]any{"preview_token": rep["preview_token"], "current_password": adminPass}, nil)
	if code != 200 {
		t.Fatalf("apply: %d %v", code, b)
	}
	if code, _ := droot.do("GET", "/api/v1/auth/sessions", nil, nil); code != 401 {
		t.Fatal("merge also ends every session")
	}
	clusters, _ := db.ListClusters(ctx, dst.app.DB.Reader, "")
	if len(clusters) != 2 {
		t.Fatalf("both clusters exist: %d", len(clusters))
	}
	var imported *db.Cluster
	for _, c := range clusters {
		if c.Name == "src" {
			imported = c
		} else if c.MaintenanceMode {
			t.Fatal("existing clusters are untouched")
		}
	}
	if imported == nil || imported.ID == cid || !imported.MaintenanceMode || imported.MaintenanceReason != "awaiting_activation" {
		t.Fatalf("imported cluster gets a new id and waits for activation: %+v", imported)
	}
	if _, err := dst.app.Keys.Decrypt(imported.CAKeyEncrypted, db.ClusterCAKeyAAD(imported.ID)); err != nil {
		t.Fatalf("secrets are re-bound to the new id: %v", err)
	}
	members, _ := db.ListClusterNodes(ctx, dst.app.DB.Reader, imported.ID)
	if len(members) != 1 {
		t.Fatalf("members follow their cluster: %d", len(members))
	}
	var payload string
	_ = dst.app.DB.Reader.QueryRow(`SELECT payload_json FROM cron_jobs WHERE name = 'snap' AND payload_json LIKE ?`, "%"+imported.ID+"%").Scan(&payload)
	if payload == "" {
		t.Fatal("cron payload references are rewritten")
	}
	var templates int
	_ = dst.app.DB.Reader.QueryRow(`SELECT COUNT(*) FROM job_templates WHERE name LIKE 'web%'`).Scan(&templates)
	if templates != 2 {
		t.Fatalf("templates: %d", templates)
	}
	if !cron.Activated(ctx, dst.app.DB) {
		t.Fatal("merge does not pause the whole control plane")
	}
	nroot := dst.client()
	if nroot.login("root", adminPass) != 200 {
		t.Fatal("target account kept")
	}
	if code, b := nroot.do("POST", "/api/v1/migration/activate", map[string]any{"current_password": adminPass}, nil); code != 200 || b["released_clusters"].(float64) != 1 {
		t.Fatalf("activate: %d %v", code, b)
	}
	// A second merge of the same bundle clashes on the cluster name.
	code, b = nroot.upload("/api/v1/migration/import/preview", map[string]string{"passphrase": bundlePass, "strategy": "merge"}, bundle)
	if code != 409 || errCode(b) != "merge_conflict" {
		t.Fatalf("cluster name clash: %d %v", code, b)
	}
}

func TestBarrierBlocksChanges(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	e.app.Ops.SetBarrier("迁移导入")
	if code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": "x", "host": "10.1.1.1", "ssh_user": "root"}, nil); code != 503 || errCode(b) != "maintenance" {
		t.Fatalf("changes are refused under the barrier: %d %v", code, b)
	}
	if code, _ := root.do("GET", "/api/v1/nodes", nil, nil); code != 200 {
		t.Fatal("reads still work")
	}
	e.app.Ops.SetBarrier("")
	if code, _ := root.do("POST", "/api/v1/nodes", map[string]any{"name": "x", "host": "10.1.1.1", "ssh_user": "root"}, nil); code != 201 {
		t.Fatal("changes resume after the barrier")
	}
}
