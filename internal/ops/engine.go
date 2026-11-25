package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
)

// DefaultSharedTimeout bounds tasks holding shared locks.
const DefaultSharedTimeout = 30 * time.Minute

// ErrRolledBack marks a task that failed but was rolled back cleanly.
var ErrRolledBack = errors.New("rolled back")

// ErrHandover marks a task (such as system.self_update) whose process is
// restarting so the replacement binary or rollback unit finalizes it.
var ErrHandover = errors.New("handover to restarted process")

// Spec describes a task to run.
type Spec struct {
	Action      string
	TargetType  string
	TargetID    string
	Locks       []LockReq
	Params      map[string]any // recorded after redaction
	TriggeredBy string
	// Timeout bounds the run; tasks holding only shared locks default to DefaultSharedTimeout.
	Timeout time.Duration
	Run     func(ctx context.Context, t *Task) error
}

// Engine executes tasks.
type Engine struct {
	DB      *db.DB
	Locks   *LockManager
	Hub     *Hub
	Log     *slog.Logger
	DataDir string

	wg         sync.WaitGroup
	mu         sync.Mutex
	cancel     map[string]context.CancelFunc
	submitting int
	barrier    string
	barrierSeq uint64
	barrierTok uint64
}

// ErrBarrier is returned while the control plane is under a global
// maintenance barrier (for example during a migration import).
var ErrBarrier = errors.New("控制面处于全局维护状态，暂不接受新的运维任务")

// TryAcquireBarrier atomically raises the global maintenance barrier if no
// barrier is currently active, returning a release function scoped to this
// acquisition.
func (e *Engine) TryAcquireBarrier(reason string) (func(), bool) {
	if reason == "" {
		return nil, false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.barrier != "" {
		return nil, false
	}
	e.barrierSeq++
	tok := e.barrierSeq
	e.barrier = reason
	e.barrierTok = tok
	var once sync.Once
	return func() {
		once.Do(func() {
			e.mu.Lock()
			if e.barrierTok == tok {
				e.barrier = ""
				e.barrierTok = 0
			}
			e.mu.Unlock()
		})
	}, true
}

// SetBarrier raises (non-empty reason) or lowers the global maintenance
// barrier. While raised, new tasks are refused.
func (e *Engine) SetBarrier(reason string) {
	e.mu.Lock()
	e.barrierSeq++
	e.barrier = reason
	if reason == "" {
		e.barrierTok = 0
	} else {
		e.barrierTok = e.barrierSeq
	}
	e.mu.Unlock()
}

// Barrier returns the active barrier reason ("" when none).
func (e *Engine) Barrier() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.barrier
}

// Active reports how many submitted tasks have not finished.
func (e *Engine) Active() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.cancel) + e.submitting
}

// NewEngine creates an engine storing step logs under dataDir/ops.
func NewEngine(d *db.DB, log *slog.Logger, dataDir string) *Engine {
	return &Engine{DB: d, Locks: NewLockManager(), Hub: NewHub(), Log: log, DataDir: dataDir,
		cancel: map[string]context.CancelFunc{}}
}

// LogDir returns the directory holding a task's step logs.
func (e *Engine) LogDir(taskID string) string { return filepath.Join(e.DataDir, "ops", taskID) }

// Recover marks tasks left unfinished by a previous process: pending tasks
// become interrupted, running tasks need reconciliation. Self-update tasks
// are finalized by the self-update flow and are skipped.
func (e *Engine) Recover(ctx context.Context) ([]*db.OperationTask, error) {
	tasks, err := db.ListUnfinishedTasks(ctx, e.DB.Reader)
	if err != nil {
		return nil, err
	}
	var affected []*db.OperationTask
	now := e.DB.Now()
	for _, t := range tasks {
		if t.Action == "system.self_update" {
			continue
		}
		status := db.TaskInterrupted
		msg := "控制面重启前任务尚未开始"
		if t.Status == db.TaskRunning {
			status = db.TaskNeedsReconcile
			msg = "控制面在任务执行期间重启，需要核对远端状态"
		}
		if err := db.FinishTask(ctx, e.DB.Writer, t.ID, status, msg, now); err != nil {
			return nil, err
		}
		if err := db.MarkRunningStepsInterrupted(ctx, e.DB.Writer, t.ID, now); err != nil {
			return nil, err
		}
		t.Status, t.ErrorMessage = status, msg
		affected = append(affected, t)
	}
	return affected, nil
}

// Submit records a pending task and runs it in the background.
func (e *Engine) Submit(ctx context.Context, s Spec) (*db.OperationTask, error) {
	if s.Run == nil || s.Action == "" {
		return nil, errors.New("task spec requires Action and Run")
	}
	e.mu.Lock()
	if e.barrier != "" {
		e.mu.Unlock()
		return nil, ErrBarrier
	}
	e.submitting++
	e.mu.Unlock()
	submitted := false
	defer func() {
		if !submitted {
			e.mu.Lock()
			e.submitting--
			e.mu.Unlock()
		}
	}()
	mode := "none"
	for _, l := range normalize(s.Locks) {
		if l.Mode == Exclusive {
			mode = "exclusive"
			break
		}
		mode = "shared"
	}
	params := "{}"
	if s.Params != nil {
		if b, err := json.Marshal(audit.RedactValue(s.Params)); err == nil {
			params = string(b)
		}
	}
	id := db.NewID()
	t := &db.OperationTask{ID: id, Action: s.Action, TargetType: s.TargetType, TargetID: s.TargetID, LockMode: mode,
		RemoteOpID: id, Status: db.TaskPending, ParamsRedactedJSON: params, TriggeredBy: s.TriggeredBy, CreatedAt: e.DB.Now()}
	if err := db.InsertTask(ctx, e.DB.Writer, t); err != nil {
		return nil, err
	}
	timeout := s.Timeout
	if timeout == 0 && mode == "shared" {
		timeout = DefaultSharedTimeout
	}
	runCtx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.submitting--
	e.cancel[id] = cancel
	submitted = true
	e.mu.Unlock()
	e.wg.Add(1)
	go e.execute(runCtx, cancel, t, s, timeout)
	return t, nil
}

// Cancel requests cancellation of a running task.
func (e *Engine) Cancel(taskID string) bool {
	e.mu.Lock()
	c, ok := e.cancel[taskID]
	e.mu.Unlock()
	if ok {
		c()
	}
	return ok
}

// Wait blocks until every submitted task has finished (used in tests and shutdown).
func (e *Engine) Wait() { e.wg.Wait() }

func (e *Engine) execute(ctx context.Context, cancel context.CancelFunc, rec *db.OperationTask, s Spec, timeout time.Duration) {
	defer e.wg.Done()
	defer func() {
		cancel()
		e.mu.Lock()
		delete(e.cancel, rec.ID)
		e.mu.Unlock()
	}()
	finish := func(status string, err error) {
		msg := ""
		if err != nil {
			msg = audit.RedactString(err.Error())
		}
		bg := context.Background()
		if dbErr := db.FinishTask(bg, e.DB.Writer, rec.ID, status, msg, e.DB.Now()); dbErr != nil {
			e.Log.Error("finish task", "task", rec.ID, "err", dbErr)
		}
		_ = db.MarkRunningStepsInterrupted(bg, e.DB.Writer, rec.ID, e.DB.Now())
		e.Hub.Finish(rec.ID, status, msg)
	}
	release, err := e.Locks.Acquire(ctx, s.Locks)
	if err != nil {
		finish(db.TaskCancelled, fmt.Errorf("等待锁时被取消：%w", err))
		return
	}
	defer release()
	if err := db.MarkTaskRunning(context.Background(), e.DB.Writer, rec.ID, e.DB.Now()); err != nil {
		finish(db.TaskFailed, err)
		return
	}
	runCtx := ctx
	if timeout > 0 {
		var c context.CancelFunc
		runCtx, c = context.WithTimeout(ctx, timeout)
		defer c()
	}
	task := &Task{ID: rec.ID, RemoteOpID: rec.RemoteOpID, engine: e}
	err = func() (err error) {
		defer func() {
			if v := recover(); v != nil {
				err = fmt.Errorf("panic: %v", v)
			}
		}()
		return s.Run(runCtx, task)
	}()
	if errors.Is(err, ErrHandover) {
		return
	}
	task.closeSteps(err)
	switch {
	case err == nil:
		finish(db.TaskSuccess, nil)
	case errors.Is(err, ErrRolledBack):
		finish(db.TaskRolledBack, err)
	case errors.Is(err, context.Canceled):
		finish(db.TaskCancelled, err)
	default:
		finish(db.TaskFailed, err)
	}
}

// Task is the runtime handle passed to Spec.Run.
type Task struct {
	ID         string
	RemoteOpID string
	engine     *Engine

	mu    sync.Mutex
	order int
	open  []*Step
}

// EmitProgress publishes structured stage/byte progress over SSE for live UIs.
func (t *Task) EmitProgress(stage string, done, total int64) {
	t.engine.Hub.Publish(t.ID, Event{
		Type:     "progress",
		Progress: &Progress{Stage: stage, Done: done, Total: total},
	})
}

// Checkpoint persists structured intent/progress for crash reconciliation.
func (t *Task) Checkpoint(v any) error {
	b, err := json.Marshal(audit.RedactValue(toMap(v)))
	if err != nil {
		return err
	}
	return db.UpdateTaskIntent(context.Background(), t.engine.DB.Writer, t.ID, string(b))
}

func toMap(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var out any
	if json.Unmarshal(b, &out) != nil {
		return v
	}
	return out
}

// Step starts a new step; its log is redacted, written to a file and
// published live. Call Finish when done.
func (t *Task) Step(name, nodeID string) (*Step, error) {
	t.mu.Lock()
	t.order++
	order := t.order
	t.mu.Unlock()
	dir := t.engine.LogDir(t.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	rel := filepath.Join("ops", t.ID, strconv.Itoa(order)+".log")
	f, err := os.OpenFile(filepath.Join(t.engine.DataDir, rel), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	s := &Step{ID: db.NewID(), Name: name, task: t, file: f}
	s.redactor = audit.NewWriter(&stepSink{s: s})
	rec := &db.OperationStep{ID: s.ID, TaskID: t.ID, StepOrder: order, NodeID: nodeID, Name: name, Status: "running",
		LogPath: rel, StartedAt: t.engine.DB.Now()}
	if err := db.InsertStep(context.Background(), t.engine.DB.Writer, rec); err != nil {
		f.Close()
		return nil, err
	}
	t.mu.Lock()
	t.open = append(t.open, s)
	t.mu.Unlock()
	t.engine.Hub.Publish(t.ID, Event{Type: "step", StepID: s.ID, Name: name, Status: "running"})
	return s, nil
}

func (t *Task) closeSteps(err error) {
	t.mu.Lock()
	open := append([]*Step(nil), t.open...)
	t.mu.Unlock()
	for _, s := range open {
		if err != nil {
			s.Finish(err, nil)
		} else {
			s.Finish(nil, nil)
		}
	}
}

// Step is one step of a running task.
type Step struct {
	ID       string
	Name     string
	task     *Task
	file     *os.File
	redactor *audit.Writer

	mu     sync.Mutex
	offset int64
	done   bool
}

type stepSink struct{ s *Step }

func (w *stepSink) Write(p []byte) (int, error) {
	s := w.s
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return 0, io.ErrClosedPipe
	}
	off := s.offset
	n, err := s.file.Write(p)
	s.offset += int64(n)
	s.mu.Unlock()
	if n > 0 {
		s.task.engine.Hub.Publish(s.task.ID, Event{Type: "log", StepID: s.ID, Offset: off, Data: string(p[:n])})
	}
	return n, err
}

// Log returns the step's (redacting) log writer.
func (s *Step) Log() io.Writer { return s.redactor }

// Logf writes a formatted line to the step log.
func (s *Step) Logf(format string, args ...any) {
	fmt.Fprintf(s.redactor, format+"\n", args...)
}

// SetRemoteUnit records the transient systemd unit running this step.
func (s *Step) SetRemoteUnit(unit string) {
	_ = db.SetStepRemoteUnit(context.Background(), s.task.engine.DB.Writer, s.ID, unit)
}

// Finish completes the step (idempotent).
func (s *Step) Finish(err error, exitCode *int) {
	_ = s.redactor.Flush()
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return
	}
	s.done = true
	_ = s.file.Close()
	s.mu.Unlock()
	status, msg := "success", ""
	if err != nil {
		status, msg = "failed", audit.RedactString(err.Error())
	}
	_ = db.FinishStep(context.Background(), s.task.engine.DB.Writer, s.ID, status, exitCode, msg, s.task.engine.DB.Now())
	s.task.engine.Hub.Publish(s.task.ID, Event{Type: "step", StepID: s.ID, Name: s.Name, Status: status, Error: msg})
	s.task.mu.Lock()
	for i, o := range s.task.open {
		if o == s {
			s.task.open = append(s.task.open[:i], s.task.open[i+1:]...)
			break
		}
	}
	s.task.mu.Unlock()
}

// WaitTask blocks until a task finishes (or ctx ends) and returns its
// final record.
func (e *Engine) WaitTask(ctx context.Context, taskID string) (*db.OperationTask, error) {
	for {
		ch, unsub := e.Hub.Subscribe(taskID)
		t, err := db.GetTask(ctx, e.DB.Reader, taskID)
		if err != nil {
			unsub()
			return nil, err
		}
		switch t.Status {
		case db.TaskPending, db.TaskRunning:
		default:
			unsub()
			return t, nil
		}
		select {
		case <-ctx.Done():
			unsub()
			return nil, ctx.Err()
		case <-drain(ch):
		}
		unsub()
	}
}

// drain returns a channel closed once ch is closed (events are discarded).
func drain(ch <-chan Event) <-chan struct{} {
	out := make(chan struct{})
	go func() {
		for range ch {
		}
		close(out)
	}()
	return out
}
