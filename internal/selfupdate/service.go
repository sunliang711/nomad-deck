// Package selfupdate implements NomadDeck control-plane self-update, release
// signature verification, upgrade barriers, scheduled upgrades, and rollback.
package selfupdate

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/version"
)

// Upgrade states persisted in self_update.last_result.
const (
	StatePrepared   = "prepared"
	StatePending    = "pending"
	StateSucceeded  = "succeeded"
	StateFailed     = "failed"
	StateRolledBack = "rolled_back"
	StateAnomaly    = "anomaly"
)

// UpdateResult is persisted in system_settings under self_update.last_result.
type UpdateResult struct {
	State          string     `json:"state"`
	FromVersion    string     `json:"from_version"`
	ToVersion      string     `json:"to_version"`
	TaskID         string     `json:"task_id,omitempty"`
	BackupFile     string     `json:"backup_file,omitempty"`
	FromSchema     int        `json:"from_schema"`
	PrevBinary     string     `json:"prev_binary,omitempty"`
	TargetBinary   string     `json:"target_binary,omitempty"`
	RollbackCount  int        `json:"rollback_count"`
	ManualRollback bool       `json:"manual_rollback,omitempty"`
	UseProxy       bool       `json:"use_proxy,omitempty"`
	ErrorMessage   string     `json:"error_message,omitempty"`
	StartedAt      time.Time  `json:"started_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	FinishedAt     *time.Time `json:"finished_at,omitempty"`
}

// Service manages control-plane self-update, scheduled upgrades and manual rollback.
type Service struct {
	DB                 *db.DB
	Audit              *audit.Recorder
	Ops                *ops.Engine
	Proxy              *netx.Manager
	DataDir            string
	BinDir             string
	CurrentVersion     string
	Repo               string
	APIBase            string
	PublicKey          ed25519.PublicKey
	GOOS               string
	GOARCH             string
	CronIdle           func(ctx context.Context) error
	CronResume         func(ctx context.Context)
	ExtraBusy          func() bool
	BarrierWaitTimeout time.Duration
	OnRestart          func(exitCode int)
	ContainerCheck     func() bool
	VerifyBinary       func(ctx context.Context, binPath, wantVer string) error
	Log                *slog.Logger

	mu        sync.Mutex
	updating  atomic.Bool
	schedWake chan struct{}
}

// VersionView is returned by GET /api/v1/system/version.
type VersionView struct {
	CurrentVersion    string          `json:"current_version"`
	Commit            string          `json:"commit,omitempty"`
	Channel           string          `json:"channel"`
	Available         bool            `json:"available"`
	UnavailableReason string          `json:"unavailable_reason,omitempty"`
	Latest            *ReleaseSummary `json:"latest,omitempty"`
	UpdateAvailable   bool            `json:"update_available"`
	LastResult        *UpdateResult   `json:"last_result,omitempty"`
	ManualRollback    *RollbackInfo   `json:"manual_rollback,omitempty"`
}

// RollbackInfo describes manual rollback readiness.
type RollbackInfo struct {
	Available       bool   `json:"available"`
	TargetVersion   string `json:"target_version,omitempty"`
	SchemaMatches   bool   `json:"schema_matches"`
	BackupFile      string `json:"backup_file,omitempty"`
	UnavailableNote string `json:"unavailable_note,omitempty"`
}

func (s *Service) defaults() {
	if s.CurrentVersion == "" {
		s.CurrentVersion = version.Version
	}
	if s.Repo == "" {
		s.Repo = version.Repo
	}
	if s.APIBase == "" {
		s.APIBase = "https://api.github.com"
	}
	if s.PublicKey == nil && version.ReleasePublicKey != "" {
		if pk, err := ParsePublicKey(version.ReleasePublicKey); err == nil {
			s.PublicKey = pk
		}
	}
	if s.GOOS == "" {
		s.GOOS = runtime.GOOS
	}
	if s.GOARCH == "" {
		s.GOARCH = runtime.GOARCH
	}
	if s.BinDir == "" {
		s.BinDir = ResolveBinDir()
	}
	if s.BarrierWaitTimeout == 0 {
		s.BarrierWaitTimeout = 10 * time.Minute
	}
	if s.ContainerCheck == nil {
		s.ContainerCheck = detectContainer
	}
	if s.VerifyBinary == nil {
		s.VerifyBinary = defaultVerifyBinary
	}
}

// ResolveBinDir determines the control plane bin directory containing the
// nomad-deck / nomad-deck.prev symlinks without dereferencing Linux /proc/self/exe
// symlinks into versions/.
func ResolveBinDir() string {
	if len(os.Args) > 0 && os.Args[0] != "" && filepath.Base(os.Args[0]) != os.Args[0] {
		if abs, err := filepath.Abs(os.Args[0]); err == nil {
			dir := filepath.Dir(abs)
			if isControlBinDir(dir) {
				return dir
			}
		}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(dir) == "versions" {
			parent := filepath.Dir(dir)
			if isControlBinDir(parent) {
				return parent
			}
		}
		return dir
	}
	return ""
}

func isControlBinDir(dir string) bool {
	if _, err := os.Lstat(filepath.Join(dir, "nomad-deck")); err == nil {
		return true
	}
	if _, err := os.Lstat(filepath.Join(dir, "nomad-deck.prev")); err == nil {
		return true
	}
	return false
}

func detectContainer() bool {
	if os.Getenv("NOMAD_DECK_CONTAINER") == "1" {
		return true
	}
	for _, p := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	if b, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		txt := string(b)
		if strings.Contains(txt, "docker") || strings.Contains(txt, "containerd") || strings.Contains(txt, "kubepods") {
			return true
		}
	}
	return false
}

// Availability reports whether in-place self-update is permitted on this host.
func (s *Service) Availability() (bool, string) {
	s.defaults()
	if s.ContainerCheck() {
		return false, "容器部署模式禁用自更新，请通过更新容器镜像升级"
	}
	if _, err := ParseSemver(s.CurrentVersion); err != nil {
		return false, "开发模式（非正式构建版本）禁用自更新"
	}
	if len(s.PublicKey) != ed25519.PublicKeySize {
		return false, "当前构建未内置发布验签公钥，无法执行自更新"
	}
	if s.BinDir == "" {
		return false, "无法确定控制面程序安装目录，禁用自更新"
	}
	linkPath := filepath.Join(s.BinDir, "nomad-deck")
	if _, err := os.Lstat(linkPath); err != nil {
		return false, "当前部署目录结构不支持原地自更新（缺少 bin/nomad-deck）"
	}
	tf, err := os.CreateTemp(s.BinDir, ".nd-rw-*")
	if err != nil {
		return false, "程序安装目录不可写，无法执行自更新"
	}
	_ = tf.Close()
	_ = os.Remove(tf.Name())
	return true, ""
}

func (s *Service) channel(ctx context.Context) string {
	var ch string
	if db.GetSettingJSON(ctx, s.DB.Reader, SettingChannel, &ch) == nil && ch == ChannelPrerelease {
		return ChannelPrerelease
	}
	return ChannelStable
}

func (s *Service) resolveUseProxy(ctx context.Context, useProxy *bool) (bool, error) {
	u := s.Proxy.UseByDefault(ctx, netx.SettingUseForSelfUpdate)
	if useProxy != nil {
		u = *useProxy
	}
	if u {
		cfg, _, err := s.Proxy.Load(ctx)
		if err != nil {
			return false, err
		}
		if cfg == nil {
			return false, &auth.Error{Status: 400, Code: "proxy_not_configured", Message: "尚未配置系统代理"}
		}
	}
	return u, nil
}

// CachedLatest returns the last cached release summary from system_settings.
func (s *Service) CachedLatest(ctx context.Context) *ReleaseSummary {
	var sum ReleaseSummary
	if err := db.GetSettingJSON(ctx, s.DB.Reader, SettingLatestCache, &sum); err != nil || sum.Version == "" {
		return nil
	}
	return &sum
}

func (s *Service) checkLatest(ctx context.Context, useProxy bool) (*ReleaseInfo, error) {
	s.defaults()
	client, _, err := s.Proxy.Client(ctx, useProxy, 30*time.Second)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		return nil, &auth.Error{Status: 400, Code: "proxy_not_configured", Message: "尚未配置系统代理"}
	}
	if err != nil {
		return nil, err
	}
	rels, err := FetchReleases(ctx, client, s.APIBase, s.Repo)
	if err != nil {
		return nil, err
	}
	rel, err := ResolveRelease(rels, "latest", s.channel(ctx), s.GOOS, s.GOARCH)
	if err != nil {
		return nil, err
	}
	_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingLatestCache, rel.ReleaseSummary, s.DB.NowString())
	return rel, nil
}

// CronCheck is the built-in self_update_check cron job handler.
func (s *Service) CronCheck(ctx context.Context) (string, error) {
	s.defaults()
	useProxy := s.Proxy.UseByDefault(ctx, netx.SettingUseForSelfUpdate)
	rel, err := s.checkLatest(ctx, useProxy)
	if err != nil {
		return "", err
	}
	if cmp, err := CompareSemver(rel.Version, s.CurrentVersion); err == nil && cmp > 0 {
		return fmt.Sprintf("发现新版本 %s（当前 %s）", rel.Version, s.CurrentVersion), nil
	}
	return fmt.Sprintf("当前版本 %s 已是最新", s.CurrentVersion), nil
}

// LastResult returns the persisted self_update.last_result, if any.
func (s *Service) LastResult(ctx context.Context) (*UpdateResult, error) {
	var res UpdateResult
	err := db.GetSettingJSON(ctx, s.DB.Reader, SettingLastResult, &res)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// VersionInfo returns current version, availability, latest release and rollback readiness.
func (s *Service) VersionInfo(ctx context.Context, refresh bool, useProxy *bool) (*VersionView, error) {
	s.defaults()
	avail, reason := s.Availability()
	v := &VersionView{
		CurrentVersion:    s.CurrentVersion,
		Commit:            version.Commit,
		Channel:           s.channel(ctx),
		Available:         avail,
		UnavailableReason: reason,
	}
	if refresh {
		up, err := s.resolveUseProxy(ctx, useProxy)
		if err != nil {
			return nil, err
		}
		rel, err := s.checkLatest(ctx, up)
		if err != nil {
			return nil, &auth.Error{Status: 502, Code: "release_fetch_failed", Message: "获取最新版本失败：" + err.Error()}
		}
		v.Latest = &rel.ReleaseSummary
	} else {
		v.Latest = s.CachedLatest(ctx)
	}
	if v.Latest != nil {
		if cmp, err := CompareSemver(v.Latest.Version, s.CurrentVersion); err == nil && cmp > 0 {
			v.UpdateAvailable = true
		}
	}
	res, err := s.LastResult(ctx)
	if err != nil {
		return nil, err
	}
	v.LastResult = res
	v.ManualRollback = s.rollbackInfo(ctx, avail, res)
	return v, nil
}

func (s *Service) rollbackInfo(ctx context.Context, avail bool, res *UpdateResult) *RollbackInfo {
	if !avail || res == nil || res.State != StateSucceeded || res.ManualRollback {
		return &RollbackInfo{Available: false, UnavailableNote: "没有可回退的已确认升级记录"}
	}
	prev := s.resolvePrevBinary(res)
	if prev == "" {
		return &RollbackInfo{Available: false, UnavailableNote: "上一版本程序文件不存在"}
	}
	curSchema, err := s.DB.SchemaVersion(ctx)
	if err != nil {
		return &RollbackInfo{Available: false, UnavailableNote: err.Error()}
	}
	sameSchema := res.FromSchema == curSchema
	note := ""
	if !sameSchema {
		note = fmt.Sprintf("数据库 Schema 版本已变更（原 %d -> 当前 %d），界面禁止在线回退，请在本机执行：nomad-deck rollback --to-backup %s",
			res.FromSchema, curSchema, res.BackupFile)
	}
	return &RollbackInfo{
		Available:       sameSchema,
		TargetVersion:   res.FromVersion,
		SchemaMatches:   sameSchema,
		BackupFile:      res.BackupFile,
		UnavailableNote: note,
	}
}

// StartUpgrade initiates an immediate self-update to targetVersion ("latest" or explicit tag).
// Release discovery runs asynchronously inside the submitted task so the UI receives task metadata immediately.
func (s *Service) StartUpgrade(ctx context.Context, actor audit.Actor, targetVersion string, useProxy *bool) (*db.OperationTask, error) {
	s.defaults()
	if avail, reason := s.Availability(); !avail {
		return nil, &auth.Error{Status: 409, Code: "self_update_unavailable", Message: reason}
	}
	if s.updating.Load() {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "控制面升级正在进行中"}
	}
	if sched, err := s.GetSchedule(ctx); err == nil && sched != nil && sched.Status == SchedWaiting {
		return nil, &auth.Error{Status: 409, Code: "schedule_active", Message: "当前存在等待中的预约升级，请先取消后再发起立即升级"}
	}
	up, err := s.resolveUseProxy(ctx, useProxy)
	if err != nil {
		return nil, err
	}
	target := strings.TrimSpace(targetVersion)
	if target == "" {
		target = "latest"
	}
	if target != "latest" {
		if _, err := ParseSemver(target); err != nil {
			return nil, &auth.Error{Status: 400, Code: "invalid_argument", Message: "目标版本号不合法：" + target}
		}
		target = NormalizeTag(target)
	}
	return s.startUpgradeAsync(ctx, actor, target, up, "")
}

func (s *Service) startUpgradeAsync(ctx context.Context, actor audit.Actor, targetVersion string, useProxy bool, scheduleID string) (*db.OperationTask, error) {
	client, _, err := s.Proxy.Client(ctx, useProxy, 5*time.Minute)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		return nil, &auth.Error{Status: 400, Code: "proxy_not_configured", Message: "尚未配置系统代理"}
	}
	if err != nil {
		return nil, err
	}
	if !s.updating.CompareAndSwap(false, true) {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "控制面升级正在进行中"}
	}

	task, err := s.Ops.Submit(ctx, ops.Spec{
		Action:      "system.self_update",
		TargetType:  "control_plane",
		TargetID:    "self",
		TriggeredBy: actor.Name,
		Params: map[string]any{
			"from_version": s.CurrentVersion,
			"to_version":   targetVersion,
			"use_proxy":    useProxy,
			"schedule_id":  scheduleID,
		},
		Run: func(rctx context.Context, t *ops.Task) error {
			return s.runUpgradeTask(rctx, actor, t, nil, targetVersion, client, useProxy)
		},
	})
	if err != nil {
		s.updating.Store(false)
		return nil, err
	}
	return task, nil
}

func (s *Service) startUpgradeWithRelease(ctx context.Context, actor audit.Actor, rel *ReleaseInfo, useProxy bool, scheduleID string) (*db.OperationTask, error) {
	client, _, err := s.Proxy.Client(ctx, useProxy, 5*time.Minute)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		return nil, &auth.Error{Status: 400, Code: "proxy_not_configured", Message: "尚未配置系统代理"}
	}
	if err != nil {
		return nil, err
	}
	if !rel.AssetsComplete {
		return nil, &auth.Error{Status: 400, Code: "incomplete_release", Message: "目标版本缺少当前平台程序包或签名摘要文件"}
	}
	cmp, err := CompareSemver(rel.Version, s.CurrentVersion)
	if err != nil {
		return nil, &auth.Error{Status: 409, Code: "self_update_unavailable", Message: err.Error()}
	}
	if cmp <= 0 {
		return nil, &auth.Error{Status: 400, Code: "version_not_higher", Message: fmt.Sprintf("目标版本 %s 必须高于当前版本 %s（回退请使用版本回退功能）", rel.Version, s.CurrentVersion)}
	}
	if !s.updating.CompareAndSwap(false, true) {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "控制面升级正在进行中"}
	}

	task, err := s.Ops.Submit(ctx, ops.Spec{
		Action:      "system.self_update",
		TargetType:  "control_plane",
		TargetID:    "self",
		TriggeredBy: actor.Name,
		Params: map[string]any{
			"from_version": s.CurrentVersion,
			"to_version":   rel.Version,
			"use_proxy":    useProxy,
			"schedule_id":  scheduleID,
		},
		Run: func(rctx context.Context, t *ops.Task) error {
			return s.runUpgradeTask(rctx, actor, t, rel, rel.Version, client, useProxy)
		},
	})
	if err != nil {
		s.updating.Store(false)
		return nil, err
	}
	return task, nil
}

func (s *Service) runUpgradeTask(ctx context.Context, actor audit.Actor, t *ops.Task, rel *ReleaseInfo, targetVersion string, client *http.Client, useProxy bool) (retErr error) {
	keepUpdating := false
	defer func() {
		if !keepUpdating {
			s.updating.Store(false)
			if retErr != nil && !errors.Is(retErr, ops.ErrHandover) {
				s.markScheduleDone(context.Background(), t.ID, SchedFailed, retErr.Error())
			}
		}
	}()

	// Step 1: Enter upgrade barrier.
	st1, err := t.Step("进入升级屏障", "")
	if err != nil {
		return err
	}
	releaseBarrier, ok := s.Ops.TryAcquireBarrier("self_update")
	if !ok {
		err := ops.ErrBarrier
		st1.Finish(err, nil)
		return err
	}
	lowerBarrier := true
	defer func() {
		if lowerBarrier {
			releaseBarrier()
			if s.CronResume != nil {
				s.CronResume(context.Background())
			}
		}
	}()

	if err := s.waitForIdle(ctx, t.ID); err != nil {
		st1.Finish(err, nil)
		return err
	}
	st1.Logf("升级屏障已就绪，无并发运维或定时任务运行")
	st1.Finish(nil, nil)

	// Step 2: Resolve release if not pre-resolved.
	if rel == nil {
		stResolve, err := t.Step("查询目标版本", "")
		if err != nil {
			return err
		}
		t.EmitProgress("resolve", 0, 0)
		rels, err := FetchReleases(ctx, client, s.APIBase, s.Repo)
		if err != nil {
			stResolve.Finish(err, nil)
			return fmt.Errorf("查询 Release 失败：%w", err)
		}
		resolved, err := ResolveRelease(rels, targetVersion, s.channel(ctx), s.GOOS, s.GOARCH)
		if err != nil {
			stResolve.Finish(err, nil)
			return err
		}
		if !resolved.AssetsComplete {
			err := errors.New("目标版本缺少当前平台程序包或签名摘要文件")
			stResolve.Finish(err, nil)
			return err
		}
		cmp, err := CompareSemver(resolved.Version, s.CurrentVersion)
		if err != nil {
			stResolve.Finish(err, nil)
			return err
		}
		if cmp <= 0 {
			err := fmt.Errorf("目标版本 %s 必须高于当前版本 %s（回退请使用版本回退功能）", resolved.Version, s.CurrentVersion)
			stResolve.Finish(err, nil)
			return err
		}
		rel = resolved
		stResolve.Logf("已确认目标版本 %s（%s）", rel.Version, rel.ArchiveName)
		stResolve.Finish(nil, nil)
	}

	// Step 3: Download, verify Ed25519 signature + SHA-256, extract, dry-run version.
	st2, err := t.Step("下载并校验新版本", "")
	if err != nil {
		return err
	}
	targetBin := filepath.Join(s.BinDir, "versions", "nomad-deck-"+strings.TrimPrefix(rel.Version, "v"))
	if err := VerifyAndExtractWithProgress(ctx, client, rel, s.PublicKey, targetBin, s.VerifyBinary, t.EmitProgress); err != nil {
		st2.Finish(err, nil)
		return err
	}
	st2.Logf("Ed25519 签名、SHA-256 摘要及试运行均已通过：%s", targetBin)
	st2.Finish(nil, nil)

	// Step 4: Online database backup before upgrade.
	st3, err := t.Step("升级前备份控制面数据库", "")
	if err != nil {
		return err
	}
	t.EmitProgress("install", 0, 0)
	fromSchema, err := s.DB.SchemaVersion(ctx)
	if err != nil {
		st3.Finish(err, nil)
		return err
	}
	backupFile, err := BackupDatabase(ctx, s.DB, s.DataDir, s.CurrentVersion, rel.Version)
	if err != nil {
		st3.Finish(err, nil)
		return err
	}
	st3.Logf("已生成升级前数据库备份：%s（Schema v%d）", filepath.Base(backupFile), fromSchema)
	st3.Finish(nil, nil)

	// Step 5: Persist prepared -> atomic symlink swap -> persist pending -> restart exit 75.
	st4, err := t.Step("切换版本并重启控制面", "")
	if err != nil {
		return err
	}
	t.EmitProgress("restart", 0, 0)
	prevBin, err := s.ensurePrevBinary()
	if err != nil {
		st4.Finish(err, nil)
		return err
	}
	now := s.DB.Now()
	res := UpdateResult{
		State:        StatePrepared,
		FromVersion:  s.CurrentVersion,
		ToVersion:    rel.Version,
		TaskID:       t.ID,
		BackupFile:   backupFile,
		FromSchema:   fromSchema,
		PrevBinary:   prevBin,
		TargetBinary: targetBin,
		UseProxy:     useProxy,
		StartedAt:    now,
		UpdatedAt:    now,
	}
	if err := db.PutSettingJSON(ctx, s.DB.Writer, SettingLastResult, res, db.FormatTime(now)); err != nil {
		st4.Finish(err, nil)
		return err
	}

	if err := s.swapSymlinks(prevBin, targetBin); err != nil {
		st4.Finish(err, nil)
		return err
	}
	res.State = StatePending
	res.UpdatedAt = s.DB.Now()
	if err := db.PutSettingJSON(ctx, s.DB.Writer, SettingLastResult, res, db.FormatTime(res.UpdatedAt)); err != nil {
		// Best effort restore of symlinks if DB write fails right after swap.
		_ = s.swapSymlink(filepath.Join(s.BinDir, "nomad-deck"), prevBin)
		st4.Finish(err, nil)
		return err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "system.self_update", ResourceType: "control_plane",
		OperationTaskID: t.ID,
		Summary: map[string]any{
			"from_version": s.CurrentVersion, "to_version": rel.Version, "use_proxy": useProxy,
		},
	})
	st4.Logf("版本软链已切换到 %s，控制面即将以退出码 75 重启", rel.Version)
	lowerBarrier = false
	keepUpdating = true
	if s.OnRestart != nil {
		go func() {
			time.Sleep(100 * time.Millisecond)
			s.OnRestart(version.ExitCodeRestart)
		}()
	}
	return ops.ErrHandover
}

func (s *Service) waitForIdle(ctx context.Context, selfTaskID string) error {
	deadline := time.Now().Add(s.BarrierWaitTimeout)
	for {
		active := s.Ops.Active()
		extra := s.ExtraBusy != nil && s.ExtraBusy()
		if active <= 1 && !extra {
			break
		}
		if time.Now().After(deadline) {
			if extra {
				return errors.New("等待主密钥轮换结束超时")
			}
			return fmt.Errorf("等待在途运维任务结束超时（仍有 %d 个任务）", active-1)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if s.CronIdle != nil {
		wctx, cancel := context.WithDeadline(ctx, deadline)
		defer cancel()
		if err := s.CronIdle(wctx); err != nil {
			return fmt.Errorf("等待定时任务结束失败：%w", err)
		}
	}
	_ = selfTaskID
	return nil
}

func (s *Service) ensurePrevBinary() (string, error) {
	link := filepath.Join(s.BinDir, "nomad-deck")
	fi, err := os.Lstat(link)
	if err == nil && fi.Mode()&os.ModeSymlink == 0 && fi.Mode().IsRegular() {
		dst := filepath.Join(s.BinDir, "versions", "nomad-deck-"+strings.TrimPrefix(s.CurrentVersion, "v"))
		if _, serr := os.Stat(dst); errors.Is(serr, os.ErrNotExist) {
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return "", fmt.Errorf("创建版本目录失败：%w", err)
			}
			if err := copyBinaryFile(link, dst); err != nil {
				return "", fmt.Errorf("归档当前版本二进制失败：%w", err)
			}
		}
		return filepath.Clean(dst), nil
	}
	return s.currentTargetBinary(), nil
}

func copyBinaryFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".nd-prev-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		_ = tmp.Close()
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func (s *Service) currentTargetBinary() string {
	link := filepath.Join(s.BinDir, "nomad-deck")
	if target, err := os.Readlink(link); err == nil {
		if !filepath.IsAbs(target) {
			target = filepath.Join(s.BinDir, target)
		}
		return filepath.Clean(target)
	}
	return filepath.Join(s.BinDir, "versions", "nomad-deck-"+strings.TrimPrefix(s.CurrentVersion, "v"))
}

func (s *Service) resolvePrevBinary(res *UpdateResult) string {
	if res != nil && res.PrevBinary != "" {
		if _, err := os.Stat(res.PrevBinary); err == nil {
			return res.PrevBinary
		}
	}
	prevLink := filepath.Join(s.BinDir, "nomad-deck.prev")
	if target, err := os.Readlink(prevLink); err == nil {
		if !filepath.IsAbs(target) {
			target = filepath.Join(s.BinDir, target)
		}
		target = filepath.Clean(target)
		if _, err := os.Stat(target); err == nil {
			return target
		}
	}
	return ""
}

func (s *Service) swapSymlink(linkPath, target string) error {
	if target == "" {
		return errors.New("目标二进制路径为空")
	}
	tmp, err := os.CreateTemp(filepath.Dir(linkPath), ".sym-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(tmpPath)
	if err := os.Symlink(target, tmpPath); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, linkPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func (s *Service) swapSymlinks(prevBin, targetBin string) error {
	if prevBin != "" {
		if err := s.swapSymlink(filepath.Join(s.BinDir, "nomad-deck.prev"), prevBin); err != nil {
			return err
		}
	}
	return s.swapSymlink(filepath.Join(s.BinDir, "nomad-deck"), targetBin)
}

// PrepareBarrierOnOpen re-raises the upgrade barrier during server.Open if an
// upgrade or anomaly is still unresolved from before restart.
func (s *Service) PrepareBarrierOnOpen(ctx context.Context) {
	res, err := s.LastResult(ctx)
	if err != nil || res == nil {
		return
	}
	switch res.State {
	case StatePrepared, StatePending:
		s.Ops.SetBarrier("self_update")
	case StateAnomaly:
		s.Ops.SetBarrier("self_update_anomaly")
	}
}

func sameVersion(a, b string) bool {
	cmp, err := CompareSemver(a, b)
	return err == nil && cmp == 0
}

// ConfirmOnStartup reconciles self_update.last_result once the restarted
// process is ready and serving requests.
func (s *Service) ConfirmOnStartup(ctx context.Context) {
	s.defaults()
	res, err := s.LastResult(ctx)
	if err != nil || res == nil {
		return
	}
	if res.State != StatePrepared && res.State != StatePending {
		return
	}
	now := s.DB.Now()

	switch {
	case sameVersion(s.CurrentVersion, res.ToVersion):
		res.State = StateSucceeded
		res.UpdatedAt = now
		res.FinishedAt = &now
		_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingLastResult, res, db.FormatTime(now))
		s.finalizeTask(ctx, res.TaskID, db.TaskSuccess, "", now)
		s.Ops.SetBarrier("")
		if s.CronResume != nil {
			s.CronResume(ctx)
		}
		keep := db.IntSetting(ctx, s.DB.Reader, SettingBackupRetention, defaultBackupRetention)
		PrunePreUpgradeBackups(s.DataDir, keep)
		s.pruneOldBinaries(res.TargetBinary, res.PrevBinary)
		s.markScheduleDone(ctx, res.TaskID, SchedCompleted, "")
		_ = s.Audit.Record(ctx, nil, audit.Event{
			Actor: audit.Actor{Name: "system"}, Action: "system.self_update_confirmed", ResourceType: "control_plane",
			OperationTaskID: res.TaskID,
			Summary:         map[string]any{"from_version": res.FromVersion, "to_version": res.ToVersion, "manual_rollback": res.ManualRollback},
		})

	case res.State == StatePrepared && sameVersion(s.CurrentVersion, res.FromVersion):
		// Power loss occurred after recording prepared, before switching symlink.
		res.State = StateFailed
		res.ErrorMessage = "切换前中断"
		res.UpdatedAt = now
		res.FinishedAt = &now
		_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingLastResult, res, db.FormatTime(now))
		if res.TargetBinary != "" && res.TargetBinary != res.PrevBinary {
			_ = os.Remove(res.TargetBinary)
		}
		s.finalizeTask(ctx, res.TaskID, db.TaskFailed, "切换前中断", now)
		s.Ops.SetBarrier("")
		if s.CronResume != nil {
			s.CronResume(ctx)
		}
		s.markScheduleDone(ctx, res.TaskID, SchedFailed, "切换前中断")

	default:
		res.State = StateAnomaly
		res.ErrorMessage = fmt.Sprintf("升级状态异常（状态=%s，期望版本=%s，当前运行版本=%s）", res.State, res.ToVersion, s.CurrentVersion)
		res.UpdatedAt = now
		_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingLastResult, res, db.FormatTime(now))
		s.Ops.SetBarrier("self_update_anomaly")
		s.finalizeTask(ctx, res.TaskID, db.TaskFailed, res.ErrorMessage, now)
	}
}

func (s *Service) finalizeTask(ctx context.Context, taskID, status, errMsg string, now time.Time) {
	if taskID == "" {
		return
	}
	_ = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.FinishTask(ctx, tx, taskID, status, errMsg, now); err != nil {
			return err
		}
		stepStatus := db.TaskSuccess
		if status != db.TaskSuccess {
			stepStatus = db.TaskFailed
		}
		_, err := tx.ExecContext(ctx, `UPDATE operation_task_steps SET status = ?, error_message = ?, finished_at = ? WHERE task_id = ? AND status = 'running'`,
			stepStatus, errMsg, db.FormatTime(now), taskID)
		return err
	})
}

func (s *Service) pruneOldBinaries(keepA, keepB string) {
	verDir := filepath.Join(s.BinDir, "versions")
	entries, err := os.ReadDir(verDir)
	if err != nil {
		return
	}
	keep := map[string]bool{}
	for _, p := range []string{keepA, keepB, s.currentTargetBinary()} {
		if p != "" {
			keep[filepath.Clean(p)] = true
		}
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		full := filepath.Clean(filepath.Join(verDir, e.Name()))
		if !keep[full] {
			_ = os.Remove(full)
		}
	}
}

// ManualRollback switches back to the previous version when schema version is unchanged.
func (s *Service) ManualRollback(ctx context.Context, actor audit.Actor) (*db.OperationTask, error) {
	s.defaults()
	if avail, reason := s.Availability(); !avail {
		return nil, &auth.Error{Status: 409, Code: "self_update_unavailable", Message: reason}
	}
	if s.updating.Load() {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "控制面升级或回退正在进行中"}
	}
	res, err := s.LastResult(ctx)
	if err != nil {
		return nil, err
	}
	if res == nil || res.State != StateSucceeded || res.ManualRollback {
		return nil, &auth.Error{Status: 409, Code: "no_rollback_target", Message: "没有可回退的已确认升级记录"}
	}
	prevBin := s.resolvePrevBinary(res)
	if prevBin == "" {
		return nil, &auth.Error{Status: 409, Code: "prev_binary_missing", Message: "上一版本程序文件不存在"}
	}
	curSchema, err := s.DB.SchemaVersion(ctx)
	if err != nil {
		return nil, err
	}
	if res.FromSchema != curSchema {
		return nil, &auth.Error{
			Status:  409,
			Code:    "schema_changed",
			Message: fmt.Sprintf("数据库 Schema 版本已变更（原 %d -> 当前 %d），请在本机执行：nomad-deck rollback --to-backup %s", res.FromSchema, curSchema, res.BackupFile),
		}
	}
	if !s.updating.CompareAndSwap(false, true) {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "控制面升级或回退正在进行中"}
	}
	targetVer := res.FromVersion
	task, err := s.Ops.Submit(ctx, ops.Spec{
		Action:      "system.self_update",
		TargetType:  "control_plane",
		TargetID:    "self",
		TriggeredBy: actor.Name,
		Params:      map[string]any{"rollback_to": targetVer},
		Run: func(rctx context.Context, t *ops.Task) error {
			keepUpdating := false
			defer func() {
				if !keepUpdating {
					s.updating.Store(false)
				}
			}()
			st1, err := t.Step("进入升级屏障", "")
			if err != nil {
				return err
			}
			releaseBarrier, ok := s.Ops.TryAcquireBarrier("self_update")
			if !ok {
				err := ops.ErrBarrier
				st1.Finish(err, nil)
				return err
			}
			lowerBarrier := true
			defer func() {
				if lowerBarrier {
					releaseBarrier()
					if s.CronResume != nil {
						s.CronResume(context.Background())
					}
				}
			}()
			if err := s.waitForIdle(rctx, t.ID); err != nil {
				st1.Finish(err, nil)
				return err
			}
			st1.Finish(nil, nil)

			st2, err := t.Step("回退版本软链并重启控制面", "")
			if err != nil {
				return err
			}
			curBin, err := s.ensurePrevBinary()
			if err != nil {
				st2.Finish(err, nil)
				return err
			}
			now := s.DB.Now()
			prevRes := *res
			nextRes := UpdateResult{
				State:          StatePrepared,
				FromVersion:    s.CurrentVersion,
				ToVersion:      targetVer,
				TaskID:         t.ID,
				FromSchema:     curSchema,
				PrevBinary:     curBin,
				TargetBinary:   prevBin,
				ManualRollback: true,
				StartedAt:      now,
				UpdatedAt:      now,
			}
			if err := db.PutSettingJSON(rctx, s.DB.Writer, SettingLastResult, nextRes, db.FormatTime(now)); err != nil {
				st2.Finish(err, nil)
				return err
			}
			if err := s.swapSymlinks(curBin, prevBin); err != nil {
				_ = db.PutSettingJSON(rctx, s.DB.Writer, SettingLastResult, prevRes, db.FormatTime(s.DB.Now()))
				st2.Finish(err, nil)
				return err
			}
			nextRes.State = StatePending
			nextRes.UpdatedAt = s.DB.Now()
			if err := db.PutSettingJSON(rctx, s.DB.Writer, SettingLastResult, nextRes, db.FormatTime(nextRes.UpdatedAt)); err != nil {
				_ = s.swapSymlink(filepath.Join(s.BinDir, "nomad-deck"), curBin)
				_ = db.PutSettingJSON(rctx, s.DB.Writer, SettingLastResult, prevRes, db.FormatTime(s.DB.Now()))
				st2.Finish(err, nil)
				return err
			}
			_ = s.Audit.Record(rctx, nil, audit.Event{
				Actor: actor, Action: "system.self_update_rollback", ResourceType: "control_plane",
				OperationTaskID: t.ID,
				Summary:         map[string]any{"from_version": s.CurrentVersion, "to_version": targetVer},
			})
			st2.Logf("版本已回退到 %s，控制面即将以退出码 75 重启", targetVer)
			lowerBarrier = false
			keepUpdating = true
			if s.OnRestart != nil {
				go func() {
					time.Sleep(100 * time.Millisecond)
					s.OnRestart(version.ExitCodeRestart)
				}()
			}
			return ops.ErrHandover
		},
	})
	if err != nil {
		s.updating.Store(false)
		return nil, err
	}
	return task, nil
}
