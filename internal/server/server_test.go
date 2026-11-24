package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/config"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

const origin = "https://deck.test"

func TestMain(m *testing.M) {
	crypto.PasswordParams = crypto.Argon2Params{Memory: 1024, Time: 1, Threads: 1, KeyLen: 32, SaltLen: 16}
	os.Exit(m.Run())
}

type env struct {
	t   *testing.T
	app *App
	srv *httptest.Server
}

func newEnv(t *testing.T) *env {
	t.Helper()
	t.Setenv("NOMAD_DECK_MASTER_KEY", "")
	t.Setenv("CREDENTIALS_DIRECTORY", "")
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.Listen = "127.0.0.1:0"
	cfg.Server.PublicURL = origin
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	app, err := Open(context.Background(), &cfg, log)
	if err != nil {
		t.Fatal(err)
	}
	app.ready.Store(true)
	srv := httptest.NewTLSServer(app.API.Handler())
	t.Cleanup(func() { srv.Close(); app.Close() })
	return &env{t: t, app: app, srv: srv}
}

type client struct {
	e    *env
	http *http.Client
	csrf string
}

func (e *env) client() *client {
	jar, _ := cookiejar.New(nil)
	hc := *e.srv.Client() // copy: srv.Client() returns a shared instance
	hc.Jar = jar
	return &client{e: e, http: &hc}
}

func (c *client) do(method, path string, body any, hdr map[string]string) (int, map[string]any) {
	c.e.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.e.srv.URL+path, rdr)
	req.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet {
		req.Header.Set("Origin", origin)
		if c.csrf != "" {
			req.Header.Set("X-CSRF-Token", c.csrf)
		}
	}
	for k, v := range hdr {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func errCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

func (c *client) login(user, pass string) int {
	code, body := c.do("POST", "/api/v1/auth/login", map[string]any{"username": user, "password": pass}, nil)
	if code == 200 {
		c.csrf, _ = body["csrf_token"].(string)
	}
	return code
}

const adminPass = "admin-password-1"

func (e *env) setup(t *testing.T) *client {
	tok, err := e.app.Auth.PrepareSetupToken(context.Background())
	if err != nil || tok == "" {
		t.Fatalf("setup token: %q %v", tok, err)
	}
	c := e.client()
	if code, _ := c.do("POST", "/api/v1/auth/setup", map[string]any{"setup_token": tok, "username": "root", "password": adminPass}, nil); code != 201 {
		t.Fatalf("setup = %d", code)
	}
	if c.login("root", adminPass) != 200 {
		t.Fatal("admin login failed")
	}
	return c
}

func TestSetupFlow(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	_, st := c.do("GET", "/api/v1/auth/status", nil, nil)
	if st["needs_setup"] != true {
		t.Fatal("expected needs_setup")
	}
	tok, _ := e.app.Auth.PrepareSetupToken(context.Background())
	tokenFile := filepath.Join(e.app.Config.DataDir, "setup.token")
	if b, _ := os.ReadFile(tokenFile); strings.TrimSpace(string(b)) != tok {
		t.Fatal("setup.token file must contain the token")
	}
	if code, b := c.do("POST", "/api/v1/auth/setup", map[string]any{"setup_token": "wrong", "username": "root", "password": adminPass}, nil); code != 401 || errCode(b) != "invalid_setup_token" {
		t.Fatalf("wrong token: %d %v", code, b)
	}
	if code, b := c.do("POST", "/api/v1/auth/setup", map[string]any{"setup_token": tok, "username": "root", "password": "short"}, nil); code != 400 {
		t.Fatalf("weak password: %d %v", code, b)
	}
	if code, _ := c.do("POST", "/api/v1/auth/setup", map[string]any{"setup_token": tok, "username": "root", "password": adminPass}, nil); code != 201 {
		t.Fatalf("setup: %d", code)
	}
	if code, b := c.do("POST", "/api/v1/auth/setup", map[string]any{"setup_token": tok, "username": "root2", "password": adminPass}, nil); code != 409 || errCode(b) != "already_setup" {
		t.Fatalf("second setup: %d %v", code, b)
	}
	if _, err := os.Stat(tokenFile); !os.IsNotExist(err) {
		t.Fatal("setup.token must be removed after setup")
	}
	// Default SSH key encrypted with the loaded master key.
	var ct string
	if err := e.app.DB.Reader.QueryRow(`SELECT private_key_encrypted FROM ssh_keys WHERE is_default = 1`).Scan(&ct); err != nil {
		t.Fatal(err)
	}
	pem, err := e.app.Keys.Decrypt(ct, "")
	if err == nil {
		t.Fatal("ciphertext must be bound to its row (AAD)")
	}
	var id string
	e.app.DB.Reader.QueryRow(`SELECT id FROM ssh_keys`).Scan(&id)
	pem, err = e.app.Keys.Decrypt(ct, db.SSHKeyAAD(id))
	if err != nil || !bytes.Contains(pem, []byte("OPENSSH PRIVATE KEY")) {
		t.Fatalf("decrypt default key: %v", err)
	}
}

func TestOriginAndCSRF(t *testing.T) {
	e := newEnv(t)
	c := e.setup(t)
	if code, b := c.do("POST", "/api/v1/auth/login", map[string]any{"username": "root", "password": adminPass}, map[string]string{"Origin": ""}); code != 403 || errCode(b) != "origin_rejected" {
		t.Fatalf("missing origin: %d %v", code, b)
	}
	if code, _ := c.do("POST", "/api/v1/auth/logout", nil, map[string]string{"Origin": "https://evil.example"}); code != 403 {
		t.Fatalf("foreign origin: %d", code)
	}
	if code, b := c.do("POST", "/api/v1/auth/logout", nil, map[string]string{"X-CSRF-Token": "bogus"}); code != 403 || errCode(b) != "csrf_failed" {
		t.Fatalf("bad csrf: %d %v", code, b)
	}
	_, st := c.do("GET", "/api/v1/auth/status", nil, nil)
	if st["csrf_token"] != c.csrf || st["authenticated"] != true {
		t.Fatalf("status must return the same csrf token: %v", st)
	}
	if code, _ := c.do("POST", "/api/v1/auth/logout", nil, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	_, st = c.do("GET", "/api/v1/auth/status", nil, nil)
	if st["authenticated"] != false {
		t.Fatal("session must be gone after logout")
	}
}

func TestRolesAndAccountManagement(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	if code, b := root.do("POST", "/api/v1/admins", map[string]any{"current_password": "wrong-password", "username": "vic", "password": "viewer-password-1", "role": "viewer"}, nil); code != 403 || errCode(b) != "wrong_current_password" {
		t.Fatalf("second verification: %d %v", code, b)
	}
	code, b := root.do("POST", "/api/v1/admins", map[string]any{"current_password": adminPass, "username": "vic", "password": "viewer-password-1", "role": "viewer"}, nil)
	if code != 201 {
		t.Fatalf("create viewer: %d %v", code, b)
	}
	vicID := b["admin"].(map[string]any)["id"].(string)
	if code, _ := root.do("POST", "/api/v1/admins", map[string]any{"current_password": adminPass, "username": "vic", "password": "viewer-password-1", "role": "viewer"}, nil); code != 409 {
		t.Fatalf("duplicate username: %d", code)
	}

	vic := e.client()
	if vic.login("vic", "viewer-password-1") != 200 {
		t.Fatal("viewer login")
	}
	if code, _ := vic.do("GET", "/api/v1/admins", nil, nil); code != 403 {
		t.Fatalf("viewer list admins: %d", code)
	}
	if code, _ := vic.do("POST", "/api/v1/admins", map[string]any{"current_password": "viewer-password-1", "username": "x1x", "password": "viewer-password-1", "role": "admin"}, nil); code != 403 {
		t.Fatalf("viewer create admin: %d", code)
	}
	if code, _ := vic.do("GET", "/api/v1/audit-logs", nil, nil); code != 200 {
		t.Fatalf("viewer audit read: %d", code)
	}

	// The only admin cannot demote or disable itself.
	_, me := root.do("GET", "/api/v1/auth/status", nil, nil)
	rootID := me["user"].(map[string]any)["id"].(string)
	if code, b := root.do("PUT", "/api/v1/admins/"+rootID+"/role", map[string]any{"current_password": adminPass, "role": "viewer"}, nil); code != 409 || errCode(b) != "last_admin" {
		t.Fatalf("demote last admin: %d %v", code, b)
	}
	if code, _ := root.do("POST", "/api/v1/admins/"+rootID+"/disable", map[string]any{"current_password": adminPass}, nil); code != 409 {
		t.Fatalf("disable last admin: %d", code)
	}

	// Role change revokes the target's sessions and closes subscriptions.
	sessions, _ := db.ListSessions(context.Background(), e.app.DB.Reader, vicID)
	revoked, cancel := e.app.Auth.Revocations.Subscribe(sessions[0].ID)
	defer cancel()
	if code, _ := root.do("PUT", "/api/v1/admins/"+vicID+"/role", map[string]any{"current_password": adminPass, "role": "admin"}, nil); code != 204 {
		t.Fatalf("promote: %d", code)
	}
	select {
	case <-revoked:
	case <-time.After(time.Second):
		t.Fatal("role change must revoke live connections")
	}
	if _, st := vic.do("GET", "/api/v1/auth/status", nil, nil); st["authenticated"] != false {
		t.Fatal("viewer session must be revoked after role change")
	}

	// Now two admins exist: demoting root is allowed; disable vic blocks login.
	if code, _ := root.do("POST", "/api/v1/admins/"+vicID+"/disable", map[string]any{"current_password": adminPass}, nil); code != 204 {
		t.Fatalf("disable: %d", code)
	}
	if vic.login("vic", "viewer-password-1") != 401 {
		t.Fatal("disabled account must not log in")
	}
	if code, _ := root.do("POST", "/api/v1/admins/"+vicID+"/enable", map[string]any{"current_password": adminPass}, nil); code != 204 {
		t.Fatalf("enable: %d", code)
	}
	if code, _ := root.do("POST", "/api/v1/admins/"+vicID+"/reset-password", map[string]any{"current_password": adminPass, "new_password": "new-viewer-pass-2"}, nil); code != 204 {
		t.Fatalf("reset: %d", code)
	}
	if vic.login("vic", "new-viewer-pass-2") != 200 {
		t.Fatal("login with reset password")
	}
}

func TestLockoutAndLocalReset(t *testing.T) {
	e := newEnv(t)
	e.setup(t)
	c := e.client()
	for i := 0; i < 5; i++ {
		if code := c.login("root", "bad-password-x"); code != 401 && code != 429 {
			t.Fatalf("attempt %d: %d", i, code)
		}
	}
	if code := c.login("root", adminPass); code != 429 {
		t.Fatalf("account must be locked, got %d", code)
	}
	if err := e.app.Auth.ResetPasswordLocal(context.Background(), "root", "rescued-password-1"); err != nil {
		t.Fatal(err)
	}
	// The per-IP limiter still applies to this client address; use a fresh service state.
	e.app.Auth.ClearIPLockouts()
	if code := c.login("root", "rescued-password-1"); code != 200 {
		t.Fatalf("login after local reset: %d", code)
	}
	logs, _ := db.ListAuditLogs(context.Background(), e.app.DB.Reader, db.AuditFilter{Limit: 500})
	var sawFail, sawReset bool
	for _, l := range logs {
		if strings.Contains(l.RequestSummaryJSON, "password-") || strings.Contains(l.ErrorMessage, "password-") {
			t.Fatalf("password leaked into audit: %+v", l)
		}
		if l.Action == "auth.login" && l.Result == "failed" {
			sawFail = true
		}
		if l.Action == "admin.reset_password_local" && l.ActorName == "local:cli" {
			sawReset = true
		}
	}
	if !sawFail || !sawReset {
		t.Fatalf("missing audit records: fail=%v reset=%v", sawFail, sawReset)
	}
}

func TestPasswordChangeKeepsCurrentSession(t *testing.T) {
	e := newEnv(t)
	a := e.setup(t)
	b := e.client()
	if b.login("root", adminPass) != 200 {
		t.Fatal("second login")
	}
	if code, _ := a.do("PUT", "/api/v1/auth/password", map[string]any{"current_password": adminPass, "new_password": "changed-password-1"}, nil); code != 204 {
		t.Fatalf("change password: %d", code)
	}
	if _, st := a.do("GET", "/api/v1/auth/status", nil, nil); st["authenticated"] != true {
		t.Fatal("current session must survive")
	}
	if _, st := b.do("GET", "/api/v1/auth/status", nil, nil); st["authenticated"] != false {
		t.Fatal("other session must be revoked")
	}
}

func TestHealthAndReady(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	if code, _ := c.do("GET", "/healthz", nil, nil); code != 200 {
		t.Fatal("healthz")
	}
	if code, _ := c.do("GET", "/readyz", nil, nil); code != 200 {
		t.Fatal("readyz")
	}
	e.app.ready.Store(false)
	if code, _ := c.do("GET", "/readyz", nil, nil); code != 503 {
		t.Fatal("readyz must fail when not ready")
	}
}

func TestStartupSelfCheckRejectsUnknownKey(t *testing.T) {
	e := newEnv(t)
	e.setup(t)
	dir := e.app.Config.DataDir
	e.srv.Close()
	e.app.Close()
	// Replace the master key: existing ciphertext now references a missing key.
	os.WriteFile(filepath.Join(dir, "master.key"), []byte(strings.Repeat("ab", 32)), 0o600)
	cfg := *e.app.Config
	if _, err := Open(context.Background(), &cfg, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil ||
		!strings.Contains(err.Error(), "self-check") {
		t.Fatalf("expected self-check failure, got %v", err)
	}
}
