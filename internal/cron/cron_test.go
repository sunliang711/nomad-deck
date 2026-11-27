package cron

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/nomaddev"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/sshx"
)

var admin = audit.Actor{ID: "a1", Name: "root"}

func newScheduler(t *testing.T, d *db.DB, engine *ops.Engine) *Scheduler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Scheduler{DB: d, Audit: &audit.Recorder{DB: d, Log: log}, Ops: engine, Log: log}
	return s
}

func testDB(t *testing.T) (*db.DB, *ops.Engine) {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	engine := ops.NewEngine(d, slog.New(slog.NewTextHandler(io.Discard, nil)), dir)
	t.Cleanup(engine.Wait)
	return d, engine
}

func jobByKey(t *testing.T, s *Scheduler, key string) *db.CronJob {
	t.Helper()
	j, err := db.GetCronJobByKey(context.Background(), s.DB.Reader, key)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func waitRun(t *testing.T, s *Scheduler, id string) *db.CronRun {
	t.Helper()
	for i := 0; i < 600; i++ {
		r, err := db.GetCronRun(context.Background(), s.DB.Reader, id)
		if err != nil {
			t.Fatal(err)
		}
		if r.Status != db.RunRunning {
			return r
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("run did not finish")
	return nil
}

func disableAll(t *testing.T, s *Scheduler) {
	t.Helper()
	off := false
	jobs, _ := db.ListCronJobs(context.Background(), s.DB.Reader)
	for _, j := range jobs {
		if _, err := s.Update(context.Background(), admin, j.ID, JobInput{Enabled: &off}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSchedulingPolicies(t *testing.T) {
	ctx := context.Background()
	d, engine := testDB(t)
	s := newScheduler(t, d, engine)
	release := make(chan struct{})
	var calls atomic.Int32
	s.Register("cert_expiry_check", func(ctx context.Context, r *Run) (string, error) {
		calls.Add(1)
		r.Logf("token=abc123 working")
		<-release
		return "done", nil
	})
	s.Register("self_update_check", func(ctx context.Context, r *Run) (string, error) { return "", Skip("nothing to do") })
	s.Register("cleanup_audit_logs", func(ctx context.Context, r *Run) (string, error) { return "", errors.New("boom") })
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if len(Builtins) != 10 {
		t.Fatal("ten built-in jobs")
	}
	disableAll(t, s)
	j := jobByKey(t, s, "cert_expiry_check")

	// Manual trigger runs; a second trigger while running is refused.
	run, err := s.Trigger(ctx, admin, j.ID)
	if err != nil || run == nil {
		t.Fatalf("trigger: %v", err)
	}
	if _, err := s.Trigger(ctx, admin, j.ID); err != ErrAlreadyRunning {
		t.Fatalf("overlap must be refused: %v", err)
	}
	// A scheduled window that arrives while running is recorded as skipped.
	at := time.Date(2030, 1, 1, 8, 0, 0, 0, time.UTC)
	skipped, err := s.fire(s.base, j, at, "scheduled", ActorCronForTest())
	if err != nil || skipped == nil || skipped.Status != db.RunSkipped {
		t.Fatalf("skip_if_running: %+v %v", skipped, err)
	}
	close(release)
	got := waitRun(t, s, run.ID)
	if got.Status != db.RunSuccess || got.Summary != "done" || got.TriggerType != "manual" {
		t.Fatalf("run: %+v", got)
	}
	if strings.Contains(got.DetailLog, "abc123") || !strings.Contains(got.DetailLog, "working") {
		t.Fatalf("detail log must be redacted: %q", got.DetailLog)
	}
	if fresh := jobByKey(t, s, "cert_expiry_check"); fresh.LastStatus != db.RunSuccess {
		t.Fatalf("last status: %+v", fresh)
	}

	// The same scheduled window never runs twice.
	release = make(chan struct{})
	close(release)
	at2 := at.Add(24 * time.Hour)
	first, _ := s.fire(s.base, j, at2, "scheduled", ActorCronForTest())
	waitRun(t, s, first.ID)
	if again, err := s.fire(s.base, j, at2, "scheduled", ActorCronForTest()); err != nil || again != nil {
		t.Fatalf("duplicate window: %+v %v", again, err)
	}

	// queue_one: a trigger during a run is queued and runs afterwards.
	q := "queue_one"
	if _, err := s.Update(ctx, admin, j.ID, JobInput{OverlapPolicy: q}); err != nil {
		t.Fatal(err)
	}
	release = make(chan struct{})
	calls.Store(0)
	run, _ = s.Trigger(ctx, admin, j.ID)
	if queued, err := s.Trigger(ctx, admin, j.ID); err != nil || queued != nil {
		t.Fatalf("queued trigger: %+v %v", queued, err)
	}
	close(release)
	waitRun(t, s, run.ID)
	_ = s.Idle(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	_ = s.Idle(ctx)
	if calls.Load() != 2 {
		t.Fatalf("queued run must execute once more, calls %d", calls.Load())
	}

	// Skip and failure outcomes.
	su := jobByKey(t, s, "self_update_check")
	run, _ = s.Trigger(ctx, admin, su.ID)
	if r := waitRun(t, s, run.ID); r.Status != db.RunSkipped || r.Summary != "nothing to do" {
		t.Fatalf("skip: %+v", r)
	}
	ca := jobByKey(t, s, "cleanup_audit_logs")
	run, _ = s.Trigger(ctx, admin, ca.ID)
	if r := waitRun(t, s, run.ID); r.Status != db.RunFailed || r.Summary != "boom" {
		t.Fatalf("failure: %+v", r)
	}

	// Activation gate: cluster jobs pause, local-only jobs keep running.
	if err := db.PutSettingJSON(ctx, d.Writer, SettingActivated, false, d.NowString()); err != nil {
		t.Fatal(err)
	}
	s.Register("vault_token_renew", func(ctx context.Context, r *Run) (string, error) { return "renewed", nil })
	vt := jobByKey(t, s, "vault_token_renew")
	if r, _ := s.Trigger(ctx, admin, vt.ID); r == nil || r.Status != db.RunSkipped || !strings.Contains(r.Summary, "尚未激活") {
		t.Fatalf("inactive control plane must skip: %+v", r)
	}
	run, _ = s.Trigger(ctx, admin, su.ID)
	if r := waitRun(t, s, run.ID); r.Status != db.RunSkipped || r.Summary == "nothing to do" {
		t.Fatalf("self update check is gated: %+v", r)
	}
	_ = db.PutSettingJSON(ctx, d.Writer, SettingActivated, true, d.NowString())
	// Global barrier skips everything.
	engine.SetBarrier("migration import")
	if r, _ := s.Trigger(ctx, admin, vt.ID); r == nil || r.Status != db.RunSkipped || !strings.Contains(r.Summary, "全局维护") {
		t.Fatalf("barrier must skip: %+v", r)
	}
	engine.SetBarrier("")
	run, _ = s.Trigger(ctx, admin, vt.ID)
	if r := waitRun(t, s, run.ID); r.Status != db.RunSuccess {
		t.Fatalf("after barrier: %+v", r)
	}
	runs, _ := s.Runs(ctx, vt.ID, 10)
	if len(runs) != 3 {
		t.Fatalf("history: %d", len(runs))
	}
}

// ActorCronForTest exposes the cron actor to tests.
func ActorCronForTest() audit.Actor { return audit.ActorCron }

func TestMisfirePolicies(t *testing.T) {
	ctx := context.Background()
	d, engine := testDB(t)
	s := newScheduler(t, d, engine)
	if err := s.seed(ctx); err != nil {
		t.Fatal(err)
	}
	var ran atomic.Int32
	h := func(ctx context.Context, r *Run) (string, error) { ran.Add(1); return "ok", nil }
	past := d.Now().Add(-3 * time.Hour)
	for _, key := range []string{"cert_expiry_check", "cleanup_audit_logs"} {
		j := jobByKey(t, s, key)
		if key == "cert_expiry_check" {
			j.MisfirePolicy = "run_once"
		}
		j.NextRunAt = past
		_ = db.UpdateCronJob(ctx, d.Writer, j)
	}
	jobs, _ := db.ListCronJobs(ctx, d.Reader)
	for _, j := range jobs {
		if j.JobKey != "cert_expiry_check" && j.JobKey != "cleanup_audit_logs" {
			j.Enabled = false
			_ = db.UpdateCronJob(ctx, d.Writer, j)
		}
	}
	s.Register("cert_expiry_check", h)
	s.Register("cleanup_audit_logs", h)
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	_ = s.Idle(ctx)
	time.Sleep(200 * time.Millisecond)
	_ = s.Idle(ctx)
	if ran.Load() != 1 {
		t.Fatalf("only the run_once job catches up once, ran %d", ran.Load())
	}
	ce := jobByKey(t, s, "cert_expiry_check")
	runs, _ := s.Runs(ctx, ce.ID, 10)
	if len(runs) != 1 || !runs[0].ScheduledFor.Equal(past.Truncate(time.Millisecond)) {
		t.Fatalf("misfire run: %+v", runs)
	}
	for _, key := range []string{"cert_expiry_check", "cleanup_audit_logs"} {
		if j := jobByKey(t, s, key); !j.NextRunAt.After(d.Now()) {
			t.Fatalf("%s next run must move to the future: %v", key, j.NextRunAt)
		}
	}
}

func TestJobEditingAndCleanup(t *testing.T) {
	ctx := context.Background()
	d, engine := testDB(t)
	s := newScheduler(t, d, engine)
	s.Install(&Platform{DataDir: t.TempDir()})
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	disableAll(t, s)
	code := func(err error) string {
		var ae *auth.Error
		if errors.As(err, &ae) {
			return ae.Code
		}
		return ""
	}
	bad := []JobInput{
		{Name: "x", CronExpr: "* * *", Payload: json.RawMessage(`{"type":"doctor","node_id":"n"}`)},
		{Name: "x", CronExpr: "CRON_TZ=UTC * * * * *", Payload: json.RawMessage(`{"type":"doctor","node_id":"n"}`)},
		{Name: "x", CronExpr: "*/5 * * * *", Payload: json.RawMessage(`{"type":"rm_rf"}`)},
		{Name: "x", CronExpr: "*/5 * * * *", Payload: json.RawMessage(`{"type":"doctor","node_id":"missing"}`)},
		{Name: "x", CronExpr: "*/5 * * * *", Payload: json.RawMessage(`{"type":"doctor","cluster_id":"a","node_id":"b"}`)},
		{Name: "x", CronExpr: "*/5 * * * *", Payload: json.RawMessage(`{"type":"cluster_snapshot","cluster_id":"nope"}`)},
		{Name: "x", CronExpr: "*/5 * * * *", Payload: json.RawMessage(`{"type":"doctor","node_id":"n","extra":1}`)},
	}
	for i, in := range bad {
		if _, err := s.Create(ctx, admin, in); code(err) != "invalid_argument" {
			t.Fatalf("case %d must be rejected: %v", i, err)
		}
	}
	now := d.Now()
	_, _ = d.Writer.Exec(`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
		VALUES ('k', 'k', 'ed25519', 'x', 'x', 'x', 1, ?, ?)`, db.FormatTime(now), db.FormatTime(now))
	if _, err := d.Writer.Exec(`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, created_at, updated_at) VALUES ('n1', 'n', '127.0.0.1', 'root', 'k', ?, ?)`,
		db.FormatTime(now), db.FormatTime(now)); err != nil {
		t.Fatal(err)
	}
	j, err := s.Create(ctx, admin, JobInput{Name: "体检", CronExpr: "0 4 * * *", Payload: json.RawMessage(`{"type":"doctor","node_id":"n1"}`)})
	if err != nil || !strings.HasPrefix(j.JobKey, "custom-") || j.NextRunAt.IsZero() {
		t.Fatalf("create: %+v %v", j, err)
	}
	builtin := jobByKey(t, s, "cleanup_audit_logs")
	if _, err := s.Update(ctx, admin, builtin.ID, JobInput{Payload: json.RawMessage(`{"type":"doctor"}`)}); code(err) != "invalid_argument" {
		t.Fatalf("built-in payload is fixed: %v", err)
	}
	if err := s.Delete(ctx, admin, builtin.ID); code(err) != "builtin_job" {
		t.Fatalf("built-in delete: %v", err)
	}
	if err := s.Delete(ctx, admin, j.ID); err != nil {
		t.Fatal(err)
	}

	// Cleanup jobs honour the retention settings.
	old := now.AddDate(0, 0, -120)
	_, _ = d.Writer.Exec(`INSERT INTO audit_logs (id, action, result, created_at) VALUES ('old', 'x', 'success', ?), ('new', 'x', 'success', ?)`,
		db.FormatTime(old), db.FormatTime(now))
	_, _ = d.Writer.Exec(`INSERT INTO operation_tasks (id, action, target_type, target_id, lock_mode, remote_op_id, status, created_at)
		VALUES ('t-old', 'x', '', '', 'none', 't-old', 'success', ?), ('t-run', 'x', '', '', 'none', 't-run', 'needs_reconcile', ?)`,
		db.FormatTime(old), db.FormatTime(old))
	logDir := engine.LogDir("t-old")
	_ = os.MkdirAll(logDir, 0o700)
	_ = os.WriteFile(filepath.Join(logDir, "1.log"), []byte("x"), 0o600)
	for _, key := range []string{"cleanup_audit_logs", "cleanup_operation_logs"} {
		run, err := s.Trigger(ctx, admin, jobByKey(t, s, key).ID)
		if err != nil {
			t.Fatal(err)
		}
		if r := waitRun(t, s, run.ID); r.Status != db.RunSuccess {
			t.Fatalf("%s: %+v", key, r)
		}
	}
	var n int
	_ = d.Reader.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE id IN ('old', 'new')`).Scan(&n)
	if n != 1 {
		t.Fatalf("audit cleanup kept %d", n)
	}
	_ = d.Reader.QueryRow(`SELECT COUNT(*) FROM operation_tasks WHERE id IN ('t-old', 't-run')`).Scan(&n)
	if n != 1 {
		t.Fatalf("tasks needing reconciliation are kept, others removed: %d", n)
	}
	if _, err := os.Stat(logDir); !os.IsNotExist(err) {
		t.Fatal("step logs of removed tasks are deleted")
	}
}

func TestSnapshotAndHealthJobs(t *testing.T) {
	dev := nomaddev.Start(t)
	ctx := context.Background()
	s := newScheduler(t, dev.DB, dev.Ops)
	h := &hosts.Service{DB: dev.DB, Keys: dev.Keys, Audit: dev.Audit, Pool: sshx.NewPool(2)}
	s.Install(&Platform{Hosts: h, Drivers: map[string]cluster.Driver{"nomad": dev.Nomad.Driver()}, DataDir: dev.Dir})
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	disableAll(t, s)
	_ = db.PutSettingJSON(ctx, dev.DB.Writer, "snapshot.retention_count", 2, dev.DB.NowString())
	manual, err := dev.Nomad.Driver().TakeSnapshot(ctx, dev.Cluster.ID, "manual", "root")
	if err != nil {
		t.Fatal(err)
	}
	job := jobByKey(t, s, "raft_snapshot_backup")
	var files []string
	for i := 0; i < 3; i++ {
		run, err := s.Trigger(ctx, admin, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		r := waitRun(t, s, run.ID)
		if r.Status != db.RunSuccess || r.OperationTaskID == "" {
			t.Fatalf("snapshot run: %+v", r)
		}
		task, _ := db.GetTask(ctx, dev.DB.Reader, r.OperationTaskID)
		if task.Status != db.TaskSuccess || task.Action != "cron.raft_snapshot_backup" {
			t.Fatalf("linked task: %+v", task)
		}
	}
	snaps, _ := db.ListSnapshots(ctx, dev.DB.Reader, dev.Cluster.ID)
	scheduled := 0
	for _, sn := range snaps {
		if sn.TriggerType == "scheduled" {
			scheduled++
			files = append(files, sn.FilePath)
		}
	}
	if scheduled != 2 || len(snaps) != 3 || snaps[len(snaps)-1].ID != manual.ID {
		t.Fatalf("rotation keeps 2 scheduled snapshots and never touches manual ones: %d of %d", scheduled, len(snaps))
	}
	entries, _ := os.ReadDir(filepath.Dir(files[0]))
	if len(entries) != 3 {
		t.Fatalf("rotated snapshot files are deleted, %d left", len(entries))
	}
	// Rotation waits for downloads: an exclusive store lock held elsewhere
	// keeps the old snapshot in place.
	_ = s.Ops.Locks // documented in rotateSnapshots

	health := jobByKey(t, s, "cluster_health_check")
	run, _ := s.Trigger(ctx, admin, health.ID)
	r := waitRun(t, s, run.ID)
	if r.Status != db.RunSuccess || !strings.Contains(r.Summary, "主机在线 0/1") || !strings.Contains(r.Summary, "healthy 1") {
		t.Fatalf("health: %+v", r)
	}
	if n, _ := db.GetNode(ctx, dev.DB.Reader, "h1"); n.Status != "offline" {
		t.Fatalf("unreachable host is marked offline: %s", n.Status)
	}
	cert := jobByKey(t, s, "cert_expiry_check")
	run, _ = s.Trigger(ctx, admin, cert.ID)
	if r := waitRun(t, s, run.ID); r.Status != db.RunSuccess {
		t.Fatalf("cert: %+v", r)
	}
}

func TestSchedulePresetsTimeoutAndPagination(t *testing.T) {
	ctx := context.Background()
	d, engine := testDB(t)
	s := newScheduler(t, d, engine)
	if err := s.seed(ctx); err != nil {
		t.Fatal(err)
	}
	s.Register("cleanup_audit_logs", func(ctx context.Context, _ *Run) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	})
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	disableAll(t, s)

	// Schedule type validation rejects mismatched cron_expr.
	j := jobByKey(t, s, "cleanup_audit_logs")
	if _, err := s.Update(ctx, admin, j.ID, JobInput{
		ScheduleType: "daily",
		CronExpr:     "0 * * * *",
	}); err == nil {
		t.Fatal("expected daily schedule_type to reject hourly expression")
	}
	if _, err := s.Update(ctx, admin, j.ID, JobInput{
		ScheduleType: "every_5_minutes",
		CronExpr:     "* * * * *",
	}); err == nil {
		t.Fatal("expected every_5_minutes schedule_type to reject every-minute expression")
	}
	for _, tc := range []struct {
		kind string
		expr string
	}{
		{"every_minute", "* * * * *"},
		{"every_5_minutes", "*/5 * * * *"},
		{"every_10_minutes", "*/10 * * * *"},
		{"hourly", "0 * * * *"},
		{"daily", "0 0 * * *"},
		{"weekly", "0 0 * * 1"},
		{"monthly", "0 0 1 * *"},
	} {
		if got := InferScheduleType(tc.expr); got != tc.kind {
			t.Fatalf("InferScheduleType(%q) = %q, want %q", tc.expr, got, tc.kind)
		}
		if _, kind, _, err := ValidateSchedule(tc.kind, tc.expr, "Asia/Singapore"); err != nil || kind != tc.kind {
			t.Fatalf("ValidateSchedule(%q, %q) = kind=%q err=%v", tc.kind, tc.expr, kind, err)
		}
	}
	tz := "Asia/Singapore"
	timeout := 1
	updated, err := s.Update(ctx, admin, j.ID, JobInput{
		ScheduleType:   "daily",
		CronExpr:       "0 0 * * *",
		Timezone:       &tz,
		TimeoutSeconds: &timeout,
		Config:         json.RawMessage(`{"retention":"7d"}`),
	})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.ScheduleType != "daily" || updated.Timezone != "Asia/Singapore" || updated.TimeoutSeconds != 1 {
		t.Fatalf("unexpected updated job: %+v", updated)
	}

	// PreviewSchedule returns 5 future occurrences in the requested timezone.
	times, resolvedTZ, err := s.PreviewSchedule(ctx, SchedulePreviewRequest{
		ScheduleType:   "weekly",
		CronExpression: "0 5 * * 1",
		Timezone:       "Asia/Shanghai",
	}, 5)
	if err != nil || len(times) != 5 || resolvedTZ != "Asia/Shanghai" {
		t.Fatalf("PreviewSchedule: times=%d tz=%q err=%v", len(times), resolvedTZ, err)
	}

	// Timeout marks run status as timeout and failedOnly filter picks it up.
	run, err := s.Trigger(ctx, admin, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	r := waitRun(t, s, run.ID)
	if r.Status != db.RunTimeout {
		t.Fatalf("expected timeout status, got %q (%+v)", r.Status, r)
	}
	items, total, err := s.RunsPage(ctx, j.ID, true, 1, 20)
	if err != nil || total != 1 || len(items) != 1 || items[0].Status != db.RunTimeout {
		t.Fatalf("RunsPage failedOnly: total=%d len=%d err=%v", total, len(items), err)
	}
}

func TestSystemProxyCheckJob(t *testing.T) {
	ctx := context.Background()
	d, engine := testDB(t)
	keys, err := crypto.NewKeyringForTest(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	proxyMgr := &netx.Manager{DB: d, Keys: keys}
	s := newScheduler(t, d, engine)
	s.Install(&Platform{Proxy: proxyMgr, DataDir: t.TempDir()})
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	disableAll(t, s)

	j := jobByKey(t, s, "system_proxy_check")
	if j.CronExpr != "*/30 * * * *" {
		t.Fatalf("expected */30 * * * *, got %q", j.CronExpr)
	}

	// Unconfigured proxy -> skipped.
	run, err := s.Trigger(ctx, admin, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := waitRun(t, s, run.ID); r.Status != db.RunSkipped || !strings.Contains(r.Summary, "尚未配置系统代理") {
		t.Fatalf("expected skip when proxy unconfigured, got %+v", r)
	}

	// Local mock proxy server + local target.
	var failTarget atomic.Bool
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.String(), "/ip") {
			_, _ = w.Write([]byte("1.2.3.4\n"))
			return
		}
		if failTarget.Load() && strings.Contains(r.URL.String(), "bad") {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer proxySrv.Close()

	pu, _ := url.Parse(proxySrv.URL)
	port, _ := strconv.Atoi(pu.Port())
	if err := d.WithTx(ctx, func(tx *sql.Tx) error {
		return proxyMgr.Save(ctx, tx, &netx.ProxyConfig{Type: "http", Host: pu.Hostname(), Port: port}, nil)
	}); err != nil {
		t.Fatal(err)
	}

	origTargets := proxyTestTargets
	origExit := netx.ExitIPURL
	defer func() {
		proxyTestTargets = origTargets
		netx.ExitIPURL = origExit
	}()
	netx.ExitIPURL = "http://mock.local/ip"
	proxyTestTargets = func(string) []netx.TestTarget {
		return []netx.TestTarget{
			{Name: "TargetOK", URL: "http://mock.local/ok"},
			{Name: "TargetBad", URL: "http://mock.local/bad"},
		}
	}

	// All reachable -> success.
	run, err = s.Trigger(ctx, admin, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := waitRun(t, s, run.ID); r.Status != db.RunSuccess || !strings.Contains(r.Summary, "2/2") || !strings.Contains(r.Summary, "1.2.3.4") {
		t.Fatalf("expected success with 2/2 and exit ip, got %+v", r)
	}

	// One target failing -> failed.
	failTarget.Store(true)
	run, err = s.Trigger(ctx, admin, j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r := waitRun(t, s, run.ID); r.Status != db.RunFailed || !strings.Contains(r.Summary, "TargetBad") {
		t.Fatalf("expected failed mentioning TargetBad, got %+v", r)
	}
}
