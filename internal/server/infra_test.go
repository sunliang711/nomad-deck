package server

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/ops"
)

func TestSSHKeysAndNodesAPI(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	_, keys := root.do("GET", "/api/v1/ssh-keys", nil, nil)
	list := keys["ssh_keys"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["is_default"] != true {
		t.Fatalf("default key from setup: %v", keys)
	}
	defID := list[0].(map[string]any)["id"].(string)
	if !strings.Contains(list[0].(map[string]any)["setup_command"].(string), "authorized_keys") {
		t.Fatal("setup command missing")
	}
	code, gen := root.do("POST", "/api/v1/ssh-keys/generate", map[string]any{"name": "second"}, nil)
	if code != 201 {
		t.Fatalf("generate: %d %v", code, gen)
	}
	secondID := gen["ssh_key"].(map[string]any)["id"].(string)
	if code, _ := root.do("POST", "/api/v1/ssh-keys", map[string]any{"name": "bad", "private_key": "nope"}, nil); code != 400 {
		t.Fatalf("import garbage: %d", code)
	}

	code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": "n1", "host": "10.0.0.11", "ssh_user": "ops", "use_sudo": true}, nil)
	if code != 201 {
		t.Fatalf("create node: %d %v", code, b)
	}
	node := b["node"].(map[string]any)
	if node["ssh_key_id"] != defID || node["status"] != "unknown" {
		t.Fatalf("node defaults: %v", node)
	}
	if code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": "n2", "host": "10.0.0.12", "ssh_user": "ops"}, nil); code != 400 {
		t.Fatalf("non-root without sudo must be rejected: %d %v", code, b)
	}
	if code, _ := root.do("POST", "/api/v1/nodes", map[string]any{"name": "n1", "host": "10.0.0.13", "ssh_user": "root"}, nil); code != 409 {
		t.Fatalf("duplicate name: %d", code)
	}
	if code, b := root.do("DELETE", "/api/v1/ssh-keys/"+defID, nil, nil); code != 409 {
		t.Fatalf("deleting a key in use must fail: %d %v", code, b)
	}
	if code, _ := root.do("PUT", "/api/v1/ssh-keys/"+secondID+"/default", nil, nil); code != 204 {
		t.Fatal("set default")
	}
	nodeID := node["id"].(string)
	if code, _ := root.do("PUT", "/api/v1/nodes/"+nodeID+"/aliases", map[string]any{"aliases": []string{"n1.internal", "10.0.1.11"}}, nil); code != 204 {
		t.Fatal("aliases")
	}
	_, got := root.do("GET", "/api/v1/nodes/"+nodeID, nil, nil)
	if len(got["node"].(map[string]any)["address_aliases"].([]any)) != 2 {
		t.Fatalf("aliases not stored: %v", got)
	}
	if _, ok := got["warnings"].([]any); !ok {
		t.Fatalf("expected warnings slice on getNode, got: %v", got["warnings"])
	}
	if code, _ := root.do("POST", "/api/v1/nodes/"+nodeID+"/reset-fingerprint", map[string]any{"current_password": "nope-nope-nope"}, nil); code != 403 {
		t.Fatalf("reset fingerprint requires second verification: %d", code)
	}

	viewer := e.makeViewer(t, root)
	if code, _ := viewer.do("GET", "/api/v1/nodes", nil, nil); code != 200 {
		t.Fatal("viewer can list nodes")
	}
	if code, _ := viewer.do("POST", "/api/v1/nodes/"+nodeID+"/test", nil, nil); code != 403 {
		t.Fatal("viewer cannot test nodes")
	}
	if code, _ := viewer.do("POST", "/api/v1/nodes/"+nodeID+"/reset-machine-id", nil, nil); code != 403 {
		t.Fatal("viewer cannot reset node machine-id")
	}
	if code, _ := root.do("POST", "/api/v1/nodes/nonexistent/reset-machine-id", nil, nil); code != 404 {
		t.Fatalf("reset missing node machine-id: %d", code)
	}
	if code, _ := viewer.do("POST", "/api/v1/ssh-keys/generate", map[string]any{"name": "x"}, nil); code != 403 {
		t.Fatal("viewer cannot generate keys")
	}
}

func (e *env) makeViewer(t *testing.T, root *client) *client {
	t.Helper()
	if code, b := root.do("POST", "/api/v1/admins", map[string]any{"current_password": adminPass, "username": "vic",
		"password": "viewer-password-1", "role": "viewer"}, nil); code != 201 {
		t.Fatalf("create viewer: %d %v", code, b)
	}
	v := e.client()
	if v.login("vic", "viewer-password-1") != 200 {
		t.Fatal("viewer login")
	}
	return v
}

func TestSettingsAndProxyAPI(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{"ssh.timeout_sec": 1000}, nil); code != 400 {
		t.Fatalf("out of range: %d %v", code, b)
	}
	if code, _ := root.do("PUT", "/api/v1/settings", map[string]any{"unknown.key": 1}, nil); code != 400 {
		t.Fatal("unknown key accepted")
	}
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{"proxy.use_for_releases": true}, nil); code != 400 || errCode(b) != "proxy_not_configured" {
		t.Fatalf("enabling proxy.use_for_releases without proxy must fail: %d %v", code, b)
	}
	for _, k := range []string{"proxy.use_for_nomad", "proxy.use_for_vault", "proxy.use_for_docker_install", "proxy.use_for_docker_pull", "proxy.use_for_self_update"} {
		if code, b := root.do("PUT", "/api/v1/settings", map[string]any{k: true}, nil); code != 400 || errCode(b) != "proxy_not_configured" {
			t.Fatalf("enabling %s without proxy must fail: %d %v", k, code, b)
		}
	}
	code, b := root.do("PUT", "/api/v1/settings", map[string]any{"ssh.max_concurrency": 4,
		"release.cni_checksums": map[string]any{"v1.99.0": map[string]any{"amd64": strings.Repeat("ab", 32)}}}, nil)
	if code != 200 || b["restart_required"] != true {
		t.Fatalf("put settings: %d %v", code, b)
	}
	_, rel := root.do("GET", "/api/v1/releases/cni", nil, nil)
	if rel["versions"].([]any)[0] != "v1.99.0" {
		t.Fatalf("registered CNI version must be listed first: %v", rel)
	}
	// Proxy explicitly requested without proxy configured.
	if code, b := root.do("GET", "/api/v1/releases/nomad?use_proxy=true", nil, nil); code != 400 || errCode(b) != "proxy_not_configured" {
		t.Fatalf("expected proxy_not_configured: %d %v", code, b)
	}

	code, b = root.do("PUT", "/api/v1/settings/proxy", map[string]any{"enabled": true, "type": "socks5", "host": "10.0.0.1",
		"port": 1080, "username": "u", "password": "proxy-secret", "no_proxy": []string{"10.0.0.0/8"}}, nil)
	if code != 200 {
		t.Fatalf("put proxy: %d %v", code, b)
	}
	p := b["proxy"].(map[string]any)
	if p["configured"] != true || p["password_set"] != true || p["type"] != "socks5" {
		t.Fatalf("proxy view: %v", p)
	}
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{"proxy.use_for_docker_pull": true}, nil); code != 400 {
		t.Fatalf("enabling proxy.use_for_docker_pull with socks5 must fail: %d %v", code, b)
	}
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{
		"proxy.use_for_releases":       true,
		"proxy.use_for_nomad":          true,
		"proxy.use_for_vault":          true,
		"proxy.use_for_docker_install": true,
		"proxy.use_for_self_update":    true,
	}, nil); code != 200 {
		t.Fatalf("enable proxy defaults when configured: %d %v", code, b)
	} else if st := b["settings"].(map[string]any); st["proxy.use_for_nomad"] != true || st["proxy.use_for_vault"] != true || st["proxy.use_for_docker_install"] != true || st["proxy.use_for_self_update"] != true {
		t.Fatalf("proxy defaults not saved: %v", st)
	}
	var raw string
	e.app.DB.Reader.QueryRow(`SELECT value FROM system_settings WHERE key = 'proxy.password'`).Scan(&raw)
	if strings.Contains(raw, "proxy-secret") || !strings.HasPrefix(raw, "nd1:") {
		t.Fatalf("proxy password must be encrypted: %s", raw)
	}
	// Omitting the password keeps it; HTTP proxy allows proxy.use_for_docker_pull.
	root.do("PUT", "/api/v1/settings/proxy", map[string]any{"enabled": true, "type": "http", "host": "10.0.0.1", "port": 3128, "username": "u"}, nil)
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{"proxy.use_for_docker_pull": true}, nil); code != 200 {
		t.Fatalf("enable proxy.use_for_docker_pull under http must succeed: %d %v", code, b)
	}
	if code, b := root.do("POST", "/api/v1/settings/proxy/sync-docker", map[string]any{}, nil); code != 200 {
		t.Fatalf("sync-docker: %d %v", code, b)
	}
	_, b = root.do("GET", "/api/v1/settings/proxy", nil, nil)
	if b["proxy"].(map[string]any)["password_set"] != true {
		t.Fatal("password must be kept when omitted")
	}
	if code, _ := root.do("PUT", "/api/v1/settings/proxy", map[string]any{"enabled": true, "type": "ftp", "host": "h", "port": 1}, nil); code != 400 {
		t.Fatal("invalid proxy type accepted")
	}
	root.do("PUT", "/api/v1/settings/proxy", map[string]any{"enabled": false}, nil)
	_, b = root.do("GET", "/api/v1/settings/proxy", nil, nil)
	if b["proxy"].(map[string]any)["configured"] != false {
		t.Fatal("proxy must be removable")
	}
	_, stRes := root.do("GET", "/api/v1/settings", nil, nil)
	st := stRes["settings"].(map[string]any)
	for _, k := range []string{"proxy.use_for_releases", "proxy.use_for_nomad", "proxy.use_for_vault", "proxy.use_for_docker_install", "proxy.use_for_docker_pull", "proxy.use_for_self_update"} {
		if st[k] != false {
			t.Fatalf("disabling proxy must clear %s: %v", k, st)
		}
	}
	logs, _ := root.do("GET", "/api/v1/audit-logs?action=settings.proxy_update", nil, nil)
	_ = logs

	// Docker repository signing key rotation and version listing input checks.
	if code, _ := root.do("PUT", "/api/v1/settings", map[string]any{"release.docker_pgp_public_key": "not a key"}, nil); code != 400 {
		t.Fatal("unparseable Docker signing key accepted")
	}
	root.do("PUT", "/api/v1/settings", map[string]any{"proxy.use_for_releases": false}, nil)
	if code, b := root.do("GET", "/api/v1/releases/docker?distro=ubuntu&release=noble&arch=s390x", nil, nil); code != 400 || errCode(b) != "invalid_argument" {
		t.Fatalf("unsupported arch: %d %v", code, b)
	}
	if code, b := root.do("GET", "/api/v1/releases/docker?node_id=missing", nil, nil); code != 404 {
		t.Fatalf("unknown node: %d %v", code, b)
	}
	code, b = root.do("POST", "/api/v1/nodes", map[string]any{"name": "dk", "host": "10.0.0.21", "ssh_user": "ops", "use_sudo": true}, nil)
	if code != 201 {
		t.Fatalf("create node: %d %v", code, b)
	}
	nodeID, _ := b["node"].(map[string]any)["id"].(string)
	if code, b := root.do("GET", "/api/v1/releases/docker?node_id="+nodeID, nil, nil); code != 409 || errCode(b) != "node_not_probed" {
		t.Fatalf("unprobed node: %d %v", code, b)
	}
}

func TestOperationsAPIAndStream(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	release := make(chan struct{})
	task, err := e.app.Ops.Submit(context.Background(), ops.Spec{Action: "test.demo", TargetType: "node", TargetID: "n1",
		Locks: []ops.LockReq{{Key: ops.HostLock("n1", "nomad"), Mode: ops.Exclusive}},
		Run: func(ctx context.Context, tk *ops.Task) error {
			s, _ := tk.Step("first", "n1")
			s.Logf("before wait")
			<-release
			s.Logf("after wait password=hunter2hunter2")
			s.Finish(nil, nil)
			return nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)

	req, _ := http.NewRequest("GET", e.srv.URL+"/api/v1/operations/"+task.ID+"/stream", nil)
	resp, err := root.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %s", resp.Header.Get("Content-Type"))
	}
	lines := make(chan string, 100)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	waitFor := func(substr string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("stream ended before %q", substr)
				}
				if strings.Contains(l, substr) {
					return
				}
			case <-deadline:
				t.Fatalf("timeout waiting for %q", substr)
			}
		}
	}
	waitFor("before wait") // replayed from the log file
	close(release)
	waitFor("after wait") // live
	waitFor(`"type":"done"`)
	e.app.Ops.Wait()

	_, b := root.do("GET", "/api/v1/operations/"+task.ID, nil, nil)
	if b["operation"].(map[string]any)["status"] != "success" || len(b["steps"].([]any)) != 1 {
		t.Fatalf("operation: %v", b)
	}
	_, list := root.do("GET", "/api/v1/operations?action=test.demo", nil, nil)
	if len(list["operations"].([]any)) != 1 {
		t.Fatalf("list: %v", list)
	}
}
