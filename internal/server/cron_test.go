package server

import (
	"context"
	"testing"
	"time"
)

func TestCronRoutes(t *testing.T) {
	e := newEnv(t)
	root := e.setup(t)
	if err := e.app.Cron.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.app.Cron.Stop)
	viewer := e.makeViewer(t, root)
	code, b := viewer.do("GET", "/api/v1/cron-jobs", nil, nil)
	if code != 200 {
		t.Fatalf("list: %d %v", code, b)
	}
	jobs := b["cron_jobs"].([]any)
	if len(jobs) != 9 {
		t.Fatalf("nine built-in jobs, got %d", len(jobs))
	}
	var cleanupID string
	for _, j := range jobs {
		m := j.(map[string]any)
		if m["job_key"] == "cleanup_audit_logs" {
			cleanupID = m["id"].(string)
		}
	}
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/v1/cron-jobs"}, {"PUT", "/api/v1/cron-jobs/" + cleanupID},
		{"DELETE", "/api/v1/cron-jobs/" + cleanupID}, {"POST", "/api/v1/cron-jobs/" + cleanupID + "/run"},
	} {
		if code, _ := viewer.do(c.method, c.path, map[string]any{}, nil); code != 403 {
			t.Fatalf("viewer must not call %s %s", c.method, c.path)
		}
	}
	if code, b := root.do("PUT", "/api/v1/cron-jobs/"+cleanupID, map[string]any{"cron_expr": "15 2 * * *"}, nil); code != 200 {
		t.Fatalf("update: %d %v", code, b)
	}
	if code, b := root.do("PUT", "/api/v1/cron-jobs/"+cleanupID, map[string]any{"cron_expr": "bogus"}, nil); code != 400 {
		t.Fatalf("invalid expression: %d %v", code, b)
	}
	code, b = root.do("POST", "/api/v1/cron-jobs/"+cleanupID+"/run", nil, nil)
	if code != 202 {
		t.Fatalf("run: %d %v", code, b)
	}
	runID := b["run"].(map[string]any)["id"].(string)
	var status string
	for i := 0; i < 100 && status != "success"; i++ {
		_, b = viewer.do("GET", "/api/v1/cron-jobs/"+cleanupID+"/runs", nil, nil)
		for _, r := range b["runs"].([]any) {
			m := r.(map[string]any)
			if m["id"] == runID {
				status = m["status"].(string)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status != "success" {
		t.Fatalf("run status %q", status)
	}
	if code, b := root.do("PUT", "/api/v1/settings", map[string]any{"cron.timezone": "Asia/Shanghai"}, nil); code != 200 {
		t.Fatalf("timezone: %d %v", code, b)
	}
}
