package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

// Schedule statuses.
const (
	SchedIdle      = "idle"
	SchedWaiting   = "waiting"
	SchedUpgrading = "upgrading"
	SchedCompleted = "completed"
	SchedTimedOut  = "timed_out"
	SchedCancelled = "cancelled"
	SchedFailed    = "failed"
)

// Schedule limits.
const (
	MinWaitSeconds     = 30
	MaxWaitSeconds     = 24 * 3600
	DefaultWaitSeconds = 300

	MinIntervalSeconds     = 5
	MaxIntervalSeconds     = 3600
	DefaultIntervalSeconds = 20
)

// Schedule persists an unattended scheduled upgrade.
type Schedule struct {
	ID              string     `json:"id,omitempty"`
	TargetVersion   string     `json:"target_version"`
	ResolvedVersion string     `json:"resolved_version,omitempty"`
	WaitSeconds     int        `json:"wait_seconds"`
	IntervalSeconds int        `json:"interval_seconds"`
	UseProxy        bool       `json:"use_proxy"`
	Status          string     `json:"status"`
	TaskID          string     `json:"task_id,omitempty"`
	Message         string     `json:"message,omitempty"`
	CreatedBy       string     `json:"created_by,omitempty"`
	CreatedAt       time.Time  `json:"created_at,omitempty"`
	DeadlineAt      time.Time  `json:"deadline_at,omitempty"`
	LastCheckedAt   *time.Time `json:"last_checked_at,omitempty"`
	NextCheckAt     *time.Time `json:"next_check_at,omitempty"`
	FinishedAt      *time.Time `json:"finished_at,omitempty"`
}

// ScheduleInput creates a scheduled upgrade.
type ScheduleInput struct {
	TargetVersion   string `json:"target_version"`
	WaitSeconds     int    `json:"wait_seconds"`
	IntervalSeconds int    `json:"interval_seconds"`
	UseProxy        *bool  `json:"use_proxy"`
}

// GetSchedule returns the persisted schedule, if any.
func (s *Service) GetSchedule(ctx context.Context) (*Schedule, error) {
	var sc Schedule
	err := db.GetSettingJSON(ctx, s.DB.Reader, SettingSchedule, &sc)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sc, nil
}

// CreateSchedule validates and starts a scheduled upgrade.
func (s *Service) CreateSchedule(ctx context.Context, actor audit.Actor, in ScheduleInput) (*Schedule, error) {
	s.defaults()
	if avail, reason := s.Availability(); !avail {
		return nil, &auth.Error{Status: 409, Code: "self_update_unavailable", Message: reason}
	}
	if s.updating.Load() {
		return nil, &auth.Error{Status: 409, Code: "update_in_progress", Message: "当前正在执行立即升级，不能创建预约升级"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, err := s.GetSchedule(ctx); err != nil {
		return nil, err
	} else if existing != nil && (existing.Status == SchedWaiting || existing.Status == SchedUpgrading) {
		return nil, &auth.Error{Status: 409, Code: "schedule_active", Message: "已有进行中的预约升级"}
	}

	target := in.TargetVersion
	if target == "" {
		target = "latest"
	}
	if target != "latest" {
		if _, err := ParseSemver(target); err != nil {
			return nil, &auth.Error{Status: 400, Code: "invalid_argument", Message: "目标版本号不合法：" + target}
		}
		target = NormalizeTag(target)
	}
	waitSec := in.WaitSeconds
	if waitSec == 0 {
		waitSec = DefaultWaitSeconds
	}
	if waitSec < MinWaitSeconds || waitSec > MaxWaitSeconds {
		return nil, &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf("等待时长需在 %d～%d 秒之间", MinWaitSeconds, MaxWaitSeconds)}
	}
	intervalSec := in.IntervalSeconds
	if intervalSec == 0 {
		intervalSec = DefaultIntervalSeconds
	}
	if intervalSec < MinIntervalSeconds || intervalSec > MaxIntervalSeconds {
		return nil, &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf("检查间隔需在 %d～%d 秒之间", MinIntervalSeconds, MaxIntervalSeconds)}
	}
	up, err := s.resolveUseProxy(ctx, in.UseProxy)
	if err != nil {
		return nil, err
	}

	now := s.DB.Now()
	next := now
	sc := &Schedule{
		ID:              db.NewID(),
		TargetVersion:   target,
		WaitSeconds:     waitSec,
		IntervalSeconds: intervalSec,
		UseProxy:        up,
		Status:          SchedWaiting,
		CreatedBy:       actor.Name,
		CreatedAt:       now,
		DeadlineAt:      now.Add(time.Duration(waitSec) * time.Second),
		NextCheckAt:     &next,
	}
	if err := db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, sc, db.FormatTime(now)); err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "system.self_update_schedule_create", ResourceType: "control_plane",
		Summary: map[string]any{
			"schedule_id": sc.ID, "target_version": sc.TargetVersion, "wait_seconds": waitSec,
			"interval_seconds": intervalSec, "use_proxy": up,
		},
	})
	s.wakeScheduler()
	return sc, nil
}

// CancelSchedule cancels a waiting scheduled upgrade, or clears a finished schedule back to idle.
func (s *Service) CancelSchedule(ctx context.Context, actor audit.Actor) (*Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, err := s.GetSchedule(ctx)
	if err != nil {
		return nil, err
	}
	if sc == nil || sc.Status == SchedIdle {
		idle := &Schedule{Status: SchedIdle}
		return idle, nil
	}
	if sc.Status == SchedUpgrading {
		return nil, &auth.Error{Status: 409, Code: "already_upgrading", Message: "预约升级已开始执行，不可取消"}
	}
	now := s.DB.Now()
	if sc.Status != SchedWaiting {
		// Clear finished appointment result back to idle.
		idle := &Schedule{Status: SchedIdle}
		if err := db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, idle, db.FormatTime(now)); err != nil {
			return nil, err
		}
		s.wakeScheduler()
		return idle, nil
	}
	sc.Status = SchedCancelled
	sc.Message = "已取消预约升级"
	sc.NextCheckAt = nil
	sc.FinishedAt = &now
	if err := db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, sc, db.FormatTime(now)); err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "system.self_update_schedule_cancel", ResourceType: "control_plane",
		Summary: map[string]any{"schedule_id": sc.ID, "target_version": sc.TargetVersion},
	})
	s.wakeScheduler()
	return sc, nil
}

func (s *Service) wakeScheduler() {
	if s.schedWake == nil {
		return
	}
	select {
	case s.schedWake <- struct{}{}:
	default:
	}
}

func (s *Service) markScheduleDone(ctx context.Context, taskID, status, msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, err := s.GetSchedule(ctx)
	if err != nil || sc == nil || sc.Status != SchedUpgrading || (taskID != "" && sc.TaskID != taskID) {
		return
	}
	now := s.DB.Now()
	sc.Status = status
	if msg != "" {
		sc.Message = msg
	}
	sc.NextCheckAt = nil
	sc.FinishedAt = &now
	_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, sc, db.FormatTime(now))
}

// RunScheduler runs the background loop that polls for scheduled upgrades.
func (s *Service) RunScheduler(ctx context.Context) {
	s.defaults()
	if s.schedWake == nil {
		s.schedWake = make(chan struct{}, 1)
	}
	for {
		delay := s.stepSchedule(ctx)
		if delay <= 0 {
			delay = 5 * time.Second
		}
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-s.schedWake:
			t.Stop()
		case <-t.C:
		}
	}
}

func scheduleTimeoutMessage(target string) string {
	if target == "latest" {
		return "等待期内没有发布比当前更新的版本"
	}
	return "目标版本在截止时间前没有发布"
}

func (s *Service) stepSchedule(ctx context.Context) time.Duration {
	sc, err := s.GetSchedule(ctx)
	if err != nil || sc == nil {
		return 30 * time.Second
	}
	if sc.Status == SchedUpgrading {
		s.reconcileUpgradingSchedule(ctx, sc)
		return 5 * time.Second
	}
	if sc.Status != SchedWaiting {
		return 30 * time.Second
	}
	now := s.DB.Now()
	if sc.TargetVersion != "latest" {
		if cmp, err := CompareSemver(s.CurrentVersion, sc.TargetVersion); err == nil && cmp >= 0 {
			sc.Status = SchedCompleted
			sc.ResolvedVersion = NormalizeTag(sc.TargetVersion)
			sc.Message = fmt.Sprintf("当前版本 %s 已不低于目标版本 %s", s.CurrentVersion, sc.TargetVersion)
			sc.NextCheckAt = nil
			sc.FinishedAt = &now
			_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, sc, db.FormatTime(now))
			return 30 * time.Second
		}
	}
	if !now.Before(sc.DeadlineAt) {
		sc.Status = SchedTimedOut
		sc.Message = scheduleTimeoutMessage(sc.TargetVersion)
		sc.NextCheckAt = nil
		sc.FinishedAt = &now
		_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, sc, db.FormatTime(now))
		return 30 * time.Second
	}
	if sc.NextCheckAt != nil && now.Before(*sc.NextCheckAt) {
		d := sc.NextCheckAt.Sub(now)
		if rem := sc.DeadlineAt.Sub(now); rem < d {
			d = rem
		}
		return d
	}
	s.pollScheduleOnce(ctx, sc)
	return time.Duration(sc.IntervalSeconds) * time.Second
}

func (s *Service) reconcileUpgradingSchedule(ctx context.Context, sc *Schedule) {
	if sc.ResolvedVersion != "" && sameVersion(s.CurrentVersion, sc.ResolvedVersion) {
		s.markScheduleDone(ctx, sc.TaskID, SchedCompleted, "已升级到 "+sc.ResolvedVersion)
		return
	}
	if sc.TaskID == "" {
		return
	}
	t, err := db.GetTask(ctx, s.DB.Reader, sc.TaskID)
	if err != nil {
		return
	}
	switch t.Status {
	case db.TaskFailed, db.TaskCancelled, db.TaskInterrupted, db.TaskNeedsReconcile, db.TaskRolledBack:
		s.markScheduleDone(ctx, sc.TaskID, SchedFailed, t.ErrorMessage)
	}
}

func (s *Service) pollScheduleOnce(ctx context.Context, sc *Schedule) {
	s.mu.Lock()
	fresh, err := s.GetSchedule(ctx)
	if err != nil || fresh == nil || fresh.ID != sc.ID || fresh.Status != SchedWaiting {
		s.mu.Unlock()
		return
	}
	schedID := fresh.ID
	targetVer := fresh.TargetVersion
	useProxy := fresh.UseProxy
	createdBy := fresh.CreatedBy
	intervalSec := fresh.IntervalSeconds
	s.mu.Unlock()

	var msg string
	var resolvedVer string
	var picked *ReleaseInfo
	var alreadySatisfiedSpecific bool
	client, _, cerr := s.Proxy.Client(ctx, useProxy, 30*time.Second)
	if cerr != nil {
		msg = "代理不可用：" + cerr.Error()
	} else if rels, rerr := FetchReleases(ctx, client, s.APIBase, s.Repo); rerr != nil {
		msg = "检查版本失败：" + rerr.Error()
	} else if rel, rerr := ResolveRelease(rels, targetVer, s.channel(ctx), s.GOOS, s.GOARCH); rerr != nil {
		msg = rerr.Error()
	} else {
		resolvedVer = rel.Version
		if !rel.AssetsComplete {
			msg = fmt.Sprintf("版本 %s 资产或校验文件尚未完整，继续等待", rel.Version)
		} else if cmp, cerr := CompareSemver(rel.Version, s.CurrentVersion); cerr == nil && cmp > 0 {
			picked = rel
		} else if targetVer != "latest" {
			alreadySatisfiedSpecific = true
		} else {
			// latest 模式当前已是最新版：记录 resolved_version 并保持等待，直到有更新版本或截止。
			msg = ""
		}
	}

	var triggeredTaskID, triggeredVer string
	var triggerErr error
	if picked != nil {
		actor := audit.Actor{ID: "schedule:" + schedID, Name: createdBy}
		task, terr := s.startUpgradeWithRelease(ctx, actor, picked, useProxy, schedID)
		if terr != nil {
			triggerErr = terr
		} else {
			triggeredTaskID = task.ID
			triggeredVer = picked.Version
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.GetSchedule(ctx)
	if err != nil || cur == nil || cur.ID != schedID || cur.Status != SchedWaiting {
		if triggeredTaskID != "" {
			_ = s.Ops.Cancel(triggeredTaskID)
		}
		return
	}
	now := s.DB.Now()
	cur.LastCheckedAt = &now
	next := now.Add(time.Duration(intervalSec) * time.Second)
	cur.NextCheckAt = &next
	if resolvedVer != "" {
		cur.ResolvedVersion = resolvedVer
	}

	if triggeredTaskID != "" {
		cur.Status = SchedUpgrading
		cur.ResolvedVersion = triggeredVer
		cur.TaskID = triggeredTaskID
		cur.Message = ""
		cur.NextCheckAt = nil
	} else if alreadySatisfiedSpecific {
		cur.Status = SchedCompleted
		cur.Message = "当前已是目标版本或更新的版本，无需升级"
		cur.NextCheckAt = nil
		cur.FinishedAt = &now
	} else if triggerErr != nil {
		cur.Message = "触发升级失败：" + triggerErr.Error()
	} else {
		cur.Message = msg
	}
	if cur.Status == SchedWaiting && !now.Before(cur.DeadlineAt) {
		cur.Status = SchedTimedOut
		cur.Message = scheduleTimeoutMessage(cur.TargetVersion)
		cur.NextCheckAt = nil
		cur.FinishedAt = &now
	}
	_ = db.PutSettingJSON(ctx, s.DB.Writer, SettingSchedule, cur, db.FormatTime(s.DB.Now()))
}
