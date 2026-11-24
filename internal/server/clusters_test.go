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
