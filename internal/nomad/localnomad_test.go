package nomad

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/pki"
)

// localServer runs a real single-node Nomad server on 127.0.0.1 with TLS
// and ACLs, rendered by RenderFiles. Skipped without a nomad binary or
// with -short.
type localServer struct {
	t      *testing.T
	dir    string
	caPEM  string
	http   int
	cmd    *exec.Cmd
	log    *bytes.Buffer
	gossip string
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func startLocalServer(t *testing.T) *localServer {
	if testing.Short() {
		t.Skip("skipping real Nomad test in -short mode")
	}
	bin, err := exec.LookPath("nomad")
	if err != nil {
		t.Skip("nomad binary not found")
	}
	dir, err := os.MkdirTemp("", "ndn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	now := time.Now()
	caM, _ := pki.NewCA("local nomad CA", pki.CATTL, now)
	ca, _ := pki.ParseCA(caM.CertPEM, caM.KeyPEM)
	leaf, err := ca.Issue(pki.Request{CommonName: "server.global.nomad",
		Hosts: []string{"server.global.nomad", "localhost", "127.0.0.1"}}, now)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := GenerateGossipKey()
	ls := &localServer{t: t, dir: dir, caPEM: caM.CertPEM, http: freePort(t), log: &bytes.Buffer{}, gossip: key}
	cfg := NodeConfig{Region: "global", Datacenter: "dc1", NodeName: "local1", Role: RoleServer, Advertise: "127.0.0.1",
		HTTPPort: ls.http, RPCPort: freePort(t), SerfPort: freePort(t), Generation: 1, Servers: []string{"127.0.0.1"},
		BootstrapN: 1, GossipKey: key, TLS: true, Telemetry: true}
	files, err := RenderFiles(cfg)
	if err != nil {
		t.Fatal(err)
	}
	cdir := filepath.Join(dir, "conf")
	os.MkdirAll(filepath.Join(cdir, "tls"), 0o700)
	files = append(files, GenerationFile{Name: "tls/ca.pem", Content: []byte(caM.CertPEM)},
		GenerationFile{Name: "tls/agent.pem", Content: []byte(leaf.CertPEM)},
		GenerationFile{Name: "tls/agent-key.pem", Content: []byte(leaf.KeyPEM)})
	for _, f := range files {
		c := strings.ReplaceAll(string(f.Content), GenerationDir(1), cdir)
		c = strings.ReplaceAll(c, DataDir, filepath.Join(dir, "data"))
		c = strings.ReplaceAll(c, `bind_addr  = "0.0.0.0"`, `bind_addr  = "127.0.0.1"`)
		if err := os.WriteFile(filepath.Join(cdir, f.Name), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ls.cmd = exec.Command(bin, "agent", "-config", cdir)
	ls.cmd.Stdout, ls.cmd.Stderr = ls.log, ls.log
	if err := ls.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ls.cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _ = ls.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = ls.cmd.Process.Kill()
		}
		if t.Failed() {
			t.Logf("nomad log:\n%s", ls.log.String())
		}
	})
	return ls
}

func (ls *localServer) addr() string { return fmt.Sprintf("https://127.0.0.1:%d", ls.http) }

func (ls *localServer) client(token string) *Client {
	c, err := NewClient(ls.addr(), ls.caPEM, token, nil, 10*time.Second)
	if err != nil {
		ls.t.Fatal(err)
	}
	return c
}

func (ls *localServer) waitLeader(ctx context.Context) {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if l, err := ls.client("").Leader(ctx); err == nil && l != "" {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	ls.t.Fatal("no leader")
}

func TestLocalNomadProtocol(t *testing.T) {
	ls := startLocalServer(t)
	ctx := context.Background()
	ls.waitLeader(ctx)
	anon := ls.client("")
	if h, err := anon.Health(ctx); err != nil || h.Server == nil {
		t.Fatalf("health: %+v %v", h, err)
	}
	if _, err := anon.RaftConfiguration(ctx); StatusOf(err) != 403 {
		t.Fatalf("anonymous raft configuration should be denied, got %v", err)
	}
	secret, _ := newUUID()
	if _, err := anon.WithToken(secret).TokenSelf(ctx); err == nil {
		t.Fatal("token/self before bootstrap should fail")
	}
	tok, err := anon.Bootstrap(ctx, secret)
	if err != nil {
		t.Fatal(err)
	}
	if tok.SecretID != secret || tok.Type != "management" {
		t.Fatalf("bootstrap token %+v", tok)
	}
	// A second bootstrap reports the reset index.
	_, err = anon.Bootstrap(ctx, secret)
	var done *ErrBootstrapDone
	if !errors.As(err, &done) || done.ResetIndex == 0 {
		t.Fatalf("second bootstrap: %v", err)
	}
	mgmt := ls.client(secret)
	self, err := mgmt.TokenSelf(ctx)
	if err != nil || self.Type != "management" {
		t.Fatalf("token self: %+v %v", self, err)
	}
	ag, err := mgmt.Self(ctx)
	if err != nil || ag.Version == "" || !ag.Server {
		t.Fatalf("agent self: %+v %v", ag, err)
	}
	raft, err := mgmt.RaftConfiguration(ctx)
	if err != nil || len(raft) != 1 || !raft[0].Leader || !raft[0].Voter {
		t.Fatalf("raft: %+v %v", raft, err)
	}
	ap, err := mgmt.Autopilot(ctx)
	if err != nil || len(ap.Servers) != 1 || ap.FailureTolerance != 0 {
		t.Fatalf("autopilot: %+v %v", ap, err)
	}
	t.Logf("autopilot server: %+v", ap.Servers[0])
	// Gossip keyring rotation without restart.
	keys, _, err := mgmt.KeyringList(ctx)
	if err != nil || keys[ls.gossip] == 0 {
		t.Fatalf("keyring list: %v %v", keys, err)
	}
	nk, _ := GenerateGossipKey()
	for _, op := range []string{"install", "use"} {
		if err := mgmt.KeyringOp(ctx, op, nk); err != nil {
			t.Fatal(op, err)
		}
	}
	if err := mgmt.KeyringOp(ctx, "remove", ls.gossip); err != nil {
		t.Fatal(err)
	}
	keys, _, _ = mgmt.KeyringList(ctx)
	if len(keys) != 1 || keys[nk] == 0 {
		t.Fatalf("keyring after rotation: %v", keys)
	}
	var buf bytes.Buffer
	n, err := mgmt.SnapshotSave(ctx, &buf)
	if err != nil || n == 0 {
		t.Fatalf("snapshot: %d %v", n, err)
	}
	if err := mgmt.SnapshotRestore(ctx, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatalf("snapshot restore: %v", err)
	}
	var ns map[string]any
	if err := mgmt.Request(ctx, "GET", "namespace/default", nil, &ns); err != nil {
		t.Fatal(err)
	}
}
