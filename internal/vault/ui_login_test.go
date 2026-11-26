package vault

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"nomad-deck/internal/db"
)

func TestCreateWrappedUIToken(t *testing.T) {
	var gotWrapTTL string
	var gotToken string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/token/create-orphan" || r.Method != http.MethodPost {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		gotWrapTTL = r.Header.Get("X-Vault-Wrap-TTL")
		gotToken = r.Header.Get("X-Vault-Token")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"wrap_info":{"token":"wrap.abc.123"}}`))
	}))
	defer srv.Close()

	c := &Client{Addr: srv.URL, Token: "hvs.root-test", HTTP: srv.Client()}
	tok, err := c.CreateWrappedUIToken(context.Background(), "1h", "120s", "nomad-deck-ui-admin")
	if err != nil {
		t.Fatalf("CreateWrappedUIToken: %v", err)
	}
	if tok != "wrap.abc.123" {
		t.Fatalf("unexpected wrapped token: %q", tok)
	}
	if gotWrapTTL != "120s" || gotToken != "hvs.root-test" {
		t.Fatalf("headers mismatch: wrap=%q tok=%q", gotWrapTTL, gotToken)
	}
	if gotBody["ttl"] != "1h" {
		t.Fatalf("unexpected body ttl: %v", gotBody)
	}
}

func TestResolveVaultUIBaseURL(t *testing.T) {
	cl := &cluster{Cluster: &db.Cluster{PublicAPIURL: "https://vault.example.com:8200/"}}
	am := &db.ClusterNode{APIAddr: "https://10.0.0.1:8200"}
	members := []*db.ClusterNode{
		am,
		{APIAddr: "https://10.0.0.2:8200", AdvertiseAddr: "10.0.0.2"},
	}

	if got, err := resolveVaultUIBaseURL(cl, members, am, ""); err != nil || got != "https://vault.example.com:8200" {
		t.Fatalf("default public url failed: got=%q err=%v", got, err)
	}
	if got, err := resolveVaultUIBaseURL(cl, members, am, "https://10.0.0.2:8200/"); err != nil || got != "https://10.0.0.2:8200" {
		t.Fatalf("member url failed: got=%q err=%v", got, err)
	}
	if _, err := resolveVaultUIBaseURL(cl, members, am, "https://evil.example.com"); err == nil {
		t.Fatal("expected foreign target_url to be rejected")
	}
}
