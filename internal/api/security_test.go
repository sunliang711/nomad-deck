package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"testing"

	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
)

func TestClientIPMultipleXFFHeaders(t *testing.T) {
	a := &API{
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		TrustedProxies: []netip.Prefix{
			netip.MustParsePrefix("10.0.0.0/8"),
			netip.MustParsePrefix("172.16.0.0/12"),
		},
	}
	var gotIP string
	h := a.clientIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIP = clientIPFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/status", nil)
	req.RemoteAddr = "10.0.0.1:44321"
	req.Header.Add("X-Forwarded-For", "198.51.100.2")
	req.Header.Add("X-Forwarded-For", "172.16.0.5")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if gotIP != "198.51.100.2" {
		t.Fatalf("clientIP = %q, want %q", gotIP, "198.51.100.2")
	}
}

func TestClusterOfStripsDockerProxyPassword(t *testing.T) {
	c := &db.Cluster{
		ID:         "c1",
		Name:       "nomad-prod",
		Type:       "nomad",
		TLSEnabled: true,
		CACertPEM:  "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
		ConfigJSON: `{"docker_defaults":{"pull_proxy":{"mode":"custom","url":"http://proxy.internal:3128","username":"u","password_encrypted":"k1:secret-cipher"}}}`,
	}
	view := clusterOf(c)
	if view.CACertPEM != c.CACertPEM {
		t.Fatalf("expected ca_cert_pem to be exposed, got %q", view.CACertPEM)
	}
	var settings map[string]any
	if err := json.Unmarshal(view.Settings, &settings); err != nil {
		t.Fatal(err)
	}
	dd := settings["docker_defaults"].(map[string]any)
	pp := dd["pull_proxy"].(map[string]any)
	if _, exists := pp["password_encrypted"]; exists {
		t.Fatalf("password_encrypted leaked in clusterView: %+v", pp)
	}
	if pp["password_set"] != true {
		t.Fatalf("expected password_set=true, got %+v", pp)
	}
}

func TestBarrierGuardAllowsAuthLoginLogout(t *testing.T) {
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := ops.NewEngine(d, log, dir)
	release, ok := eng.TryAcquireBarrier("self_update")
	if !ok {
		t.Fatal("TryAcquireBarrier returned false")
	}
	defer release()

	a := &API{Ops: eng, Log: log}
	h := a.barrierGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for _, tc := range []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/api/v1/clusters", http.StatusServiceUnavailable},
		{http.MethodPost, "/api/v1/auth/login", http.StatusOK},
		{http.MethodPost, "/api/v1/auth/logout", http.StatusOK},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, nil)
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s %s status = %d, want %d", tc.method, tc.path, rec.Code, tc.want)
		}
	}
}
