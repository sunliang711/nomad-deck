package workbench

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNomadWebSocketTLSAfterHTTP2(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/warmup" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if err := conn.WriteMessage(websocket.TextMessage, []byte(r.Proto)); err != nil {
			t.Errorf("write protocol: %v", err)
		}
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	client := srv.Client()
	transport := client.Transport.(*http.Transport)
	transport.TLSClientConfig.RootCAs = pool
	transport.ForceAttemptHTTP2 = true
	resp, err := client.Get(srv.URL + "/warmup")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.ProtoMajor != 2 {
		t.Fatalf("warmup protocol: %s", resp.Proto)
	}
	dialer := nomadWebSocketDialer(client)
	if !strings.Contains(strings.Join(transport.TLSClientConfig.NextProtos, ","), "h2") {
		t.Fatal("HTTP transport ALPN was modified")
	}
	conn, _, err := dialer.Dial("wss"+strings.TrimPrefix(srv.URL, "https"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, protocol, err := conn.ReadMessage()
	if err != nil || string(protocol) != "HTTP/1.1" {
		t.Fatalf("WebSocket protocol: %q, error: %v", protocol, err)
	}
}

func runningAlloc(t *testing.T, s *Service, clusterID, job string) string {
	t.Helper()
	for i := 0; i < 60; i++ {
		raw, err := s.JobView(context.Background(), clusterID, "default", job, "allocations")
		if err != nil {
			t.Fatal(err)
		}
		var allocs []struct {
			ID           string `json:"ID"`
			ClientStatus string `json:"ClientStatus"`
		}
		_ = json.Unmarshal(raw, &allocs)
		for _, a := range allocs {
			if a.ClientStatus == "running" {
				return a.ID
			}
		}
		time.Sleep(time.Second)
	}
	t.Fatal("allocation not running")
	return ""
}

func TestFilesLogsAndTerminal(t *testing.T) {
	s, dev := setup(t)
	ctx := context.Background()
	id := dev.Cluster.ID
	job := sleeper("echo")
	task := job["TaskGroups"].([]any)[0].(map[string]any)["Tasks"].([]any)[0].(map[string]any)
	task["Actions"] = []any{map[string]any{"Name": "hello", "Command": "/bin/echo", "Args": []string{"action-ok"}}}
	task["Config"] = map[string]any{"command": "/bin/sh", "args": []string{"-c", "echo line-one; echo line-two; echo oops 1>&2; sleep 3600"}}
	register(t, dev, job)
	allocID := runningAlloc(t, s, id, "echo")

	// Files: listing, secrets refusal, preview and download.
	root, err := s.ListFiles(ctx, id, allocID, "/")
	if err != nil || len(root) == 0 {
		t.Fatalf("ls: %+v %v", root, err)
	}
	taskDir, err := s.ListFiles(ctx, id, allocID, "/t")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range taskDir {
		seen[f.Name] = true
	}
	if !seen["secrets"] || !seen["local"] {
		t.Fatalf("task dir: %+v", taskDir)
	}
	if _, err := s.ReadFile(ctx, actor, id, allocID, "/t/../t/secrets/vault_token", 0, 10); code(err) != "secrets_unreadable" {
		t.Fatalf("secrets must not be readable: %v", err)
	}
	if _, err := s.ListFiles(ctx, id, "not-a-uuid", "/"); err == nil {
		t.Fatal("alloc id is validated")
	}
	var logFile string
	for i := 0; i < 30 && logFile == ""; i++ {
		logs, _ := s.ListFiles(ctx, id, allocID, "/alloc/logs")
		for _, f := range logs {
			if strings.HasPrefix(f.Name, "t.stdout.") && f.Size >= int64(len("line-one\nline-two\n")) {
				logFile = "/alloc/logs/" + f.Name
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if logFile == "" {
		t.Fatal("stdout log file missing")
	}
	b, err := s.ReadFile(ctx, actor, id, allocID, logFile, 5, 3)
	if err != nil || string(b) != "one" {
		t.Fatalf("readat: %q %v", b, err)
	}
	var sb strings.Builder
	if err := s.DownloadFile(ctx, actor, id, allocID, logFile, &sb); err != nil || sb.String() != "line-one\nline-two\n" {
		t.Fatalf("download: %q %v", sb.String(), err)
	}
	if _, err := s.StatFile(ctx, id, allocID, logFile); err != nil {
		t.Fatal(err)
	}

	// Logs: whole stream, tail and follow.
	var all []byte
	for i := 0; i < 20 && string(all) != "oops\n"; i++ {
		rc, err := s.Logs(ctx, id, allocID, LogInput{Task: "t", Type: "stderr"})
		if err != nil {
			t.Fatal(err)
		}
		all, _ = io.ReadAll(rc)
		rc.Close()
		time.Sleep(200 * time.Millisecond)
	}
	if string(all) != "oops\n" {
		t.Fatalf("stderr: %q", all)
	}
	rc, _ := s.Logs(ctx, id, allocID, LogInput{Task: "t", Type: "stdout", Tail: 9})
	all, _ = io.ReadAll(rc)
	rc.Close()
	if string(all) != "line-two\n" {
		t.Fatalf("tail: %q", all)
	}
	fctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	rc, err = s.Logs(fctx, id, allocID, LogInput{Task: "t", Type: "stdout", Follow: true})
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, _ := io.ReadAtLeast(rc, buf, len("line-one\nline-two\n"))
	if string(buf[:n]) != "line-one\nline-two\n" {
		t.Fatalf("follow: %q", buf[:n])
	}
	rc.Close()
	cancel()
	if _, err := s.Logs(ctx, id, allocID, LogInput{Task: "t", Type: "both"}); err == nil {
		t.Fatal("log type is validated")
	}

	// Terminal: tickets are single use and bound to the session.
	if _, err := s.IssueTicket(ctx, "s1", "a1", id, allocID, TicketInput{Task: "missing"}); code(err) != "task_not_running" {
		t.Fatalf("unknown task: %v", err)
	}
	tk, err := s.IssueTicket(ctx, "s1", "a1", id, allocID, TicketInput{Task: "t", Command: []string{"/bin/sh", "-c", "echo exec-$((40+2))"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RedeemTicket(tk.ID, "s2", "a1", id, allocID); code(err) != "ticket_invalid" {
		t.Fatalf("foreign session: %v", err)
	}
	if _, err := s.RedeemTicket(tk.ID, "s1", "a1", id, allocID); code(err) != "ticket_invalid" {
		t.Fatalf("a rejected ticket is consumed too: %v", err)
	}
	tk, _ = s.IssueTicket(ctx, "s1", "a1", id, allocID, TicketInput{Task: "t", Command: []string{"/bin/sh", "-c", "echo exec-$((40+2))"}})
	redeemed, err := s.RedeemTicket(tk.ID, "s1", "a1", id, allocID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RedeemTicket(tk.ID, "s1", "a1", id, allocID); code(err) != "ticket_invalid" {
		t.Fatalf("reuse: %v", err)
	}
	out, exitCode := relayOnce(t, s, redeemed)
	if !strings.Contains(out, "exec-42") || exitCode != 0 {
		t.Fatalf("exec output %q exit %d", out, exitCode)
	}
	// The slot is released once the relay ends (after its end is audited).
	waitReleased(t, s, "s1")
	// Job actions use the same ticket and relay path.
	tk, err = s.IssueTicket(ctx, "s1", "a1", id, allocID, TicketInput{Task: "t", Action: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	redeemed, _ = s.RedeemTicket(tk.ID, "s1", "a1", id, allocID)
	if out, code := relayOnce(t, s, redeemed); !strings.Contains(out, "action-ok") || code != 0 {
		t.Fatalf("action output %q exit %d", out, code)
	}
	if _, err := s.IssueTicket(ctx, "s1", "a1", id, allocID, TicketInput{Task: "t", Action: "bad name"}); err == nil {
		t.Fatal("action name is validated")
	}
	waitReleased(t, s, "s1")
	// Only start and end are audited, never the terminal I/O.
	rows, err := dev.DB.Reader.Query(`SELECT action, request_summary_json FROM audit_logs WHERE action LIKE 'nomad.exec_%' ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for rows.Next() {
		var a, sum string
		_ = rows.Scan(&a, &sum)
		actions = append(actions, a)
		if strings.Contains(sum, "exec-42") {
			t.Fatal("terminal output must not be audited")
		}
	}
	rows.Close()
	if strings.Join(actions, ",") != "nomad.exec_start,nomad.exec_end,nomad.exec_start,nomad.exec_end" {
		t.Fatalf("exec audit: %v", actions)
	}
	// Per-session terminal limit.
	for i := 0; i < MaxTerminals; i++ {
		tk, _ := s.IssueTicket(ctx, "s3", "a1", id, allocID, TicketInput{Task: "t"})
		if _, err := s.RedeemTicket(tk.ID, "s3", "a1", id, allocID); err != nil {
			t.Fatal(err)
		}
	}
	tk, _ = s.IssueTicket(ctx, "s3", "a1", id, allocID, TicketInput{Task: "t"})
	if _, err := s.RedeemTicket(tk.ID, "s3", "a1", id, allocID); code(err) != "too_many_terminals" {
		t.Fatalf("limit: %v", err)
	}
}

// relayOnce runs a redeemed ticket through Relay and collects stdout until
// the command exits.
func relayOnce(t *testing.T, s *Service, redeemed *Ticket) (string, int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := websocket.Upgrader{}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.Relay(r.Context(), actor, redeemed, conn, make(chan struct{}))
	}))
	defer srv.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	var out strings.Builder
	exitCode := -1
	for exitCode < 0 {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("relay ended early (%q): %v", out.String(), err)
		}
		var f struct {
			Stdout *struct {
				Data string `json:"data"`
			} `json:"stdout"`
			Exited bool `json:"exited"`
			Result *struct {
				ExitCode int `json:"exit_code"`
			} `json:"result"`
			Error string `json:"error"`
		}
		_ = json.Unmarshal(msg, &f)
		if f.Error != "" {
			t.Fatalf("relay error: %s", f.Error)
		}
		if f.Stdout != nil {
			d, _ := base64.StdEncoding.DecodeString(f.Stdout.Data)
			out.Write(d)
		}
		if f.Exited {
			exitCode = 0
			if f.Result != nil {
				exitCode = f.Result.ExitCode
			}
		}
	}
	return out.String(), exitCode
}

func waitReleased(t *testing.T, s *Service, session string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		s.execs().mu.Lock()
		n := s.execs().sessions[session]
		s.execs().mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("terminal slot not released")
}
