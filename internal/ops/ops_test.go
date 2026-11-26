package ops

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/db"
)

func TestExclusiveBlocksShared(t *testing.T) {
	m := NewLockManager()
	ctx := context.Background()
	rel, err := m.Acquire(ctx, []LockReq{{Key: "cluster:a", Mode: Exclusive}})
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan struct{})
	go func() {
		r, _ := m.Acquire(ctx, []LockReq{{Key: "cluster:a", Mode: Shared}})
		close(got)
		r()
	}()
	select {
	case <-got:
		t.Fatal("shared lock granted while exclusive held")
	case <-time.After(50 * time.Millisecond):
	}
	rel()
	select {
	case <-got:
	case <-time.After(time.Second):
		t.Fatal("shared lock not granted after release")
	}
}

func TestSharedLocksRunInParallelAndWritersAreNotStarved(t *testing.T) {
	m := NewLockManager()
	ctx := context.Background()
	r1, _ := m.Acquire(ctx, []LockReq{{Key: "k", Mode: Shared}})
	r2, err := m.Acquire(ctx, []LockReq{{Key: "k", Mode: Shared}})
	if err != nil {
		t.Fatal("two shared locks must coexist")
	}
	writer := make(chan struct{})
	go func() {
		r, _ := m.Acquire(ctx, []LockReq{{Key: "k", Mode: Exclusive}})
		close(writer)
		r()
	}()
	time.Sleep(30 * time.Millisecond)
	// A new shared request must wait behind the queued writer.
	cctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := m.Acquire(cctx, []LockReq{{Key: "k", Mode: Shared}}); err == nil {
		t.Fatal("new shared lock must not jump ahead of a waiting writer")
	}
	r1()
	r2()
	select {
	case <-writer:
	case <-time.After(time.Second):
		t.Fatal("writer starved")
	}
}

func TestMultiKeyAcquireIsAtomic(t *testing.T) {
	m := NewLockManager()
	ctx := context.Background()
	rb, _ := m.Acquire(ctx, []LockReq{{Key: "b", Mode: Exclusive}})
	cctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := m.Acquire(cctx, []LockReq{{Key: "a", Mode: Exclusive}, {Key: "b", Mode: Exclusive}}); err == nil {
		t.Fatal("expected timeout")
	}
	if m.Busy("a") {
		t.Fatal("partial acquisition must not hold key a")
	}
	rb()
}

func newEngine(t *testing.T) *Engine {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return NewEngine(d, slog.New(slog.NewTextHandler(io.Discard, nil)), dir)
}

func TestEngineRunsTaskWithRedactedStepLogs(t *testing.T) {
	e := newEngine(t)
	task, err := e.Submit(context.Background(), Spec{Action: "test.run", Locks: []LockReq{{Key: "host:n1:nomad", Mode: Exclusive}},
		Params: map[string]any{"password": "p@ss", "version": "1.9.0"},
		Run: func(ctx context.Context, tk *Task) error {
			s, err := tk.Step("prepare", "n1")
			if err != nil {
				return err
			}
			s.Logf("hello token=hvs.SECRETSECRETSECRETSECRET123")
			s.Finish(nil, nil)
			return tk.Checkpoint(map[string]any{"phase": "done"})
		}})
	if err != nil {
		t.Fatal(err)
	}
	e.Wait()
	got, _ := db.GetTask(context.Background(), e.DB.Reader, task.ID)
	if got.Status != db.TaskSuccess || got.LockMode != "exclusive" {
		t.Fatalf("task: %+v", got)
	}
	if strings.Contains(got.ParamsRedactedJSON, "p@ss") || !strings.Contains(got.IntentJSON, "done") {
		t.Fatalf("params/intent: %s %s", got.ParamsRedactedJSON, got.IntentJSON)
	}
	steps, _ := db.ListSteps(context.Background(), e.DB.Reader, task.ID)
	if len(steps) != 1 || steps[0].Status != "success" {
		t.Fatalf("steps: %+v", steps)
	}
	b, _ := os.ReadFile(filepath.Join(e.DataDir, steps[0].LogPath))
	if !strings.Contains(string(b), "hello") || strings.Contains(string(b), "SECRETSECRET") {
		t.Fatalf("log not redacted: %q", b)
	}
}

func TestEngineFailureAndSharedTimeout(t *testing.T) {
	e := newEngine(t)
	task, _ := e.Submit(context.Background(), Spec{Action: "test.fail", Run: func(ctx context.Context, tk *Task) error {
		s, _ := tk.Step("boom", "")
		_ = s
		return errors.New("exploded")
	}})
	slow, _ := e.Submit(context.Background(), Spec{Action: "test.slow", Locks: []LockReq{{Key: "cluster:x", Mode: Shared}},
		Timeout: 50 * time.Millisecond, Run: func(ctx context.Context, tk *Task) error {
			<-ctx.Done()
			return ctx.Err()
		}})
	e.Wait()
	got, _ := db.GetTask(context.Background(), e.DB.Reader, task.ID)
	steps, _ := db.ListSteps(context.Background(), e.DB.Reader, task.ID)
	if got.Status != db.TaskFailed || got.ErrorMessage != "exploded" || steps[0].Status != "failed" {
		t.Fatalf("failed task: %+v %+v", got, steps[0])
	}
	s, _ := db.GetTask(context.Background(), e.DB.Reader, slow.ID)
	if s.Status != db.TaskFailed || !strings.Contains(s.ErrorMessage, "deadline") {
		t.Fatalf("shared task must time out: %+v", s)
	}
}

func TestRecoverMarksUnfinishedTasks(t *testing.T) {
	e := newEngine(t)
	ctx := context.Background()
	now := e.DB.Now()
	for _, tk := range []*db.OperationTask{
		{ID: "T1", Action: "nomad.install", Status: db.TaskRunning, LockMode: "exclusive", CreatedAt: now},
		{ID: "T2", Action: "nomad.install", Status: db.TaskPending, LockMode: "exclusive", CreatedAt: now},
		{ID: "T3", Action: "system.self_update", Status: db.TaskRunning, LockMode: "none", CreatedAt: now},
	} {
		if err := db.InsertTask(ctx, e.DB.Writer, tk); err != nil {
			t.Fatal(err)
		}
	}
	db.InsertStep(ctx, e.DB.Writer, &db.OperationStep{ID: "S1", TaskID: "T1", StepOrder: 1, Name: "x", Status: "running", StartedAt: now})
	if _, err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"T1": db.TaskNeedsReconcile, "T2": db.TaskInterrupted, "T3": db.TaskRunning}
	for id, st := range want {
		got, _ := db.GetTask(ctx, e.DB.Reader, id)
		if got.Status != st {
			t.Errorf("%s: %s, want %s", id, got.Status, st)
		}
	}
	steps, _ := db.ListSteps(ctx, e.DB.Reader, "T1")
	if steps[0].Status != "interrupted" {
		t.Fatalf("step: %s", steps[0].Status)
	}
}

func TestHubDeliversAndFinishes(t *testing.T) {
	h := NewHub()
	ch, _ := h.Subscribe("t")
	h.Publish("t", Event{Type: "progress", Progress: &Progress{Stage: "download", Done: 512, Total: 2048}})
	if p := h.LatestProgress("t"); p == nil || p.Stage != "download" || p.Done != 512 || p.Total != 2048 {
		t.Fatalf("latest progress: %+v", p)
	}
	h.Publish("t", Event{Type: "log", Data: "x"})
	h.Finish("t", "success", "")
	if p := h.LatestProgress("t"); p != nil {
		t.Fatalf("progress after finish must be cleared, got %+v", p)
	}
	var types []string
	for ev := range ch {
		types = append(types, ev.Type)
	}
	if strings.Join(types, ",") != "progress,log,done" {
		t.Fatalf("events: %v", types)
	}
	late, _ := h.Subscribe("t")
	if _, ok := <-late; ok {
		t.Fatal("subscription after finish must be closed")
	}
}
