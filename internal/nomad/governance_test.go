package nomad

import (
	"context"
	"testing"
	"time"

	"nomad-deck/internal/auth"
)

func errCode(err error) string {
	if e, ok := err.(*auth.Error); ok {
		return e.Code
	}
	return ""
}

// TestGovernance exercises namespace protection and ACL object management.
func TestGovernance(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	if err := e.s.bootstrap(ctx, e.load(), t.Logf); err != nil {
		t.Fatal(err)
	}
	id := e.cl.ID
	s := e.s

	// Namespaces.
	if err := s.PutNamespace(ctx, testActor, id, Namespace{Name: "team-a", Description: "A"}, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PutNamespace(ctx, testActor, id, Namespace{Name: "team-a"}, true); errCode(err) != "exists" {
		t.Fatalf("duplicate namespace: %v", err)
	}
	if err := s.PutNamespace(ctx, testActor, id, Namespace{Name: "team-a", Description: "B"}, false); err != nil {
		t.Fatal(err)
	}
	nss, err := s.ListNamespaces(ctx, id)
	if err != nil || len(nss) != 2 {
		t.Fatalf("namespaces: %+v %v", nss, err)
	}
	api, _, _ := s.apiClient(ctx, e.load(), "")
	job := map[string]any{"Job": map[string]any{"ID": "web", "Name": "web", "Namespace": "team-a", "Type": "service",
		"Datacenters": []string{"dc1"}, "TaskGroups": []any{map[string]any{"Name": "g", "Count": 1,
			"Tasks": []any{map[string]any{"Name": "t", "Driver": "raw_exec", "Config": map[string]any{"command": "/bin/true"}}}}}}}
	var registered struct{ EvalID string }
	if err := api.Request(ctx, "PUT", "jobs?namespace=team-a", job, &registered); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteNamespace(ctx, testActor, id, "team-a"); errCode(err) != "namespace_in_use" {
		t.Fatalf("namespace with a live job must not be deleted: %v", err)
	}
	if err := s.DeleteNamespace(ctx, testActor, id, "default"); errCode(err) != "builtin" {
		t.Fatalf("default namespace: %v", err)
	}
	// Wait for scheduling before purging; Nomad 1.11 can panic if a pending plan loses its job.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var evaluation struct{ Status string }
		if err := api.Request(ctx, "GET", "evaluation/"+registered.EvalID+"?namespace=team-a", nil, &evaluation); err != nil {
			t.Fatal(err)
		}
		if evaluation.Status == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job evaluation did not complete: %s", evaluation.Status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if err := api.Request(ctx, "DELETE", "job/web?namespace=team-a&purge=true", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteNamespace(ctx, testActor, id, "team-a"); err != nil {
		t.Fatal(err)
	}

	// Node pools.
	if err := s.PutNodePool(ctx, testActor, id, NodePool{Name: "gpu", Description: "GPU nodes", Meta: map[string]string{"tier": "1"}}, true); err != nil {
		t.Fatal(err)
	}
	pools, err := s.ListNodePools(ctx, id)
	if err != nil || len(pools) != 3 {
		t.Fatalf("pools: %+v %v", pools, err)
	}
	if err := s.DeleteNodePool(ctx, testActor, id, "default"); errCode(err) != "builtin" {
		t.Fatalf("builtin pool: %v", err)
	}
	if err := s.DeleteNodePool(ctx, testActor, id, "gpu"); err != nil {
		t.Fatal(err)
	}

	// Policies, roles and tokens.
	if err := s.PutPolicy(ctx, testActor, id, ACLPolicy{Name: "bad", Rules: "namespace \"x\" {"}); errCode(err) != "invalid_argument" {
		t.Fatalf("invalid HCL: %v", err)
	}
	if err := s.PutPolicy(ctx, testActor, id, ACLPolicy{Name: "bad", Rules: `namespace "x" { policy = "bogus" }`}); errCode(err) != "nomad_rejected" {
		t.Fatalf("semantically invalid policy: %v", err)
	}
	if err := s.PutPolicy(ctx, testActor, id, ACLPolicy{Name: "readonly", Description: "ro", Rules: PolicyTemplates[0].Rules}); err != nil {
		t.Fatal(err)
	}
	p, err := s.GetPolicy(ctx, id, "readonly")
	if err != nil || p.Rules == "" {
		t.Fatalf("get policy: %+v %v", p, err)
	}
	role, err := s.PutRole(ctx, testActor, id, ACLRole{Name: "ops", Policies: []string{"readonly"}})
	if err != nil || role.ID == "" {
		t.Fatalf("role: %+v %v", role, err)
	}
	role.Description = "operators"
	if _, err := s.PutRole(ctx, testActor, id, *role); err != nil {
		t.Fatal(err)
	}
	tok, err := s.CreateToken(ctx, testActor, id, TokenInput{Name: "ci", Roles: []string{"ops"}, TTL: "24h"})
	if err != nil || tok.SecretID == "" || tok.ExpirationTime == nil {
		t.Fatalf("token: %+v %v", tok, err)
	}
	toks, err := s.ListTokens(ctx, id)
	if err != nil || len(toks) != 1 || toks[0].AccessorID != tok.AccessorID {
		t.Fatalf("tokens must list the client token only: %+v %v", toks, err)
	}
	// The issued token's secret can be revealed repeatedly.
	for i := 0; i < 2; i++ {
		rev, err := s.RevealToken(ctx, testActor, id, tok.AccessorID)
		if err != nil || rev.SecretID != tok.SecretID || rev.AccessorID != tok.AccessorID || rev.Name != "ci" {
			t.Fatalf("reveal token attempt %d: %+v %v", i+1, rev, err)
		}
	}
	if _, err := s.RevealToken(ctx, testActor, id, "00000000-0000-0000-0000-000000000000"); errCode(err) != "not_found" {
		t.Fatalf("reveal missing token: %v", err)
	}
	// The issued token can read but not write.
	ro := e.ls.client(tok.SecretID)
	if _, err := ro.Nodes(ctx); err != nil {
		t.Fatalf("read with client token: %v", err)
	}
	if err := ro.Request(ctx, "POST", "namespace/x", map[string]any{"Name": "x"}, nil); StatusOf(err) != 403 {
		t.Fatalf("write with read-only token: %v", err)
	}
	self, _ := api.TokenSelf(ctx)
	if _, err := s.RevealToken(ctx, testActor, id, self.AccessorID); errCode(err) != "protected_token" {
		t.Fatalf("own token must be protected on reveal: %v", err)
	}
	if err := s.RevokeToken(ctx, testActor, id, self.AccessorID); errCode(err) != "protected_token" {
		t.Fatalf("own token must be protected: %v", err)
	}
	if err := s.RevokeToken(ctx, testActor, id, tok.AccessorID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRole(ctx, testActor, id, role.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeletePolicy(ctx, testActor, id, "readonly"); err != nil {
		t.Fatal(err)
	}
}
