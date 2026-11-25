package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/workbench"
)

func (a *API) allocFiles(w http.ResponseWriter, r *http.Request) {
	clusterID, allocID := chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id")
	p := r.URL.Query().Get("path")
	switch chi.URLParam(r, "op") {
	case "ls":
		out, err := a.Workbench.ListFiles(r.Context(), clusterID, allocID, p)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"files": out})
	case "stat":
		raw, err := a.Workbench.StatFile(r.Context(), clusterID, allocID, p)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		writeRaw(w, "file", raw)
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的操作")
	}
}

// allocFileContent serves file contents (admin only): readat for preview,
// download for the whole file.
func (a *API) allocFileContent(w http.ResponseWriter, r *http.Request) {
	clusterID, allocID := chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id")
	q := r.URL.Query()
	p := q.Get("path")
	switch chi.URLParam(r, "op") {
	case "readat":
		offset, _ := strconv.ParseInt(q.Get("offset"), 10, 64)
		limit, _ := strconv.ParseInt(q.Get("limit"), 10, 64)
		b, err := a.Workbench.ReadFile(r.Context(), a.actor(r), clusterID, allocID, p, offset, limit)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)
	case "download":
		name := p[strings.LastIndex(p, "/")+1:]
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", strings.ReplaceAll(name, `"`, "_")))
		w.Header().Set("Cache-Control", "no-store")
		if err := a.Workbench.DownloadFile(r.Context(), a.actor(r), clusterID, allocID, p, w); err != nil {
			a.writeErr(w, r, err)
		}
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的操作")
	}
}

func logInput(r *http.Request, follow bool) workbench.LogInput {
	q := r.URL.Query()
	in := workbench.LogInput{Task: q.Get("task"), Type: q.Get("type"), Follow: follow}
	if in.Type == "" {
		in.Type = "stdout"
	}
	in.Tail, _ = strconv.ParseInt(q.Get("tail"), 10, 64)
	if in.Tail < 0 || in.Tail > 16<<20 {
		in.Tail = 0
	}
	return in
}

// allocLogStream streams task logs over SSE (optionally only lines
// containing a keyword) until the client goes away or the session is revoked.
func (a *API) allocLogStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no_stream", "当前连接不支持流式输出")
		return
	}
	in := logInput(r, r.URL.Query().Get("follow") != "false")
	if in.Tail == 0 && in.Follow {
		in.Tail = 32 << 10
	}
	body, err := a.Workbench.Logs(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	defer body.Close()
	revoked, cancel := a.Auth.Revocations.Subscribe(principalFrom(r.Context()).Session.ID)
	defer cancel()
	go func() {
		select {
		case <-revoked:
			body.Close()
		case <-r.Context().Done():
		}
	}()
	filter := r.URL.Query().Get("filter")
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	send := func(s string) bool {
		b, _ := json.Marshal(s)
		if _, err := fmt.Fprintf(w, "event: log\ndata: %s\n\n", b); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	lines := make(chan string, 256)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(body)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	var batch []string
	flush := time.NewTicker(200 * time.Millisecond)
	defer flush.Stop()
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
		case <-flush.C:
			if len(batch) > 0 {
				if !send(strings.Join(batch, "\n") + "\n") {
					return
				}
				batch = nil
			}
		case l, ok := <-lines:
			if !ok {
				if len(batch) > 0 {
					send(strings.Join(batch, "\n") + "\n")
				}
				_, _ = io.WriteString(w, "event: end\ndata: {}\n\n")
				flusher.Flush()
				return
			}
			if filter == "" || strings.Contains(l, filter) {
				batch = append(batch, l)
			}
		}
	}
}

func (a *API) allocLogDownload(w http.ResponseWriter, r *http.Request) {
	in := logInput(r, false)
	body, err := a.Workbench.Logs(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", chi.URLParam(r, "alloc_id")[:8]+"-"+in.Task+"."+in.Type+".log"))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, body)
}

func (a *API) execTicket(w http.ResponseWriter, r *http.Request) {
	var in workbench.TicketInput
	if !decodeJSON(w, r, &in) {
		return
	}
	p := principalFrom(r.Context())
	t, err := a.Workbench.IssueTicket(r.Context(), p.Session.ID, p.Admin.ID, chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ticket": t.ID, "expires_at": t.ExpiresAt})
}

// execTerminal upgrades to WebSocket after checking the Origin against the
// public origin, redeeming the ticket for this session and re-checking the
// admin role and the cluster's terminal switch.
func (a *API) execTerminal(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	if !p.IsAdmin() {
		a.writeErr(w, r, auth.ErrForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); !a.AllowedOrigins[strings.ToLower(origin)] {
		writeError(w, http.StatusForbidden, "origin_rejected", "终端连接的来源不受信任")
		return
	}
	clusterID, allocID := chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id")
	if ok, err := a.Nomad.ExecAllowed(r.Context(), clusterID); err != nil || !ok {
		writeError(w, http.StatusForbidden, "exec_disabled", "该集群已关闭交互式终端")
		return
	}
	t, err := a.Workbench.RedeemTicket(r.URL.Query().Get("ticket"), p.Session.ID, p.Admin.ID, clusterID, allocID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return a.AllowedOrigins[strings.ToLower(r.Header.Get("Origin"))] },
		ReadBufferSize: 16 << 10, WriteBufferSize: 16 << 10}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		a.Workbench.ReleaseTerminal(p.Session.ID)
		return
	}
	revoked, cancel := a.Auth.Revocations.Subscribe(p.Session.ID)
	defer cancel()
	a.Workbench.Relay(r.Context(), a.actor(r), t, conn, revoked)
}
