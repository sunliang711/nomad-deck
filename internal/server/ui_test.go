package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestUIServingAndSPAFallback(t *testing.T) {
	e := newEnv(t)
	c := e.client().http

	resp, err := c.Get(e.srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Fatalf("GET / missing root element: %s", string(body))
	}

	resp, err = c.Get(e.srv.URL + "/dashboard")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /dashboard = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(string(body), `<div id="root">`) {
		t.Fatalf("GET /dashboard missing root element: %s", string(body))
	}

	resp, err = c.Get(e.srv.URL + "/api/v1/nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /api/v1/nonexistent = %d, want 404 (body=%s)", resp.StatusCode, string(body))
	}
	var errResp struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &errResp); err != nil {
		t.Fatalf("GET /api/v1/nonexistent invalid JSON %q: %v", string(body), err)
	}
	if errResp.Error.Code != "not_found" {
		t.Fatalf("GET /api/v1/nonexistent error.code = %q, want not_found", errResp.Error.Code)
	}

	resp, err = c.Get(e.srv.URL + "/favicon.svg")
	if err != nil {
		t.Fatal(err)
	}
	favBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(favBody), "<svg") {
		t.Fatalf("GET /favicon.svg = %d body=%q", resp.StatusCode, string(favBody))
	}

	cl := e.client()
	code, authStatus := cl.do("GET", "/api/v1/auth/status", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/v1/auth/status = %d", code)
	}
	if ver, _ := authStatus["version"].(string); ver == "" {
		t.Fatalf("GET /api/v1/auth/status missing version: %+v", authStatus)
	}

	adm := e.setup(t)
	if code, body := adm.do("PUT", "/api/v1/settings/proxy", map[string]any{
		"enabled":  true,
		"type":     "http",
		"host":     "127.0.0.1",
		"port":     3128,
		"username": "u1",
		"password": "proxy-secret-value",
	}, nil); code != http.StatusOK {
		t.Fatalf("PUT proxy = %d %+v", code, body)
	}
	if code, body := adm.do("POST", "/api/v1/settings/proxy/reveal", map[string]any{}, nil); code != http.StatusOK || body["password"] != "proxy-secret-value" {
		t.Fatalf("POST proxy/reveal = %d %+v", code, body)
	}

	if code, body := adm.do("PUT", "/api/v1/backup/config", map[string]any{
		"current_password": adminPass,
		"enabled":          true,
		"passphrase":       "very-long-backup-passphrase",
		"targets": []map[string]any{
			{
				"id":               "tgt_sk",
				"name":             "SafeKeep DR",
				"type":             "safekeep",
				"enabled":          true,
				"retention_count":  7,
				"safekeep_url":     "https://safekeep.local:8443",
				"safekeep_api_key": "sk-api-key-value",
			},
		},
	}, nil); code != http.StatusOK {
		t.Fatalf("PUT backup/config = %d %+v", code, body)
	}
	if code, body := adm.do("POST", "/api/v1/backup/secrets/reveal", map[string]any{
		"kind": "passphrase",
	}, nil); code != http.StatusOK || body["secret"] != "very-long-backup-passphrase" {
		t.Fatalf("reveal passphrase = %d %+v", code, body)
	}
	if code, body := adm.do("POST", "/api/v1/backup/secrets/reveal", map[string]any{
		"kind":      "target_secret",
		"target_id": "tgt_sk",
	}, nil); code != http.StatusOK || body["secret"] != "sk-api-key-value" {
		t.Fatalf("reveal target_secret = %d %+v", code, body)
	}
	if code, body := adm.do("POST", "/api/v1/cron-jobs", map[string]any{
		"name":            "SafeKeep Offsite DR",
		"cron_expr":       "0 2 * * *",
		"overlap_policy":  "skip_if_running",
		"misfire_policy":  "skip",
		"enabled":         true,
		"payload": map[string]any{
			"type":      "safekeep_backup",
			"target_id": "tgt_sk",
		},
	}, nil); code != http.StatusCreated {
		t.Fatalf("create safekeep cron job = %d %+v", code, body)
	}
}
