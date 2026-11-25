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
}
