package backup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/cron"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/migration"
	"nomad-deck/internal/vaultbackup"
)

// Service orchestrates control-plane disaster-recovery backups and offsite
// Raft snapshot archival.
type Service struct {
	DB        *db.DB
	Keys      *crypto.Keyring
	Audit     *audit.Recorder
	Migration *migration.Service
	Drivers   map[string]cluster.Driver
	DataDir   string
	Log       *slog.Logger

	mu sync.Mutex
}

// TargetResult records the outcome of uploading and verifying on one target.
type TargetResult struct {
	TargetID   string `json:"target_id"`
	TargetName string `json:"target_name"`
	TargetType string `json:"target_type"`
	Object     string `json:"object,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	Verified   bool   `json:"verified"`
	Rotated    int    `json:"rotated,omitempty"`
	Error      string `json:"error,omitempty"`
}

// RunView is the API representation of a backup_runs record.
type RunView struct {
	ID           string         `json:"id"`
	Kind         string         `json:"kind"`
	ClusterID    string         `json:"cluster_id,omitempty"`
	ClusterName  string         `json:"cluster_name,omitempty"`
	SnapshotID   string         `json:"snapshot_id,omitempty"`
	TriggerType  string         `json:"trigger_type"`
	TriggeredBy  string         `json:"triggered_by"`
	Status       string         `json:"status"`
	SizeBytes    int64          `json:"size_bytes"`
	SHA256       string         `json:"sha256"`
	ObjectName   string         `json:"object_name"`
	Targets      []TargetResult `json:"targets"`
	ErrorMessage string         `json:"error_message,omitempty"`
	StartedAt    time.Time      `json:"started_at"`
	FinishedAt   *time.Time     `json:"finished_at,omitempty"`
}

// AlertSummary summarizes backup health for the dashboard.
type AlertSummary struct {
	Enabled              bool     `json:"enabled"`
	PassphraseSet        bool     `json:"passphrase_set"`
	TotalTargets         int      `json:"total_targets"`
	OffsiteTargets       int      `json:"offsite_targets"`
	MissingOffsiteTarget bool     `json:"missing_offsite_target"`
	ConsecutiveFailures  int      `json:"consecutive_failures"`
	LastRun              *RunView `json:"last_run,omitempty"`
}

// TestTarget tests connectivity and read-back verification for a target input.
func (s *Service) TestTarget(ctx context.Context, actor audit.Actor, ti TargetInput) (*TestResult, error) {
	existing, err := s.loadConfig(ctx)
	if err != nil {
		return nil, err
	}
	prevByID := map[string]Target{}
	for _, t := range existing.Targets {
		prevByID[t.ID] = t
	}
	t, err := s.resolveTargetInput(ctx, ti, prevByID)
	if err != nil {
		return nil, err
	}
	st, err := s.newStore(t)
	if err != nil {
		return nil, err
	}
	tctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	res, testErr := st.Test(tctx)
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "backup.target_test", ResourceType: "settings", ResourceName: t.Name,
		Summary: map[string]any{"type": t.Type, "target": res.Target, "ok": res.OK}, Err: testErr,
	})
	return res, nil
}

// CronBackup is the cron handler for control_plane_backup.
func (s *Service) CronBackup(ctx context.Context, r *cron.Run) (string, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return "", err
	}
	var targets []Target
	for _, t := range cfg.Targets {
		if t.Enabled {
			targets = append(targets, t)
		}
	}
	if len(targets) == 0 {
		return "", cron.Skip("尚未配置可用的 SafeKeep 灾备目标")
	}
	rv, err := s.runBackupForTargets(ctx, cfg, targets, "scheduled", audit.ActorCron.Name, r)
	if rv != nil && rv.Status == "success" {
		return fmt.Sprintf("灾备包 %s（%d 字节）已写入 %d 个目标并校验通过", rv.ObjectName, rv.SizeBytes, len(rv.Targets)), nil
	}
	if err != nil {
		return "部分或全部目标备份失败", err
	}
	return "", nil
}

// RunManual triggers a manual control-plane disaster-recovery backup.
func (s *Service) RunManual(ctx context.Context, actor audit.Actor) (*RunView, error) {
	rv, err := s.runBackup(ctx, "manual", actor.Name, nil)
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "backup.run", ResourceType: "control_plane",
		Summary: map[string]any{"run_id": idOf(rv), "object": objOf(rv), "size_bytes": sizeOf(rv)}, Err: err,
	})
	return rv, err
}

func idOf(rv *RunView) string {
	if rv == nil {
		return ""
	}
	return rv.ID
}
func objOf(rv *RunView) string {
	if rv == nil {
		return ""
	}
	return rv.ObjectName
}
func sizeOf(rv *RunView) int64 {
	if rv == nil {
		return 0
	}
	return rv.SizeBytes
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func (s *Service) runBackup(ctx context.Context, trigger, triggeredBy string, cr *cron.Run) (*RunView, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, err
	}
	var enabledTargets []Target
	for _, t := range cfg.Targets {
		if t.Enabled {
			enabledTargets = append(enabledTargets, t)
		}
	}
	return s.runBackupForTargets(ctx, cfg, enabledTargets, trigger, triggeredBy, cr)
}

func (s *Service) runBackupForTargets(ctx context.Context, cfg *storedConfig, targets []Target, trigger, triggeredBy string, cr *cron.Run) (*RunView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if cfg.Passphrase != "" && len(cfg.Passphrase) < vaultbackup.MinPassphrase {
		return nil, badRequest("备份口令至少 %d 个字符", vaultbackup.MinPassphrase)
	}
	if len(targets) == 0 {
		return nil, badRequest("未配置可用的备份目标")
	}

	tmpDir := filepath.Join(s.DataDir, "tmp", "backups")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, err
	}
	runID := db.NewID()
	now := s.DB.Now()
	objName := fmt.Sprintf("nomad-deck-backup-%s-%s.ndbundle", now.UTC().Format("20060102T150405Z"), runID)
	run := &db.BackupRun{
		ID: runID, Kind: "control_plane", TriggerType: trigger, TriggeredBy: triggeredBy,
		Status: "running", ObjectName: objName, StartedAt: now,
	}
	if err := db.InsertBackupRun(ctx, s.DB.Writer, run); err != nil {
		return nil, err
	}

	tmpPath := filepath.Join(tmpDir, runID+".ndbundle")
	defer os.Remove(tmpPath)

	include := append([]string{"admins"}, cfg.IncludeHistory...)
	offsite := s.loadOffsiteSnapshots(ctx)

	var sizeBytes int64
	var sha string
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err == nil {
		cw := &countingWriter{w: f}
		hw := sha256.New()
		mw := io.MultiWriter(cw, hw)
		_, exportErr := s.Migration.Export(ctx, migration.ExportOptions{
			Kind:       migration.KindBackup,
			Include:    include,
			Passphrase: cfg.Passphrase,
			CreatedBy:  triggeredBy,
			Offsite:    offsite,
		}, mw)
		syncErr := f.Sync()
		closeErr := f.Close()
		err = errors.Join(exportErr, syncErr, closeErr)
		sizeBytes = cw.n
		sha = hex.EncodeToString(hw.Sum(nil))
	}
	if err != nil {
		_ = db.FinishBackupRun(ctx, s.DB.Writer, runID, "failed", 0, "", objName, "[]", err.Error(), s.DB.Now())
		return toRunView(&db.BackupRun{ID: runID, Kind: "control_plane", TriggerType: trigger, TriggeredBy: triggeredBy,
			Status: "failed", ObjectName: objName, ErrorMessage: err.Error(), StartedAt: now}), err
	}

	results, uploadErr := s.uploadToTargets(ctx, targets, "control-plane", "nomad-deck-backup-", objName, tmpPath, sha, sizeBytes, false, cr)
	rj, _ := json.Marshal(results)
	status := "success"
	errMsg := ""
	if uploadErr != nil {
		status = "failed"
		errMsg = uploadErr.Error()
	}
	fin := s.DB.Now()
	_ = db.FinishBackupRun(ctx, s.DB.Writer, runID, status, sizeBytes, sha, objName, string(rj), errMsg, fin)
	rv := &RunView{
		ID: runID, Kind: "control_plane", TriggerType: trigger, TriggeredBy: triggeredBy,
		Status: status, SizeBytes: sizeBytes, SHA256: sha, ObjectName: objName,
		Targets: results, ErrorMessage: errMsg, StartedAt: now, FinishedAt: &fin,
	}
	return rv, uploadErr
}

// OffsiteSnapshot exports a portable archive of snap and uploads, verifies
// and rotates it across all enabled backup targets.
func (s *Service) OffsiteSnapshot(ctx context.Context, r *cron.Run, snap *db.Snapshot, clusterName string) error {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return err
	}
	var enabledTargets []Target
	for _, t := range cfg.Targets {
		if t.Enabled {
			enabledTargets = append(enabledTargets, t)
		}
	}
	if len(enabledTargets) == 0 {
		return nil
	}
	return s.offsiteToTargets(ctx, cfg, enabledTargets, r, snap, clusterName)
}

func (s *Service) offsiteToTargets(ctx context.Context, cfg *storedConfig, targets []Target, r *cron.Run, snap *db.Snapshot, clusterName string) error {
	drv := s.Drivers[snap.ClusterType]
	if drv == nil {
		return fmt.Errorf("未注册集群驱动 %s", snap.ClusterType)
	}

	tmpDir := filepath.Join(s.DataDir, "tmp", "backups")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return err
	}
	runID := db.NewID()
	now := s.DB.Now()
	objName := fmt.Sprintf("snapshot-%s-%s-%s.ndsnap", snap.ClusterID, snap.CreatedAt.UTC().Format("20060102T150405Z"), snap.ID)
	run := &db.BackupRun{
		ID: runID, Kind: "raft_snapshot", ClusterID: snap.ClusterID, ClusterName: clusterName,
		SnapshotID: snap.ID, TriggerType: "scheduled", TriggeredBy: audit.ActorCron.Name,
		Status: "running", ObjectName: objName, StartedAt: now,
	}
	if err := db.InsertBackupRun(ctx, s.DB.Writer, run); err != nil {
		return err
	}

	tmpPath := filepath.Join(tmpDir, runID+".ndsnap")
	defer os.Remove(tmpPath)

	var sizeBytes int64
	var sha string
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err == nil {
		cw := &countingWriter{w: f}
		hw := sha256.New()
		mw := io.MultiWriter(cw, hw)
		werr := drv.WriteArchive(ctx, audit.ActorCron, snap.ClusterID, snap.ID, cfg.Passphrase, mw)
		serr := f.Sync()
		cerr := f.Close()
		err = errors.Join(werr, serr, cerr)
		sizeBytes = cw.n
		sha = hex.EncodeToString(hw.Sum(nil))
	}
	if err != nil {
		_ = db.FinishBackupRun(ctx, s.DB.Writer, runID, "failed", 0, "", objName, "[]", err.Error(), s.DB.Now())
		return err
	}

	subdir := "snapshots/" + snap.ClusterID
	prefix := "snapshot-" + snap.ClusterID + "-"
	results, uploadErr := s.uploadToTargets(ctx, targets, subdir, prefix, objName, tmpPath, sha, sizeBytes, true, r)
	rj, _ := json.Marshal(results)
	status := "success"
	errMsg := ""
	if uploadErr != nil {
		status = "failed"
		errMsg = uploadErr.Error()
	}
	_ = db.FinishBackupRun(ctx, s.DB.Writer, runID, status, sizeBytes, sha, objName, string(rj), errMsg, s.DB.Now())

	// Record latest verified offsite snapshot object for the next control-plane backup manifest.
	for _, res := range results {
		if res.Verified {
			s.recordOffsiteSnapshot(ctx, migration.OffsiteSnapshot{
				ClusterID:   snap.ClusterID,
				ClusterName: clusterName,
				SnapshotID:  snap.ID,
				Object:      res.Object,
				CreatedAt:   snap.CreatedAt,
			})
			break
		}
	}
	return uploadErr
}

func (s *Service) uploadToTargets(ctx context.Context, targets []Target, subdir, rotPrefix, name, localPath, sha string, size int64, isSnap bool, cr *cron.Run) ([]TargetResult, error) {
	results := make([]TargetResult, 0, len(targets))
	var errs []error
	for _, t := range targets {
		tr := TargetResult{TargetID: t.ID, TargetName: t.Name, TargetType: t.Type}
		st, err := s.newStore(t)
		if err != nil {
			tr.Error = err.Error()
			errs = append(errs, fmt.Errorf("%s：%w", t.Name, err))
			results = append(results, tr)
			continue
		}
		obj, err := st.PutAndVerify(ctx, subdir, name, localPath, sha, size)
		if err != nil {
			tr.Error = err.Error()
			errs = append(errs, fmt.Errorf("%s：%w", t.Name, err))
			if cr != nil {
				cr.Logf("目标 %s 写入或回读校验失败：%v", t.Name, err)
			}
			results = append(results, tr)
			continue
		}
		tr.Object = obj
		tr.SHA256 = sha
		tr.Verified = true
		keep := t.RetentionCount
		if isSnap {
			keep = t.SnapshotRetentionCount
		}
		deleted, rerr := st.Rotate(ctx, subdir, rotPrefix, keep)
		tr.Rotated = deleted
		if rerr != nil {
			tr.Error = "轮转失败：" + rerr.Error()
			errs = append(errs, fmt.Errorf("%s 轮转失败：%w", t.Name, rerr))
		}
		if cr != nil {
			cr.Logf("目标 %s 写入并校验通过（%s，清理过期 %d 份）", t.Name, obj, deleted)
		}
		results = append(results, tr)
	}
	return results, errors.Join(errs...)
}

func (s *Service) loadOffsiteSnapshots(ctx context.Context) []migration.OffsiteSnapshot {
	m := map[string]migration.OffsiteSnapshot{}
	_ = db.GetSettingJSON(ctx, s.DB.Reader, SettingOffsiteSnapshots, &m)
	out := make([]migration.OffsiteSnapshot, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ClusterID < out[j].ClusterID })
	return out
}

func (s *Service) recordOffsiteSnapshot(ctx context.Context, snap migration.OffsiteSnapshot) {
	_ = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		m := map[string]migration.OffsiteSnapshot{}
		_ = db.GetSettingJSON(ctx, tx, SettingOffsiteSnapshots, &m)
		m[snap.ClusterID] = snap
		return db.PutSettingJSON(ctx, tx, SettingOffsiteSnapshots, m, s.DB.NowString())
	})
}

// ListHistory lists recent backup runs.
func (s *Service) ListHistory(ctx context.Context, kind string, limit int) ([]RunView, error) {
	runs, err := db.ListBackupRuns(ctx, s.DB.Reader, kind, limit)
	if err != nil {
		return nil, err
	}
	out := make([]RunView, 0, len(runs))
	for _, r := range runs {
		out = append(out, *toRunView(r))
	}
	return out, nil
}

func toRunView(r *db.BackupRun) *RunView {
	var targets []TargetResult
	_ = json.Unmarshal([]byte(r.TargetsJSON), &targets)
	if targets == nil {
		targets = []TargetResult{}
	}
	v := &RunView{
		ID: r.ID, Kind: r.Kind, ClusterID: r.ClusterID, ClusterName: r.ClusterName,
		SnapshotID: r.SnapshotID, TriggerType: r.TriggerType, TriggeredBy: r.TriggeredBy,
		Status: r.Status, SizeBytes: r.SizeBytes, SHA256: r.SHA256, ObjectName: r.ObjectName,
		Targets: targets, ErrorMessage: r.ErrorMessage, StartedAt: r.StartedAt,
	}
	if !r.FinishedAt.IsZero() {
		fin := r.FinishedAt
		v.FinishedAt = &fin
	}
	return v
}

// ListTargetSnapshots lists portable Raft snapshot archives stored on targetID.
func (s *Service) ListTargetSnapshots(ctx context.Context, targetID string) ([]ObjectInfo, error) {
	t, err := s.findTarget(ctx, targetID)
	if err != nil {
		return nil, err
	}
	st, err := s.newStore(t)
	if err != nil {
		return nil, err
	}
	return st.List(ctx, "snapshots", "snapshot-")
}

// ImportSnapshotFromTarget downloads an offsite portable snapshot archive from
// targetID and imports it into clusterID.
func (s *Service) ImportSnapshotFromTarget(ctx context.Context, actor audit.Actor, targetID, object, clusterID, passphrase string) (*db.Snapshot, error) {
	t, err := s.findTarget(ctx, targetID)
	if err != nil {
		return nil, err
	}
	if passphrase == "" {
		cfg, err := s.loadConfig(ctx)
		if err != nil {
			return nil, err
		}
		passphrase = cfg.Passphrase
	}
	cl, err := db.GetCluster(ctx, s.DB.Reader, clusterID)
	if errors.Is(err, db.ErrNotFound) {
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: "集群不存在"}
	}
	if err != nil {
		return nil, err
	}
	drv := s.Drivers[cl.Type]
	if drv == nil {
		return nil, badRequest("不支持的集群类型：%s", cl.Type)
	}
	st, err := s.newStore(t)
	if err != nil {
		return nil, err
	}
	rc, err := st.Open(ctx, object)
	if err != nil {
		return nil, fmt.Errorf("打开异地快照失败：%w", err)
	}
	return drv.ImportArchive(ctx, actor, clusterID, rc, passphrase)
}

func (s *Service) findTarget(ctx context.Context, targetID string) (Target, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return Target{}, err
	}
	for _, t := range cfg.Targets {
		if t.ID == targetID {
			return t, nil
		}
	}
	return Target{}, &auth.Error{Status: 404, Code: "not_found", Message: "备份目标不存在"}
}

// ValidateTarget verifies that targetID exists in the backup configuration.
func (s *Service) ValidateTarget(ctx context.Context, targetID string) error {
	_, err := s.findTarget(ctx, targetID)
	return err
}

// RevealSecret returns a stored backup secret (passphrase or target secret) for
// an authenticated admin UI reveal request, recording an audit event.
func (s *Service) RevealSecret(ctx context.Context, actor audit.Actor, kind, targetID string) (string, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return "", err
	}
	var secret string
	switch kind {
	case "passphrase":
		secret = cfg.Passphrase
	case "target_secret":
		if targetID == "" {
			return "", badRequest("target_id 必填")
		}
		found := false
		for _, t := range cfg.Targets {
			if t.ID == targetID {
				found = true
				if t.Type != TargetSafeKeep {
					return "", badRequest("该备份目标类型不含密钥字段")
				}
				secret = t.SafeKeepAPIKey
				break
			}
		}
		if !found {
			return "", &auth.Error{Status: 404, Code: "not_found", Message: "备份目标不存在"}
		}
	default:
		return "", badRequest("kind 需为 passphrase 或 target_secret")
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor:        actor,
		Action:       "backup.secret_reveal",
		ResourceType: "settings",
		ResourceName: "backup",
		Summary:      map[string]any{"kind": kind, "target_id": targetID},
	})
	return secret, nil
}

// CronBackupTarget runs a scheduled backup of the control plane (when clusterID
// is empty) or a cluster Raft snapshot to targetID (or all enabled safekeep
// targets when targetID is empty).
func (s *Service) CronBackupTarget(ctx context.Context, r *cron.Run, targetID, clusterID string) (string, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return "", err
	}
	if cfg.Passphrase != "" && len(cfg.Passphrase) < vaultbackup.MinPassphrase {
		return "", badRequest("备份口令至少 %d 个字符", vaultbackup.MinPassphrase)
	}
	var targets []Target
	if targetID != "" {
		t, err := s.findTarget(ctx, targetID)
		if err != nil {
			return "", err
		}
		targets = []Target{t}
	} else {
		for _, t := range cfg.Targets {
			if t.Enabled && t.Type == TargetSafeKeep {
				targets = append(targets, t)
			}
		}
	}
	if len(targets) == 0 {
		return "", cron.Skip("未配置可用的 SafeKeep 灾备目标")
	}
	if clusterID == "" {
		rv, err := s.runBackupForTargets(ctx, cfg, targets, "scheduled", audit.ActorCron.Name, r)
		if rv != nil && rv.Status == "success" {
			return fmt.Sprintf("灾备包 %s（%d 字节）已上传到 %s 并校验通过", rv.ObjectName, rv.SizeBytes, targets[0].Name), nil
		}
		if err != nil {
			return "上传灾备包失败", err
		}
		return "", nil
	}
	cl, err := db.GetCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return "", err
	}
	if cl.InitState != db.InitInitialized || cl.MaintenanceMode {
		return "", cron.Skip("集群 %s 未初始化或处于维护态", cl.Name)
	}
	drv := s.Drivers[cl.Type]
	if drv == nil {
		return "", fmt.Errorf("未注册集群驱动 %s", cl.Type)
	}
	snap, err := drv.TakeSnapshot(ctx, cl.ID, "scheduled", audit.ActorCron.Name)
	if err != nil {
		return "", err
	}
	if err := s.offsiteToTargets(ctx, cfg, targets, r, snap, cl.Name); err != nil {
		return "", err
	}
	return fmt.Sprintf("集群 %s 快照 %s 已加密并上传到 %s", cl.Name, snap.ID, targets[0].Name), nil
}

// AlertSummary returns backup status and alert indicators for the dashboard.
func (s *Service) AlertSummary(ctx context.Context) (*AlertSummary, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, err
	}
	offsite := 0
	for _, t := range cfg.Targets {
		if t.isOffsite() {
			offsite++
		}
	}
	fails, err := db.CountConsecutiveFailedBackups(ctx, s.DB.Reader, "control_plane")
	if err != nil {
		return nil, err
	}
	runs, err := db.ListBackupRuns(ctx, s.DB.Reader, "control_plane", 1)
	if err != nil {
		return nil, err
	}
	sum := &AlertSummary{
		Enabled:              cfg.Enabled,
		PassphraseSet:        cfg.Passphrase != "",
		TotalTargets:         len(cfg.Targets),
		OffsiteTargets:       offsite,
		MissingOffsiteTarget: offsite == 0,
		ConsecutiveFailures:  fails,
	}
	if len(runs) > 0 {
		sum.LastRun = toRunView(runs[0])
	}
	return sum, nil
}
