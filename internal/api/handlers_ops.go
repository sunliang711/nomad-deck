package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
)

type taskView struct {
	ID           string          `json:"id"`
	Action       string          `json:"action"`
	TargetType   string          `json:"target_type"`
	TargetID     string          `json:"target_id"`
	LockMode     string          `json:"lock_mode"`
	Status       string          `json:"status"`
	Params       json.RawMessage `json:"params"`
	Intent       json.RawMessage `json:"intent"`
	TriggeredBy  string          `json:"triggered_by"`
	CreatedAt    any             `json:"created_at"`
	StartedAt    any             `json:"started_at"`
	FinishedAt   any             `json:"finished_at"`
	ErrorMessage string          `json:"error_message"`
}

func rawOr(s string) json.RawMessage {
	if json.Valid([]byte(s)) {
		return json.RawMessage(s)
	}
	return json.RawMessage("{}")
}

func taskOf(t *db.OperationTask) taskView {
	return taskView{ID: t.ID, Action: t.Action, TargetType: t.TargetType, TargetID: t.TargetID, LockMode: t.LockMode,
		Status: t.Status, Params: rawOr(t.ParamsRedactedJSON), Intent: rawOr(t.IntentJSON), TriggeredBy: t.TriggeredBy,
		CreatedAt: fmtTime(t.CreatedAt), StartedAt: fmtTime(t.StartedAt), FinishedAt: fmtTime(t.FinishedAt),
		ErrorMessage: t.ErrorMessage}
}

type stepView struct {
	ID           string `json:"id"`
	Order        int    `json:"order"`
	NodeID       string `json:"node_id"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	RemoteUnit   string `json:"remote_unit"`
	ExitCode     *int   `json:"exit_code"`
	StartedAt    any    `json:"started_at"`
	FinishedAt   any    `json:"finished_at"`
	ErrorMessage string `json:"error_message"`
}

func (a *API) listOperations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := db.TaskFilter{Status: q.Get("status"), Action: q.Get("action"), TargetType: q.Get("target_type"),
		TargetID: q.Get("target_id"), Before: q.Get("before")}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 500 {
			writeError(w, http.StatusBadRequest, "invalid_argument", "limit 需为 1～500")
			return
		}
		f.Limit = n
	}
	tasks, err := db.ListTasks(r.Context(), a.DB.Reader, f)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]taskView, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, taskOf(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"operations": out})
}

func (a *API) getOperation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := db.GetTask(r.Context(), a.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "运维任务不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	steps, err := db.ListSteps(r.Context(), a.DB.Reader, id)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	sv := make([]stepView, 0, len(steps))
	for _, s := range steps {
		sv = append(sv, stepView{ID: s.ID, Order: s.StepOrder, NodeID: s.NodeID, Name: s.Name, Status: s.Status,
			RemoteUnit: s.RemoteUnit, ExitCode: s.ExitCode, StartedAt: fmtTime(s.StartedAt), FinishedAt: fmtTime(s.FinishedAt),
			ErrorMessage: s.ErrorMessage})
	}
	writeJSON(w, http.StatusOK, map[string]any{"operation": taskOf(t), "steps": sv})
}

// streamOperation replays the task's step logs and then streams live events
// over SSE until the task finishes or the session is revoked.
func (a *API) streamOperation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	t, err := db.GetTask(r.Context(), a.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "运维任务不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no_stream", "当前连接不支持流式输出")
		return
	}
	// Subscribe before replaying so no event is lost; duplicates are skipped by offset.
	events, unsubscribe := a.Ops.Hub.Subscribe(id)
	defer unsubscribe()
	revoked, cancelRevoke := a.Auth.Revocations.Subscribe(principalFrom(r.Context()).Session.ID)
	defer cancelRevoke()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(ev ops.Event) bool {
		b, _ := json.Marshal(ev)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, b); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	sent := map[string]int64{}
	steps, _ := db.ListSteps(r.Context(), a.DB.Reader, id)
	for _, s := range steps {
		send(ops.Event{Type: "step", StepID: s.ID, Name: s.Name, Status: s.Status, Error: s.ErrorMessage})
		if s.LogPath == "" {
			continue
		}
		f, err := os.Open(filepath.Join(a.Ops.DataDir, s.LogPath))
		if err != nil {
			continue
		}
		buf := make([]byte, 32<<10)
		var off int64
		for {
			n, err := f.Read(buf)
			if n > 0 {
				if !send(ops.Event{Type: "log", StepID: s.ID, Offset: off, Data: string(buf[:n])}) {
					f.Close()
					return
				}
				off += int64(n)
			}
			if err == io.EOF || err != nil {
				break
			}
		}
		f.Close()
		sent[s.ID] = off
	}
	switch t.Status {
	case db.TaskPending, db.TaskRunning:
	default:
		send(ops.Event{Type: "done", Status: t.Status, Error: t.ErrorMessage})
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-revoked:
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev, ok := <-events:
			if !ok {
				// Finished (or we were too slow): report the final state.
				if cur, err := db.GetTask(r.Context(), a.DB.Reader, id); err == nil {
					send(ops.Event{Type: "done", Status: cur.Status, Error: cur.ErrorMessage})
				}
				return
			}
			if ev.Type == "log" {
				end := ev.Offset + int64(len(ev.Data))
				if end <= sent[ev.StepID] {
					continue
				}
				if ev.Offset < sent[ev.StepID] {
					ev.Data = ev.Data[sent[ev.StepID]-ev.Offset:]
					ev.Offset = sent[ev.StepID]
				}
				sent[ev.StepID] = end
			}
			if !send(ev) {
				return
			}
			if ev.Type == "done" {
				return
			}
		}
	}
}
