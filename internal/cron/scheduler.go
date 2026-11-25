// Package cron runs the platform's scheduled jobs: built-in maintenance
// jobs (health checks, certificate alerts, token renewal, auto-unseal,
// Raft snapshots, backups, cleanup) and administrator-defined jobs.
//
// Every job follows its overlap policy (skip_if_running or queue_one) and
// misfire policy (skip or run_once after a restart). Each run is recorded
// with a unique run key so the same window never runs twice; runs that do
// their work in an operation task link to it and take its final status.
package cron

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	robfig "github.com/robfig/cron/v3"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
)

// RunTimeout bounds one run.
const RunTimeout = 2 * time.Hour

// maxDetail caps a run's stored detail log.
const maxDetail = 256 << 10

// SettingActivated is the instance-local flag that enables automatic
// scheduling. It is false after a migration import until an administrator
// activates the control plane.
const SettingActivated = "control_plane.activated"

// Handler performs one run and returns a one-line summary.
type Handler func(ctx context.Context, r *Run) (string, error)

// Scheduler drives the scheduled jobs.
type Scheduler struct {
	DB    *db.DB
	Audit *audit.Recorder
	Ops   *ops.Engine
	Log   *slog.Logger
	// Now overrides the clock (tests).
	Now func() time.Time

	handlers map[string]Handler // built-in job_key or custom payload type
	customs  map[string]customType

	mu       sync.Mutex
	running  map[string]bool
	queued   map[string]queuedRun
	wake     chan struct{}
	cancel   context.CancelFunc
	base     context.Context
	wg       sync.WaitGroup
	started  bool
	stopping bool
}

type queuedRun struct {
	at      time.Time
	trigger string
	actor   audit.Actor
}

func (s *Scheduler) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Scheduler) init() {
	if s.running == nil {
		s.running, s.queued = map[string]bool{}, map[string]queuedRun{}
		s.wake = make(chan struct{}, 1)
	}
	if s.handlers == nil {
		s.handlers, s.customs = map[string]Handler{}, map[string]customType{}
	}
}

// Register installs the handler of a built-in job key.
func (s *Scheduler) Register(key string, h Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	s.handlers[key] = h
}

// Activated reports whether automatic scheduling is enabled on this instance.
func Activated(ctx context.Context, d *db.DB) bool {
	var v bool
	if err := db.GetSettingJSON(ctx, d.Reader, SettingActivated, &v); err != nil {
		return true // never imported: active
	}
	return v
}

// location returns the configured scheduling time zone.
func (s *Scheduler) location(ctx context.Context) *time.Location {
	var tz string
	_ = db.GetSettingJSON(ctx, s.DB.Reader, "cron.timezone", &tz)
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.UTC
	}
	return loc
}

var parser = robfig.NewParser(robfig.Minute | robfig.Hour | robfig.Dom | robfig.Month | robfig.Dow)

// ParseExpr validates a five-field cron expression.
func ParseExpr(expr string) (robfig.Schedule, error) {
	fields := strings.Fields(expr)
	if len(fields) != 5 || strings.Contains(expr, "TZ=") || strings.Contains(expr, "CRON_TZ=") {
		return nil, errors.New("需为 5 段 Cron 表达式（分 时 日 月 周），时区由系统设置统一指定")
	}
	sch, err := parser.Parse(strings.Join(fields, " "))
	if err != nil {
		return nil, fmt.Errorf("Cron 表达式无效：%v", err)
	}
	return sch, nil
}

func (s *Scheduler) next(ctx context.Context, j *db.CronJob, after time.Time) time.Time {
	sch, err := ParseExpr(j.CronExpr)
	if err != nil {
		return time.Time{}
	}
	return sch.Next(after.In(s.location(ctx))).UTC()
}

// Start seeds the built-in jobs, applies misfire policies and starts the
// scheduling loop.
func (s *Scheduler) Start(ctx context.Context) error {
	s.mu.Lock()
	s.init()
	if s.started {
		s.mu.Unlock()
		return nil
	}
	s.stopping = false
	s.mu.Unlock()
	if err := s.seed(ctx); err != nil {
		return err
	}
	if err := db.FailRunningCronRuns(ctx, s.DB.Writer, s.DB.Now()); err != nil {
		return err
	}
	jobs, err := db.ListCronJobs(ctx, s.DB.Reader)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		cancel()
		return nil
	}
	s.cancel, s.base = cancel, runCtx
	s.started = true
	s.wg.Add(1)
	s.mu.Unlock()
	now := s.now()
	for _, j := range jobs {
		if !j.Enabled {
			continue
		}
		if !j.NextRunAt.IsZero() && !j.NextRunAt.After(now) && j.MisfirePolicy == "run_once" {
			s.fire(runCtx, j, j.NextRunAt, "scheduled", audit.ActorCron)
		}
		_ = db.SetCronNext(ctx, s.DB.Writer, j.ID, s.next(ctx, j, now))
	}
	go s.loop(runCtx)
	return nil
}

// Stop ends the loop and cancels running jobs.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	s.stopping = true
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.wg.Wait()
}

// Reschedule recomputes the next run of every job (after edits or a time
// zone change).
func (s *Scheduler) Reschedule(ctx context.Context) {
	jobs, err := db.ListCronJobs(ctx, s.DB.Reader)
	if err != nil {
		return
	}
	now := s.now()
	for _, j := range jobs {
		next := time.Time{}
		if j.Enabled {
			next = s.next(ctx, j, now)
		}
		_ = db.SetCronNext(ctx, s.DB.Writer, j.ID, next)
	}
	s.poke()
}

func (s *Scheduler) poke() {
	s.mu.Lock()
	s.init()
	w := s.wake
	s.mu.Unlock()
	select {
	case w <- struct{}{}:
	default:
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	defer s.wg.Done()
	for {
		wait := s.tick(ctx)
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		case <-s.wake:
			t.Stop()
		}
	}
}

// tick fires due jobs and returns how long to sleep.
func (s *Scheduler) tick(ctx context.Context) time.Duration {
	wait := time.Minute
	jobs, err := db.ListCronJobs(ctx, s.DB.Reader)
	if err != nil {
		return wait
	}
	now := s.now()
	for _, j := range jobs {
		if !j.Enabled {
			continue
		}
		if j.NextRunAt.IsZero() {
			j.NextRunAt = s.next(ctx, j, now)
			_ = db.SetCronNext(ctx, s.DB.Writer, j.ID, j.NextRunAt)
		}
		if j.NextRunAt.IsZero() {
			continue
		}
		if !j.NextRunAt.After(now) {
			s.fire(ctx, j, j.NextRunAt, "scheduled", audit.ActorCron)
			j.NextRunAt = s.next(ctx, j, now)
			_ = db.SetCronNext(ctx, s.DB.Writer, j.ID, j.NextRunAt)
		}
		if d := j.NextRunAt.Sub(now); d < wait {
			wait = d
		}
	}
	if wait < time.Second {
		wait = time.Second
	}
	return wait
}

// alwaysRuns lists jobs that only touch local state and keep running while
// the control plane awaits activation.
var alwaysRuns = map[string]bool{"cleanup_audit_logs": true, "cleanup_operation_logs": true, "cert_expiry_check": true}

// ErrAlreadyRunning is returned by a manual trigger when the job is running
// and its overlap policy skips.
var ErrAlreadyRunning = &auth.Error{Status: 409, Code: "already_running", Message: "该定时任务正在执行，请等待本次执行结束"}

// fire starts one run unless gating or the overlap policy prevents it.
func (s *Scheduler) fire(ctx context.Context, j *db.CronJob, at time.Time, trigger string, actor audit.Actor) (*db.CronRun, error) {
	runKey := j.ID + "@" + db.FormatTime(at)
	if trigger == "manual" {
		runKey = j.ID + "@manual@" + db.NewID()
	}
	rec := &db.CronRun{ID: db.NewID(), CronJobID: j.ID, RunKey: runKey, ScheduledFor: at, TriggerType: trigger,
		Status: db.RunRunning, StartedAt: s.DB.Now()}
	skip := func(reason string) (*db.CronRun, error) {
		rec.Status, rec.Summary, rec.FinishedAt = db.RunSkipped, reason, s.DB.Now()
		if err := db.InsertCronRun(ctx, s.DB.Writer, rec); err != nil {
			return nil, err
		}
		_ = db.SetCronLast(ctx, s.DB.Writer, j.ID, db.RunSkipped, rec.FinishedAt)
		return rec, nil
	}
	if reason := s.Ops.Barrier(); reason != "" {
		return skip("控制面处于全局维护状态：" + reason)
	}
	if !alwaysRuns[j.JobKey] && !Activated(ctx, s.DB) {
		return skip("控制面尚未激活，自动调度暂停")
	}
	h, err := s.handlerOf(j)
	if err != nil {
		return skip(err.Error())
	}
	s.mu.Lock()
	if s.stopping || ctx.Err() != nil {
		s.mu.Unlock()
		return nil, &auth.Error{Status: 409, Code: "scheduler_stopped", Message: "调度器正在停止"}
	}
	if s.running[j.ID] {
		if trigger == "manual" && j.OverlapPolicy != "queue_one" {
			s.mu.Unlock()
			return nil, ErrAlreadyRunning
		}
		if j.OverlapPolicy == "queue_one" {
			s.queued[j.ID] = queuedRun{at: at, trigger: trigger, actor: actor}
			s.mu.Unlock()
			return nil, nil
		}
		s.mu.Unlock()
		return skip("上一次执行尚未结束，按防重入策略跳过")
	}
	if err := db.InsertCronRun(ctx, s.DB.Writer, rec); err != nil {
		s.mu.Unlock()
		if errors.Is(err, db.ErrUnique) {
			return nil, nil // this window already ran
		}
		return nil, err
	}
	s.running[j.ID] = true
	s.wg.Add(1)
	s.mu.Unlock()
	if trigger == "manual" {
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cron.run", ResourceType: "cron_job", ResourceID: j.ID,
			ResourceName: j.JobKey, Summary: map[string]any{"run_id": rec.ID}})
	}
	go s.execute(ctx, j, rec, h)
	return rec, nil
}

func (s *Scheduler) execute(parent context.Context, j *db.CronJob, rec *db.CronRun, h Handler) {
	defer s.wg.Done()
	ctx, cancel := context.WithTimeout(parent, RunTimeout)
	defer cancel()
	r := &Run{s: s, Job: j, Record: rec}
	summary, err := func() (sum string, err error) {
		defer func() {
			if v := recover(); v != nil {
				err = fmt.Errorf("panic: %v", v)
			}
		}()
		return h(ctx, r)
	}()
	status := db.RunSuccess
	var skipErr *SkipError
	if errors.As(err, &skipErr) {
		status, summary, err = db.RunSkipped, skipErr.Reason, nil
	}
	if err != nil {
		status = db.RunFailed
		msg := audit.RedactString(err.Error())
		if summary == "" {
			summary = msg
		} else {
			summary += "；" + msg
		}
		r.Logf("错误：%s", msg)
	}
	now := s.DB.Now()
	bg := context.Background()
	if dbErr := db.FinishCronRun(bg, s.DB.Writer, rec.ID, status, audit.RedactString(summary), r.detail(), now); dbErr != nil {
		s.Log.Error("finish cron run", "job", j.JobKey, "err", dbErr)
	}
	_ = db.SetCronLast(bg, s.DB.Writer, j.ID, status, now)
	if status == db.RunFailed {
		s.Log.Warn("scheduled job failed", "job", j.JobKey, "err", summary)
	}
	s.mu.Lock()
	delete(s.running, j.ID)
	q, again := s.queued[j.ID]
	delete(s.queued, j.ID)
	s.mu.Unlock()
	if again && parent.Err() == nil {
		if fresh, err := db.GetCronJob(bg, s.DB.Reader, j.ID); err == nil && (fresh.Enabled || q.trigger == "manual") {
			a := q.actor
			if a.Name == "" {
				a = audit.ActorCron
			}
			_, _ = s.fire(parent, fresh, q.at, q.trigger, a)
		}
	}
}

// Trigger runs a job now on behalf of an administrator. A nil run with a
// nil error means the trigger was queued behind the running execution.
func (s *Scheduler) Trigger(ctx context.Context, actor audit.Actor, jobID string) (*db.CronRun, error) {
	s.mu.Lock()
	s.init()
	base := s.base
	s.mu.Unlock()
	if base == nil || base.Err() != nil {
		return nil, &auth.Error{Status: 409, Code: "scheduler_stopped", Message: "调度器未运行"}
	}
	j, err := db.GetCronJob(ctx, s.DB.Reader, jobID)
	if err != nil {
		return nil, notFound()
	}
	return s.fire(base, j, s.now(), "manual", actor)
}

// Running reports whether a job currently runs.
func (s *Scheduler) Running(jobID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running[jobID]
}

// Idle waits until no job runs (or ctx ends).
func (s *Scheduler) Idle(ctx context.Context) error {
	for {
		s.mu.Lock()
		n := len(s.running)
		s.mu.Unlock()
		if n == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *Scheduler) handlerOf(j *db.CronJob) (Handler, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if j.IsBuiltin {
		if h := s.handlers[j.JobKey]; h != nil {
			return h, nil
		}
		return nil, fmt.Errorf("内置任务 %s 未注册执行器", j.JobKey)
	}
	var p struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal([]byte(j.PayloadJSON), &p)
	if ct, ok := s.customs[p.Type]; ok {
		return ct.run, nil
	}
	return nil, fmt.Errorf("未知的自定义任务类型 %q", p.Type)
}

// Run is the handle a handler uses to log and link operation tasks.
type Run struct {
	s      *Scheduler
	Job    *db.CronJob
	Record *db.CronRun

	mu  sync.Mutex
	buf strings.Builder
}

// Logf appends a timestamped, redacted line to the run's detail log.
func (r *Run) Logf(format string, args ...any) {
	line := audit.RedactString(fmt.Sprintf(format, args...))
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.buf.Len() > maxDetail {
		return
	}
	r.buf.WriteString(time.Now().UTC().Format("15:04:05 "))
	r.buf.WriteString(line)
	r.buf.WriteByte('\n')
	if r.buf.Len() > maxDetail {
		r.buf.WriteString("…（日志过长，已截断）\n")
	}
}

func (r *Run) detail() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.String()
}

// Payload decodes the job's payload.
func (r *Run) Payload(v any) error { return json.Unmarshal([]byte(r.Job.PayloadJSON), v) }

// Task submits an operation task for this run, links it and waits for its
// result: the run's status follows the task's final status.
func (r *Run) Task(ctx context.Context, spec ops.Spec) (*db.OperationTask, error) {
	if spec.TriggeredBy == "" {
		spec.TriggeredBy = audit.ActorCron.Name
	}
	t, err := r.s.Ops.Submit(ctx, spec)
	if err != nil {
		return nil, err
	}
	return r.Follow(ctx, t)
}

// Follow links an already submitted task and waits for it.
func (r *Run) Follow(ctx context.Context, t *db.OperationTask) (*db.OperationTask, error) {
	r.Record.OperationTaskID = t.ID
	_ = db.SetCronRunTask(context.Background(), r.s.DB.Writer, r.Record.ID, t.ID)
	r.Logf("关联运维任务 %s（%s）", t.ID, t.Action)
	final, err := r.s.Ops.WaitTask(ctx, t.ID)
	if err != nil {
		return nil, err
	}
	if final.Status != db.TaskSuccess {
		msg := final.ErrorMessage
		if msg == "" {
			msg = final.Status
		}
		return final, fmt.Errorf("运维任务 %s 结束状态为 %s：%s", t.ID, final.Status, msg)
	}
	return final, nil
}

func notFound() error {
	return &auth.Error{Status: 404, Code: "not_found", Message: "定时任务不存在"}
}

func badRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}
