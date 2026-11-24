package server

import "testing"

func TestVaultClusterAPI(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	var nodeIDs []string
	for _, n := range []string{"v1", "v2", "v3", "v4"} {
		code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": n, "host": "10.1.0." + n[1:], "ssh_user": "ops", "use_sudo": true}, nil)
		if code != 201 {
			t.Fatalf("create node: %d %v", code, b)
		}
		nodeIDs = append(nodeIDs, b["node"].(map[string]any)["id"].(string))
	}
	nodes := func(ids ...string) []map[string]any {
		var out []map[string]any
		for _, id := range ids {
			out = append(out, map[string]any{"node_id": id})
		}
		return out
	}
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "vault", "name": "prod-vault", "mode": "cluster",
		"nodes": nodes(nodeIDs[0], nodeIDs[1])}, nil); code != 400 {
		t.Fatalf("cluster mode needs 3 nodes: %d %v", code, b)
	}
	code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "vault", "name": "prod-vault", "mode": "cluster",
		"public_api_url": "https://vault.example.com:8200", "nodes": nodes(nodeIDs[0], nodeIDs[1], nodeIDs[2])}, nil)
	if code != 201 {
		t.Fatalf("create cluster: %d %v", code, b)
	}
	c := b["cluster"].(map[string]any)
	id := c["id"].(string)
	if c["tls_enabled"] != true || c["init_state"] != "uninitialized" || c["ca_expires_at"] == nil {
		t.Fatalf("cluster defaults: %v", c)
	}
	// A host belongs to at most one Vault cluster.
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "vault", "name": "other", "mode": "single",
		"nodes": nodes(nodeIDs[0])}, nil); code != 409 || errCode(b) != "node_in_cluster" {
		t.Fatalf("duplicate membership: %d %v", code, b)
	}
	_, got := root.do("GET", "/api/v1/clusters/"+id, nil, nil)
	if len(got["nodes"].([]any)) != 3 || got["custody"].(map[string]any)["key_shares"].(float64) != 5 {
		t.Fatalf("detail: %v", got)
	}
	m0 := got["nodes"].([]any)[0].(map[string]any)
	if m0["api_addr"] != "https://10.1.0.1:8200" || m0["cluster_addr"] != "https://10.1.0.1:8201" {
		t.Fatalf("member addresses: %v", m0)
	}
	// Unprobed hosts block deployment.
	_, pf := root.do("POST", "/api/v1/clusters/"+id+"/preflight", map[string]any{}, nil)
	if len(pf["issues"].([]any)) != 3 {
		t.Fatalf("preflight: %v", pf)
	}
	if code, b := root.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.18.0", "use_proxy": false}, nil); code != 409 ||
		errCode(b) != "preflight_failed" {
		t.Fatalf("deploy must be blocked: %d %v", code, b)
	}
	if code, _ := root.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.14.0"}, nil); code != 400 {
		t.Fatal("versions below the minimum must be rejected")
	}
	if code, _ := root.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.18.0+ent"}, nil); code != 400 {
		t.Fatal("enterprise versions must be rejected")
	}
	if code, b := root.do("POST", "/api/v1/vault/"+id+"/init", map[string]any{}, nil); code != 409 || errCode(b) != "not_deployed" {
		t.Fatalf("init before deploy: %d %v", code, b)
	}
	if code, _ := root.do("POST", "/api/v1/vault/"+id+"/rekey", map[string]any{"current_password": "wrong-password-x"}, nil); code != 403 {
		t.Fatal("rekey requires second verification")
	}
	if code, b := root.do("POST", "/api/v1/clusters/"+id+"/nodes", map[string]any{"nodes": nodes(nodeIDs[3])}, nil); code != 204 {
		t.Fatalf("add member before deploy: %d %v", code, b)
	}
	viewer := e.makeViewer(t, root)
	if code, _ := viewer.do("GET", "/api/v1/clusters/"+id, nil, nil); code != 200 {
		t.Fatal("viewer can read clusters")
	}
	if code, _ := viewer.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.18.0"}, nil); code != 403 {
		t.Fatal("viewer cannot deploy")
	}
	if code, _ := viewer.do("GET", "/api/v1/vault/"+id+"/kv/item?mount=secret&path=a", nil, nil); code != 403 {
		t.Fatal("viewer cannot read KV data")
	}
	if code, _ := root.do("DELETE", "/api/v1/clusters/"+id, nil, nil); code != 204 {
		t.Fatal("an undeployed cluster can be deleted")
	}
}

func TestNomadClusterAPI(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	var ids []string
	for i, n := range []string{"n1", "n2", "n3", "n4"} {
		code, b := root.do("POST", "/api/v1/nodes", map[string]any{"name": n, "host": "10.2.0." + string(rune('1'+i)), "ssh_user": "ops", "use_sudo": true}, nil)
		if code != 201 {
			t.Fatalf("create node: %d %v", code, b)
		}
		ids = append(ids, b["node"].(map[string]any)["id"].(string))
	}
	member := func(id, role string) map[string]any { return map[string]any{"node_id": id, "role": role} }
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "nomad", "name": "prod-nomad", "mode": "cluster",
		"nodes": []any{member(ids[0], "server"), member(ids[1], "server"), member(ids[2], "client")}}, nil); code != 400 {
		t.Fatalf("an even number of servers must be rejected: %d %v", code, b)
	}
	code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "nomad", "name": "prod-nomad", "mode": "cluster",
		"public_api_url": "https://nomad.example.com", "client_defaults": map[string]any{"raw_exec": true, "meta": map[string]any{"rack": "r1"}},
		"nodes": []any{member(ids[0], "server"), member(ids[1], "server"), member(ids[2], "server_client"), member(ids[3], "client")}}, nil)
	if code != 201 {
		t.Fatalf("create nomad cluster: %d %v", code, b)
	}
	c := b["cluster"].(map[string]any)
	id := c["id"].(string)
	settings := c["settings"].(map[string]any)
	if c["tls_enabled"] != true || c["type"] != "nomad" || settings["http_port"].(float64) != 4646 || settings["verify_https_client"] != false {
		t.Fatalf("nomad defaults: %v", c)
	}
	_, got := root.do("GET", "/api/v1/clusters/"+id, nil, nil)
	ms := got["nodes"].([]any)
	if len(ms) != 4 {
		t.Fatalf("members: %v", got)
	}
	for _, x := range ms {
		m := x.(map[string]any)
		cfg := m["config"].(map[string]any)
		if m["api_addr"] != "https://"+m["host"].(string)+":4646" {
			t.Fatalf("api addr: %v", m)
		}
		if (m["role"] == "server") == (cfg["raw_exec"] == true) {
			t.Fatalf("client defaults apply to clients only: %v", m)
		}
	}
	// A host can be in one Nomad and one Vault cluster, but not two Nomad clusters.
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "nomad", "name": "other", "mode": "single",
		"nodes": []any{member(ids[0], "")}}, nil); code != 409 || errCode(b) != "node_in_cluster" {
		t.Fatalf("duplicate nomad membership: %d %v", code, b)
	}
	if code, b := root.do("POST", "/api/v1/clusters", map[string]any{"type": "vault", "name": "v", "mode": "single",
		"nodes": []any{map[string]any{"node_id": ids[0]}}}, nil); code != 201 {
		t.Fatalf("vault on a nomad host: %d %v", code, b)
	}
	_, pf := root.do("POST", "/api/v1/clusters/"+id+"/preflight", map[string]any{}, nil)
	if len(pf["issues"].([]any)) != 4 {
		t.Fatalf("preflight: %v", pf)
	}
	if code, b := root.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.10.0", "use_proxy": false}, nil); code != 409 ||
		errCode(b) != "preflight_failed" {
		t.Fatalf("deploy must be blocked: %d %v", code, b)
	}
	if code, _ := root.do("POST", "/api/v1/clusters/"+id+"/deploy", map[string]any{"version": "1.8.0"}, nil); code != 400 {
		t.Fatal("versions below the minimum must be rejected")
	}
	if code, b := root.do("PUT", "/api/v1/clusters/"+id+"/credentials", map[string]any{"mode": "retry", "current_password": adminPass}, nil); code != 409 || errCode(b) != "not_in_doubt" {
		t.Fatalf("credentials retry outside init_in_doubt: %d %v", code, b)
	}
	if code, b := root.do("GET", "/api/v1/clusters/"+id+"/status", nil, nil); code != 200 || b["status"].(map[string]any)["health_status"] != "unreachable" {
		t.Fatalf("status: %d %v", code, b)
	}
	if code, _ := root.do("DELETE", "/api/v1/clusters/"+id, nil, nil); code != 204 {
		t.Fatal("an undeployed nomad cluster can be deleted")
	}
}
