package server

import (
	"testing"
)

func TestSelfUpdateRoutesAndRBAC(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	viewer := e.makeViewer(t, root)

	// Viewer can read version, result and schedule.
	for _, path := range []string{"/api/v1/system/version", "/api/v1/system/self-update/result", "/api/v1/system/self-update/schedule"} {
		if code, _ := viewer.do("GET", path, nil, nil); code != 200 {
			t.Fatalf("viewer GET %s got %d, want 200", path, code)
		}
	}

	// Viewer cannot mutate self-update state.
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/v1/system/self-update"},
		{"POST", "/api/v1/system/self-update/schedule"},
		{"DELETE", "/api/v1/system/self-update/schedule"},
		{"POST", "/api/v1/system/self-update/rollback"},
	} {
		if code, _ := viewer.do(tc.method, tc.path, map[string]any{}, nil); code != 403 {
			t.Fatalf("viewer %s %s got %d, want 403", tc.method, tc.path, code)
		}
	}

	// Dev mode version info reports unavailable with reason.
	code, b := root.do("GET", "/api/v1/system/version", nil, nil)
	if code != 200 {
		t.Fatalf("GET /system/version: %d %v", code, b)
	}
	sys := b["system"].(map[string]any)
	if sys["available"] != false || sys["unavailable_reason"] == "" {
		t.Fatalf("expected unavailable in dev mode: %v", sys)
	}

	// Triggering self-update or schedule in dev mode returns 409 self_update_unavailable.
	if code, body := root.do("POST", "/api/v1/system/self-update", map[string]any{}, nil); code != 409 || errCode(body) != "self_update_unavailable" {
		t.Fatalf("POST /system/self-update got %d %v", code, body)
	}
	if code, body := root.do("POST", "/api/v1/system/self-update/schedule", map[string]any{"target_version": "latest"}, nil); code != 409 || errCode(body) != "self_update_unavailable" {
		t.Fatalf("POST /system/self-update/schedule got %d %v", code, body)
	}
	if code, body := root.do("POST", "/api/v1/system/self-update/rollback", nil, nil); code != 409 {
		t.Fatalf("POST /system/self-update/rollback got %d %v", code, body)
	}
}
