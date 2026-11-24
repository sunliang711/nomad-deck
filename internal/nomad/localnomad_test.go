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

// localServer runs a real Nomad server on 127.0.0.1 with TLS and ACLs,
// rendered by RenderFiles. Skipped without a nomad binary or with -short.
type localServer struct {
	t      *testing.T
	name   string
	bin    string
	dir    string
	caPEM  string
	http   int
	rpc    int
	serf   int
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

func startLocalServer(t *testing.T) *localServer { return startLocalCluster(t, 1)[0] }

// startLocalCluster starts size servers that join each other over gossip.
func startLocalCluster(t *testing.T, size int) []*localServer {
	if testing.Short() {
		t.Skip("skipping real Nomad test in -short mode")
	}
	bin, err := exec.LookPath("nomad")
	if err != nil {
		t.Skip("nomad binary not found")
	}
	now := time.Now()
	caM, _ := pki.NewCA("local nomad CA", pki.CATTL, now)
	ca, _ := pki.ParseCA(caM.CertPEM, caM.KeyPEM)
	key, _ := GenerateGossipKey()
	var out []*localServer
	for i := 0; i < size; i++ {
		dir, err := os.MkdirTemp("", "ndn")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		out = append(out, &localServer{t: t, name: fmt.Sprintf("local%d", i+1), bin: bin, dir: dir, caPEM: caM.CertPEM,
			http: freePort(t), rpc: freePort(t), serf: freePort(t), log: &bytes.Buffer{}, gossip: key})
	}
	var join []string
	for _, ls := range out {
		join = append(join, fmt.Sprintf("%q", fmt.Sprintf("127.0.0.1:%d", ls.serf)))
	}
	for _, ls := range out {
		leaf, err := ca.Issue(pki.Request{CommonName: "server.global.nomad",
			Hosts: []string{"server.global.nomad", "localhost", "127.0.0.1"}}, now)
		if err != nil {
			t.Fatal(err)
		}
		cfg := NodeConfig{Region: "global", Datacenter: "dc1", NodeName: ls.name, Role: RoleServer, Advertise: "127.0.0.1",
			HTTPPort: ls.http, RPCPort: ls.rpc, SerfPort: ls.serf, Generation: 1, Servers: []string{"127.0.0.1"},
			BootstrapN: size, GossipKey: key, TLS: true, Telemetry: true}
		files, err := RenderFiles(cfg)
		if err != nil {
			t.Fatal(err)
		}
		cdir := filepath.Join(ls.dir, "conf")
		os.MkdirAll(filepath.Join(cdir, "tls"), 0o700)
		files = append(files, GenerationFile{Name: "tls/ca.pem", Content: []byte(caM.CertPEM)},
			GenerationFile{Name: "tls/agent.pem", Content: []byte(leaf.CertPEM)},
			GenerationFile{Name: "tls/agent-key.pem", Content: []byte(leaf.KeyPEM)})
		for _, f := range files {
			c := strings.ReplaceAll(string(f.Content), GenerationDir(1), cdir)
			c = strings.ReplaceAll(c, DataDir, filepath.Join(ls.dir, "data"))
			c = strings.ReplaceAll(c, `bind_addr  = "0.0.0.0"`, `bind_addr  = "127.0.0.1"`)
			if f.Name == "10-base.hcl" && size > 1 {
				c = strings.Replace(c, "\n}\n\nacl {", "\n  server_join {\n    retry_join = ["+strings.Join(join, ", ")+"]\n  }\n}\n\nacl {", 1)
			}
			if err := os.WriteFile(filepath.Join(cdir, f.Name), []byte(c), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		ls.start()
		t.Cleanup(func() {
			ls.stop()
			if t.Failed() {
				t.Logf("%s log:\n%s", ls.name, ls.log.String())
			}
		})
	}
	return out
}

func (ls *localServer) start() {
	ls.cmd = exec.Command(ls.bin, "agent", "-config", filepath.Join(ls.dir, "conf"))
	ls.cmd.Stdout, ls.cmd.Stderr = ls.log, ls.log
	if err := ls.cmd.Start(); err != nil {
		ls.t.Fatal(err)
	}
}

func (ls *localServer) stop() {
	if ls.cmd == nil || ls.cmd.Process == nil {
		return
	}
	_ = ls.cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _ = ls.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		_ = ls.cmd.Process.Kill()
	}
	ls.cmd = nil
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
