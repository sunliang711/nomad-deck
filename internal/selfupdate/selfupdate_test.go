package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/version"
)

func TestSemverParseAndCompare(t *testing.T) {
	if _, err := ParseSemver("dev"); err == nil {
		t.Fatal("dev must fail semver parse")
	}
	if _, err := ParseSemver("1.2"); err == nil {
		t.Fatal("short version must fail")
	}
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.0.0", "v1.0.1", -1},
		{"v1.1.0-rc1", "v1.1.0", -1},
		{"v1.1.0", "v1.1.0-rc1", 1},
		{"v1.0.0-rc.2", "v1.0.0-rc.10", -1},
		{"v1.0.0-rc.10", "v1.0.0-rc.2", 1},
		{"v1.0.0-alpha.1", "v1.0.0-alpha.beta", -1},
		{"1.2.3", "v1.2.3", 0},
		{"v2.0.0", "v1.9.9", 1},
	}
	for _, tc := range cases {
		got, err := CompareSemver(tc.a, tc.b)
		if err != nil || got != tc.want {
			t.Fatalf("CompareSemver(%q, %q) = %d (%v), want %d", tc.a, tc.b, got, err, tc.want)
		}
	}
}

type fakeReleaseServer struct {
	srv        *httptest.Server
	mu         sync.Mutex
	releases   []GitHubRelease
	assets     map[string][]byte
	tamperSig  bool
	tamperHash bool
}

func newFakeReleaseServer(t *testing.T) (*fakeReleaseServer, ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fs := &fakeReleaseServer{assets: map[string][]byte{}}
	fs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fs.mu.Lock()
		defer fs.mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/releases") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(fs.releases)
			return
		}
		data, ok := fs.assets[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(fs.srv.Close)
	return fs, pub, priv
}

func (f *fakeReleaseServer) addRelease(ver string, prerelease bool, priv ed25519.PrivateKey) {
	verNoV := strings.TrimPrefix(ver, "v")
	archiveName := fmt.Sprintf("nomad-deck_%s_%s_%s.tar.gz", verNoV, runtime.GOOS, runtime.GOARCH)

	var tarBuf bytes.Buffer
	gz := gzip.NewWriter(&tarBuf)
	tw := tar.NewWriter(gz)
	script := []byte(fmt.Sprintf("#!/bin/sh\necho \"nomad-deck %s\"\n", ver))
	_ = tw.WriteHeader(&tar.Header{Name: "nomad-deck", Mode: 0o755, Size: int64(len(script)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(script)
	_ = tw.Close()
	_ = gz.Close()
	archBytes := tarBuf.Bytes()

	sum := sha256.Sum256(archBytes)
	digest := hex.EncodeToString(sum[:])
	if f.tamperHash {
		digest = strings.Repeat("0", 64)
	}
	sums := []byte(fmt.Sprintf("%s  %s\n", digest, archiveName))
	sig := ed25519.Sign(priv, sums)
	if f.tamperSig {
		sig[0] ^= 0xff
	}
	sigEncoded := []byte(base64.StdEncoding.EncodeToString(sig) + "\n")

	f.mu.Lock()
	defer f.mu.Unlock()
	base := "/dl/" + ver
	f.assets[base+"/"+archiveName] = archBytes
	f.assets[base+"/SHA256SUMS"] = sums
	f.assets[base+"/SHA256SUMS.sig"] = sigEncoded
	f.releases = append(f.releases, GitHubRelease{
		TagName:     ver,
		Name:        ver,
		Body:        "Release notes for " + ver,
		Prerelease:  prerelease,
		PublishedAt: time.Now().UTC(),
		Assets: []ReleaseAsset{
			{Name: archiveName, BrowserDownloadURL: f.srv.URL + base + "/" + archiveName, Size: int64(len(archBytes))},
			{Name: "SHA256SUMS", BrowserDownloadURL: f.srv.URL + base + "/SHA256SUMS", Size: int64(len(sums))},
			{Name: "SHA256SUMS.sig", BrowserDownloadURL: f.srv.URL + base + "/SHA256SUMS.sig", Size: int64(len(sigEncoded))},
		},
	})
}

func setupUpdateLayout(t *testing.T, curVer string, pub ed25519.PublicKey, apiBase string) (*Service, string, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	binDir := filepath.Join(root, "bin")
	verDir := filepath.Join(binDir, "versions")
	_ = os.MkdirAll(verDir, 0o755)
	_ = os.MkdirAll(dataDir, 0o700)

	curBin := filepath.Join(verDir, "nomad-deck-"+strings.TrimPrefix(curVer, "v"))
	_ = os.WriteFile(curBin, []byte("#!/bin/sh\necho \"nomad-deck "+curVer+"\"\n"), 0o755)
	_ = os.Symlink(curBin, filepath.Join(binDir, "nomad-deck"))

	d, err := db.Open(context.Background(), filepath.Join(dataDir, mainDBName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{5}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := &audit.Recorder{DB: d, Log: log}
	engine := ops.NewEngine(d, log, dataDir)
	proxy := &netx.Manager{DB: d, Keys: keys}

	svc := &Service{
		DB:             d,
		Audit:          rec,
		Ops:            engine,
		Proxy:          proxy,
		DataDir:        dataDir,
		BinDir:         binDir,
		CurrentVersion: curVer,
		APIBase:        apiBase,
		PublicKey:      pub,
		ContainerCheck: func() bool { return false },
		Log:            log,
	}
	return svc, dataDir, binDir
}

func TestAvailabilityChecks(t *testing.T) {
	_, pub, _ := newFakeReleaseServer(t)
	svc, _, _ := setupUpdateLayout(t, "v1.0.0", pub, "http://127.0.0.1")
	if ok, reason := svc.Availability(); !ok {
		t.Fatalf("expected available, got %q", reason)
	}
	svc.ContainerCheck = func() bool { return true }
	if ok, _ := svc.Availability(); ok {
		t.Fatal("container mode must disable self-update")
	}
	svc.ContainerCheck = func() bool { return false }
	svc.CurrentVersion = "dev"
	if ok, _ := svc.Availability(); ok {
		t.Fatal("dev version must disable self-update")
	}
	svc.CurrentVersion = "v1.0.0"
	svc.PublicKey = nil
	if ok, _ := svc.Availability(); ok {
		t.Fatal("missing pubkey must disable self-update")
	}
}

func TestTamperedSignatureAndSHA256Abort(t *testing.T) {
	ctx := context.Background()
	fs, pub, priv := newFakeReleaseServer(t)
	svc, _, binDir := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)

	// 1. Tampered signature.
	fs.tamperSig = true
	fs.addRelease("v1.1.0", false, priv)
	task, err := svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "v1.1.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.Ops.Wait()
	gotTask, _ := db.GetTask(ctx, svc.DB.Reader, task.ID)
	if gotTask.Status != db.TaskFailed || !strings.Contains(gotTask.ErrorMessage, "签名") {
		t.Fatalf("expected signature failure, got %+v", gotTask)
	}
	linkTarget, _ := os.Readlink(filepath.Join(binDir, "nomad-deck"))
	if !strings.HasSuffix(linkTarget, "1.0.0") {
		t.Fatalf("symlink must remain v1.0.0, got %s", linkTarget)
	}

	// 2. Tampered SHA256.
	fs.mu.Lock()
	fs.releases = nil
	fs.tamperSig = false
	fs.tamperHash = true
	fs.mu.Unlock()
	fs.addRelease("v1.2.0", false, priv)
	task, err = svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "v1.2.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.Ops.Wait()
	gotTask, _ = db.GetTask(ctx, svc.DB.Reader, task.ID)
	if gotTask.Status != db.TaskFailed || !strings.Contains(gotTask.ErrorMessage, "SHA-256") {
		t.Fatalf("expected sha256 failure, got %+v", gotTask)
	}
}

func TestUpgradeConfirmAutoRollbackAndManualRollback(t *testing.T) {
	ctx := context.Background()
	fs, pub, priv := newFakeReleaseServer(t)
	fs.addRelease("v1.1.0", false, priv)

	svc, dataDir, binDir := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)
	_ = db.PutSettingJSON(ctx, svc.DB.Writer, SettingBackupRetention, 2, svc.DB.NowString())
	// Seed 2 older pre-upgrade backups to verify retention pruning on startup confirm.
	_ = os.MkdirAll(filepath.Join(dataDir, "backups"), 0o700)
	_ = os.WriteFile(filepath.Join(dataDir, "backups", "pre-upgrade-0.8.0-0.9.0-20260101T000000Z.db"), []byte("old1"), 0o600)
	_ = os.WriteFile(filepath.Join(dataDir, "backups", "pre-upgrade-0.9.0-1.0.0-20260102T000000Z.db"), []byte("old2"), 0o600)

	var restarted atomic.Int32
	svc.OnRestart = func(code int) { restarted.Store(int32(code)) }

	task, err := svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "latest", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.Ops.Wait()
	for i := 0; i < 50 && restarted.Load() != version.ExitCodeRestart; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if restarted.Load() != version.ExitCodeRestart {
		t.Fatalf("expected exit code 75, got %d", restarted.Load())
	}

	// Task must remain "running" across handover.
	gotTask, _ := db.GetTask(ctx, svc.DB.Reader, task.ID)
	if gotTask.Status != db.TaskRunning {
		t.Fatalf("task status before restart=%q, want running", gotTask.Status)
	}
	if svc.Ops.Barrier() != "self_update" {
		t.Fatalf("barrier=%q, want self_update", svc.Ops.Barrier())
	}
	curLink, _ := os.Readlink(filepath.Join(binDir, "nomad-deck"))
	prevLink, _ := os.Readlink(filepath.Join(binDir, "nomad-deck.prev"))
	if !strings.HasSuffix(curLink, "1.1.0") || !strings.HasSuffix(prevLink, "1.0.0") {
		t.Fatalf("symlinks cur=%s prev=%s", curLink, prevLink)
	}

	// Auto-rollback check before confirmation: allowed == true.
	ok, res, err := CheckAutoRollback(ctx, dataDir)
	if err != nil || !ok || res == nil {
		t.Fatalf("CheckAutoRollback=%v res=%+v err=%v", ok, res, err)
	}

	// Simulate startup confirmation on v1.1.0.
	svc2 := &Service{
		DB: svc.DB, Audit: svc.Audit, Ops: svc.Ops, Proxy: svc.Proxy,
		DataDir: dataDir, BinDir: binDir, CurrentVersion: "v1.1.0", PublicKey: pub,
		ContainerCheck: func() bool { return false }, Log: svc.Log,
	}
	svc2.ConfirmOnStartup(ctx)
	gotTask, _ = db.GetTask(ctx, svc.DB.Reader, task.ID)
	if gotTask.Status != db.TaskSuccess {
		t.Fatalf("after confirm task status=%q, want success", gotTask.Status)
	}
	if svc.Ops.Barrier() != "" {
		t.Fatalf("barrier not cleared: %q", svc.Ops.Barrier())
	}
	// Backups pruned to 2 (from 3).
	bEntries, _ := os.ReadDir(filepath.Join(dataDir, "backups"))
	if len(bEntries) != 2 {
		t.Fatalf("expected 2 backups retained, got %d", len(bEntries))
	}

	// Normal crash (state == succeeded) must NOT trigger auto-rollback.
	if ok, _, err := CheckAutoRollback(ctx, dataDir); err != nil || ok {
		t.Fatalf("normal crash must not trigger auto-rollback: ok=%v err=%v", ok, err)
	}

	// Manual rollback when schema matches triggers exit 75.
	var rbExit atomic.Int32
	svc2.OnRestart = func(code int) { rbExit.Store(int32(code)) }
	rbTask, err := svc2.ManualRollback(ctx, audit.Actor{Name: "root"})
	if err != nil {
		t.Fatalf("ManualRollback: %v", err)
	}
	svc2.Ops.Wait()
	for i := 0; i < 50 && rbExit.Load() != version.ExitCodeRestart; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if rbExit.Load() != version.ExitCodeRestart {
		t.Fatalf("manual rollback exit=%d, want 75", rbExit.Load())
	}
	_ = rbTask
	curLink, _ = os.Readlink(filepath.Join(binDir, "nomad-deck"))
	if !strings.HasSuffix(curLink, "1.0.0") {
		t.Fatalf("expected symlink back to 1.0.0, got %s", curLink)
	}

	// Schema mismatch blocks manual UI rollback with 409 schema_changed (checked on a fresh service instance).
	svc3 := &Service{
		DB: svc.DB, Audit: svc.Audit, Ops: svc.Ops, Proxy: svc.Proxy,
		DataDir: dataDir, BinDir: binDir, CurrentVersion: "v1.1.0", PublicKey: pub,
		ContainerCheck: func() bool { return false }, Log: svc.Log,
	}
	svc.Ops.SetBarrier("")
	res.State = StateSucceeded
	res.ManualRollback = false
	res.FromSchema = 1
	_ = db.PutSettingJSON(ctx, svc3.DB.Writer, SettingLastResult, res, svc3.DB.NowString())
	_, err = svc3.ManualRollback(ctx, audit.Actor{Name: "root"})
	var ae *auth.Error
	if !errors.As(err, &ae) || ae.Status != 409 || ae.Code != "schema_changed" {
		t.Fatalf("expected 409 schema_changed, got %v", err)
	}
}

func TestAutoRollbackAndPowerLossBeforeSwap(t *testing.T) {
	ctx := context.Background()
	fs, pub, priv := newFakeReleaseServer(t)
	fs.addRelease("v1.1.0", false, priv)

	svc, dataDir, binDir := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)
	// Insert a marker row before upgrade so we verify DB restore reverts post-backup changes.
	_ = db.PutSettingJSON(ctx, svc.DB.Writer, "cron.timezone", "Asia/Shanghai", svc.DB.NowString())

	if _, err := svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "v1.1.0", nil); err != nil {
		t.Fatal(err)
	}
	svc.Ops.Wait()

	// Write a post-backup change that auto-rollback should revert.
	_ = db.PutSettingJSON(ctx, svc.DB.Writer, "cron.timezone", "Europe/London", svc.DB.NowString())
	// Close DB before offline rollback replaces the SQLite file.
	svc.DB.Close()

	if err := RunAutoRollback(ctx, dataDir, binDir); err != nil {
		t.Fatalf("RunAutoRollback: %v", err)
	}
	curLink, _ := os.Readlink(filepath.Join(binDir, "nomad-deck"))
	if !strings.HasSuffix(curLink, "1.0.0") {
		t.Fatalf("auto-rollback symlink=%s, want 1.0.0", curLink)
	}
	// At most one auto-rollback per upgrade.
	ok, res, err := CheckAutoRollback(ctx, dataDir)
	if err != nil || ok || res.State != StateRolledBack || res.RollbackCount != 1 {
		t.Fatalf("second CheckAutoRollback ok=%v res=%+v err=%v", ok, res, err)
	}

	d2, err := db.Open(ctx, filepath.Join(dataDir, mainDBName))
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	var tz string
	_ = db.GetSettingJSON(ctx, d2.Reader, "cron.timezone", &tz)
	if tz != "Asia/Shanghai" {
		t.Fatalf("restored DB timezone=%q, want Asia/Shanghai", tz)
	}
	var taskStatus string
	_ = d2.Reader.QueryRow(`SELECT status FROM operation_tasks WHERE id = ?`, res.TaskID).Scan(&taskStatus)
	if taskStatus != db.TaskRolledBack {
		t.Fatalf("task status=%q, want rolled_back", taskStatus)
	}

	// Test power-loss before symlink swap: state == prepared while running from-version.
	targetBin := filepath.Join(binDir, "versions", "nomad-deck-1.1.0")
	_ = os.WriteFile(targetBin, []byte("partial"), 0o755)
	_ = db.InsertTask(ctx, d2.Writer, &db.OperationTask{
		ID: "t-pl", Action: "system.self_update", TargetType: "control_plane", TargetID: "self",
		LockMode: "none", RemoteOpID: "t-pl", Status: db.TaskRunning, CreatedAt: d2.Now(),
	})
	_ = db.PutSettingJSON(ctx, d2.Writer, SettingLastResult, UpdateResult{
		State: StatePrepared, FromVersion: "v1.0.0", ToVersion: "v1.1.0", TaskID: "t-pl",
		PrevBinary: filepath.Join(binDir, "versions", "nomad-deck-1.0.0"), TargetBinary: targetBin,
	}, d2.NowString())
	svcPL := &Service{
		DB: d2, Audit: &audit.Recorder{DB: d2, Log: svc.Log}, Ops: ops.NewEngine(d2, svc.Log, dataDir),
		Proxy: &netx.Manager{DB: d2, Keys: svc.Proxy.Keys}, DataDir: dataDir, BinDir: binDir,
		CurrentVersion: "v1.0.0", PublicKey: pub, ContainerCheck: func() bool { return false }, Log: svc.Log,
	}
	svcPL.ConfirmOnStartup(ctx)
	plTask, _ := db.GetTask(ctx, d2.Reader, "t-pl")
	if plTask.Status != db.TaskFailed || plTask.ErrorMessage != "切换前中断" {
		t.Fatalf("power loss task=%+v", plTask)
	}
	if _, err := os.Stat(targetBin); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("target binary should be cleaned after pre-swap interruption")
	}
}

func TestScheduledUpgradeAndProxyEnforcement(t *testing.T) {
	ctx := context.Background()
	fs, pub, priv := newFakeReleaseServer(t)
	svc, _, _ := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)

	// use_proxy=true without proxy configured must return 400.
	useTrue := true
	if _, err := svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "latest", &useTrue); err == nil {
		t.Fatal("expected 400 proxy_not_configured")
	}

	// Create schedule waiting for v1.2.0.
	sc, err := svc.CreateSchedule(ctx, audit.Actor{Name: "root"}, ScheduleInput{
		TargetVersion: "v1.2.0", WaitSeconds: 60, IntervalSeconds: 5,
	})
	if err != nil || sc.Status != SchedWaiting {
		t.Fatalf("CreateSchedule: %+v err=%v", sc, err)
	}
	// Immediate upgrade blocked while schedule waiting.
	if _, err := svc.StartUpgrade(ctx, audit.Actor{Name: "root"}, "latest", nil); err == nil {
		t.Fatal("expected 409 when schedule is waiting")
	}

	// Cancel works while waiting.
	if csc, err := svc.CancelSchedule(ctx, audit.Actor{Name: "root"}); err != nil || csc.Status != SchedCancelled {
		t.Fatalf("CancelSchedule: %+v err=%v", csc, err)
	}

	// Create another schedule and release v1.2.0 -> stepSchedule triggers upgrade.
	sc, err = svc.CreateSchedule(ctx, audit.Actor{Name: "root"}, ScheduleInput{
		TargetVersion: "v1.2.0", WaitSeconds: 60, IntervalSeconds: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	fs.addRelease("v1.2.0", false, priv)
	svc.stepSchedule(ctx)
	svc.Ops.Wait()

	got, _ := svc.GetSchedule(ctx)
	if got.Status != SchedUpgrading || got.TaskID == "" {
		t.Fatalf("expected upgrading schedule, got %+v", got)
	}
	// Cancel while upgrading must fail.
	if _, err := svc.CancelSchedule(ctx, audit.Actor{Name: "root"}); err == nil {
		t.Fatal("cancel while upgrading must fail")
	}
}

func TestResolveReleaseFiltersPrereleaseOnStable(t *testing.T) {
	releases := []GitHubRelease{
		{
			TagName:    "v1.2.0-rc.1",
			Prerelease: false, // Even if GitHub flag is false, semver prerelease must be filtered on stable.
			Assets: []ReleaseAsset{
				{Name: "nomad-deck_1.2.0-rc.1_linux_amd64.tar.gz", BrowserDownloadURL: "https://example.invalid/rc.tar.gz", Size: 123},
				{Name: "SHA256SUMS", BrowserDownloadURL: "https://example.invalid/SHA256SUMS", Size: 64},
				{Name: "SHA256SUMS.sig", BrowserDownloadURL: "https://example.invalid/SHA256SUMS.sig", Size: 64},
			},
		},
	}
	if _, err := ResolveRelease(releases, "latest", ChannelStable, "linux", "amd64"); err == nil {
		t.Fatal("expected stable channel to reject semver prerelease tag even when Prerelease=false")
	}
	info, err := ResolveRelease(releases, "latest", ChannelPrerelease, "linux", "amd64")
	if err != nil || info.Version != "v1.2.0-rc.1" {
		t.Fatalf("prerelease channel resolve: %+v err=%v", info, err)
	}
}

func TestScheduledLatestKeepsWaitingAndCancelClearsFinished(t *testing.T) {
	ctx := context.Background()
	fs, pub, priv := newFakeReleaseServer(t)
	fs.addRelease("v1.0.0", false, priv)
	svc, _, _ := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)

	sc, err := svc.CreateSchedule(ctx, audit.Actor{Name: "root"}, ScheduleInput{
		TargetVersion: "latest", WaitSeconds: 60, IntervalSeconds: 5,
	})
	if err != nil || sc.Status != SchedWaiting {
		t.Fatalf("CreateSchedule: %+v err=%v", sc, err)
	}

	// First check when latest == current must stay waiting and record resolved_version with empty error message.
	svc.pollScheduleOnce(ctx, sc)
	got, err := svc.GetSchedule(ctx)
	if err != nil || got == nil {
		t.Fatalf("GetSchedule: %v", err)
	}
	if got.Status != SchedWaiting || got.ResolvedVersion != "v1.0.0" || got.Message != "" {
		t.Fatalf("expected waiting with resolved_version=v1.0.0 and empty message, got %+v", got)
	}

	// Simulate deadline reached -> timed_out with latest timeout message, then clear back to idle.
	past := got.CreatedAt.Add(-time.Minute)
	got.DeadlineAt = past
	if err := db.PutSettingJSON(ctx, svc.DB.Writer, SettingSchedule, got, db.FormatTime(svc.DB.Now())); err != nil {
		t.Fatal(err)
	}
	svc.stepSchedule(ctx)
	timedOut, _ := svc.GetSchedule(ctx)
	if timedOut.Status != SchedTimedOut || timedOut.Message != "等待期内没有发布比当前更新的版本" {
		t.Fatalf("expected timed_out with latest message, got %+v", timedOut)
	}

	cleared, err := svc.CancelSchedule(ctx, audit.Actor{Name: "root"})
	if err != nil || cleared.Status != SchedIdle {
		t.Fatalf("expected CancelSchedule to clear finished schedule to idle, got %+v err=%v", cleared, err)
	}
}

func TestScheduledSpecificCurrentCompletesImmediately(t *testing.T) {
	ctx := context.Background()
	fs, pub, _ := newFakeReleaseServer(t)
	svc, _, _ := setupUpdateLayout(t, "v1.0.0", pub, fs.srv.URL)

	if _, err := svc.CreateSchedule(ctx, audit.Actor{Name: "root"}, ScheduleInput{
		TargetVersion: "v1.0.0", WaitSeconds: 60, IntervalSeconds: 5,
	}); err != nil {
		t.Fatal(err)
	}
	svc.stepSchedule(ctx)
	got, err := svc.GetSchedule(ctx)
	if err != nil || got.Status != SchedCompleted || got.ResolvedVersion != "v1.0.0" {
		t.Fatalf("expected completed immediately for satisfied target, got %+v err=%v", got, err)
	}
}
