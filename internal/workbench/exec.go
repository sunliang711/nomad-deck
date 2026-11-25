package workbench

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

// Terminal limits.
const (
	TicketTTL          = 30 * time.Second
	MaxTerminals       = 5
	TerminalIdle       = 15 * time.Minute
	TerminalMaxRuntime = 4 * time.Hour
)

// Ticket is a one-time authorization to open a terminal or run an action.
type Ticket struct {
	ID        string
	SessionID string
	AdminID   string
	ClusterID string
	AllocID   string
	Task      string
	Command   []string
	Action    string
	JobID     string
	Namespace string
	Group     string
	ExpiresAt time.Time
}

type execState struct {
	mu       sync.Mutex
	tickets  map[string]*Ticket
	sessions map[string]int
}

func (s *Service) execs() *execState {
	s.execOnce.Do(func() {
		s.exec = &execState{tickets: map[string]*Ticket{}, sessions: map[string]int{}}
	})
	return s.exec
}

// TicketInput requests a terminal (command) or a job action.
type TicketInput struct {
	Task    string   `json:"task"`
	Command []string `json:"command"`
	Action  string   `json:"action"`
}

var reAction = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)

// IssueTicket checks the cluster allows terminals and the allocation runs
// the task, and returns a single-use ticket bound to the session.
func (s *Service) IssueTicket(ctx context.Context, sessionID, adminID, clusterID, allocID string, in TicketInput) (*Ticket, error) {
	if err := validUUID(allocID); err != nil {
		return nil, err
	}
	if ok, err := s.Nomad.ExecAllowed(ctx, clusterID); err != nil {
		return nil, err
	} else if !ok {
		return nil, &auth.Error{Status: 403, Code: "exec_disabled", Message: "该集群已关闭交互式终端"}
	}
	if !reTask.MatchString(in.Task) {
		return nil, badRequest("Task 名称不合法")
	}
	if in.Action != "" && !reAction.MatchString(in.Action) {
		return nil, badRequest("Action 名称不合法")
	}
	if in.Action == "" {
		if len(in.Command) == 0 {
			in.Command = []string{"/bin/sh"}
		}
		if len(in.Command) > 32 {
			return nil, badRequest("命令参数过多")
		}
		for _, a := range in.Command {
			if a == "" || len(a) > 4096 || strings.ContainsRune(a, 0) {
				return nil, badRequest("命令参数不合法")
			}
		}
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var alloc struct {
		JobID        string `json:"JobID"`
		Namespace    string `json:"Namespace"`
		TaskGroup    string `json:"TaskGroup"`
		ClientStatus string `json:"ClientStatus"`
		TaskStates   map[string]struct {
			State string `json:"State"`
		} `json:"TaskStates"`
	}
	if err := c.Request(ctx, "GET", "allocation/"+allocID, nil, &alloc); err != nil {
		return nil, nomadErr(err)
	}
	if alloc.ClientStatus != "running" || alloc.TaskStates[in.Task].State != "running" {
		return nil, conflict("task_not_running", "Task %s 未在运行", in.Task)
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	t := &Ticket{ID: hex.EncodeToString(b), SessionID: sessionID, AdminID: adminID, ClusterID: clusterID, AllocID: allocID,
		Task: in.Task, Command: in.Command, Action: in.Action, JobID: alloc.JobID, Namespace: alloc.Namespace, Group: alloc.TaskGroup,
		ExpiresAt: time.Now().Add(TicketTTL)}
	st := s.execs()
	st.mu.Lock()
	for id, x := range st.tickets {
		if time.Now().After(x.ExpiresAt) {
			delete(st.tickets, id)
		}
	}
	st.tickets[t.ID] = t
	st.mu.Unlock()
	return t, nil
}

// RedeemTicket consumes a ticket for the session that requested it.
func (s *Service) RedeemTicket(id, sessionID, adminID, clusterID, allocID string) (*Ticket, error) {
	st := s.execs()
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.tickets[id]
	delete(st.tickets, id)
	switch {
	case t == nil || time.Now().After(t.ExpiresAt):
		return nil, &auth.Error{Status: 403, Code: "ticket_invalid", Message: "终端票据无效、已使用或已过期"}
	case t.SessionID != sessionID || t.AdminID != adminID || t.ClusterID != clusterID || t.AllocID != allocID:
		return nil, &auth.Error{Status: 403, Code: "ticket_invalid", Message: "终端票据不属于当前会话"}
	}
	if st.sessions[sessionID] >= MaxTerminals {
		return nil, conflict("too_many_terminals", "当前会话已打开 %d 个终端", MaxTerminals)
	}
	st.sessions[sessionID]++
	return t, nil
}

func (s *Service) releaseTerminal(sessionID string) {
	st := s.execs()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.sessions[sessionID] > 0 {
		st.sessions[sessionID]--
	}
	if st.sessions[sessionID] == 0 {
		delete(st.sessions, sessionID)
	}
}

// dialNomad opens the upstream exec or action WebSocket.
func (s *Service) dialNomad(ctx context.Context, t *Ticket) (*websocket.Conn, error) {
	c, err := s.api(ctx, t.ClusterID)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(c.Addr)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	q := url.Values{"task": {t.Task}, "tty": {"true"}}
	if t.Action != "" {
		u.Path = "/v1/job/" + url.PathEscape(t.JobID) + "/action"
		q.Set("namespace", t.Namespace)
		q.Set("action", t.Action)
		q.Set("allocID", t.AllocID)
		q.Set("group", t.Group)
	} else {
		u.Path = "/v1/client/allocation/" + t.AllocID + "/exec"
		cmd, _ := json.Marshal(t.Command)
		q.Set("command", string(cmd))
	}
	u.RawQuery = q.Encode()
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	if tr, ok := c.HTTP.Transport.(*http.Transport); ok && tr.TLSClientConfig != nil {
		d.TLSClientConfig = tr.TLSClientConfig.Clone()
	} else if u.Scheme == "wss" {
		d.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	h := http.Header{}
	h.Set("X-Nomad-Token", c.Token)
	conn, resp, err := d.DialContext(ctx, u.String(), h)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("Nomad 拒绝终端连接（HTTP %d）：%w", resp.StatusCode, err)
		}
		return nil, err
	}
	return conn, nil
}

// Relay forwards frames between the browser and Nomad until either side
// closes, the session is revoked, the terminal is idle too long or reaches
// its maximum duration. Only start, end, target and duration are audited;
// keystrokes and output may hold secrets and are never recorded.
func (s *Service) Relay(ctx context.Context, actor audit.Actor, t *Ticket, browser *websocket.Conn, revoked <-chan struct{}) {
	defer s.releaseTerminal(t.SessionID)
	start := time.Now()
	target := map[string]any{"alloc": t.AllocID, "task": t.Task, "command": t.Command, "action": t.Action, "job": t.JobID}
	upstream, err := s.dialNomad(ctx, t)
	if err != nil {
		_ = browser.WriteMessage(websocket.TextMessage, mustJSON(map[string]any{"error": err.Error()}))
		_ = browser.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "upstream"))
		s.auditOp(ctx, actor, t.ClusterID, "exec_start", "alloc/"+t.AllocID, target, err)
		return
	}
	s.auditOp(ctx, actor, t.ClusterID, "exec_start", "alloc/"+t.AllocID, target, nil)
	activity := make(chan struct{}, 1)
	done := make(chan string, 2)
	pump := func(from, to *websocket.Conn, name string) {
		for {
			typ, msg, err := from.ReadMessage()
			if err != nil {
				done <- name + " closed"
				return
			}
			select {
			case activity <- struct{}{}:
			default:
			}
			if err := to.WriteMessage(typ, msg); err != nil {
				done <- name + " write failed"
				return
			}
		}
	}
	go pump(browser, upstream, "browser")
	go pump(upstream, browser, "nomad")
	idleDur := time.Duration(db.IntSetting(ctx, s.DB.Reader, "nomad.exec_idle_minutes", int(TerminalIdle/time.Minute))) * time.Minute
	if idleDur <= 0 {
		idleDur = TerminalIdle
	}
	maxDur := time.Duration(db.IntSetting(ctx, s.DB.Reader, "nomad.exec_max_minutes", int(TerminalMaxRuntime/time.Minute))) * time.Minute
	if maxDur <= 0 {
		maxDur = TerminalMaxRuntime
	}
	idle := time.NewTimer(idleDur)
	max := time.NewTimer(maxDur)
	defer idle.Stop()
	defer max.Stop()
	reason := ""
loop:
	for {
		select {
		case reason = <-done:
			break loop
		case <-activity:
			idle.Reset(idleDur)
		case <-idle.C:
			reason = "idle timeout"
			break loop
		case <-max.C:
			reason = "maximum duration"
			break loop
		case <-revoked:
			reason = "session revoked"
			break loop
		case <-ctx.Done():
			reason = "server shutdown"
			break loop
		}
	}
	msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason)
	_ = browser.WriteControl(websocket.CloseMessage, msg, time.Now().Add(time.Second))
	_ = upstream.WriteControl(websocket.CloseMessage, msg, time.Now().Add(time.Second))
	_ = browser.Close()
	_ = upstream.Close()
	target["reason"] = reason
	target["duration_seconds"] = int(time.Since(start).Seconds())
	s.auditOp(context.Background(), actor, t.ClusterID, "exec_end", "alloc/"+t.AllocID, target, nil)
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// ReleaseTerminal frees a redeemed terminal slot that was never used.
func (s *Service) ReleaseTerminal(sessionID string) { s.releaseTerminal(sessionID) }
