package jobs

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
)

// env runs a real Nomad dev agent (server and client, ACLs on, raw_exec)
// on free ports and wires the job center to it through a cluster record.
type env struct {
	t      *testing.T
	s      *Service
	cl     *db.Cluster
	token  string
	addr   string
	caller Caller
	nomad  *nomad.Service
	logBuf *bytes.Buffer
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func newEnv(t *testing.T) *env {
	if testing.Short() {
		t.Skip("skipping real Nomad test in -short mode")
	}
	bin, err := exec.LookPath("nomad")
	if err != nil {
		t.Skip("nomad binary not found")
	}
	dir := t.TempDir()
	http, rpc, serf := freePort(t), freePort(t), freePort(t)
	cfg := fmt.Sprintf(`ports {
  http = %d
  rpc  = %d
  serf = %d
}
acl {
  enabled = true
}
plugin "raw_exec" {
  config {
    enabled = true
  }
}
client {
  cpu_total_compute = 4000
}
`, http, rpc, serf)
	if err := os.WriteFile(filepath.Join(dir, "agent.hcl"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	logBuf := &bytes.Buffer{}
	cmd := exec.Command(bin, "agent", "-dev", "-config", filepath.Join(dir, "agent.hcl"), "-bind", "127.0.0.1", "-network-interface", "lo0")
	cmd.Stdout, cmd.Stderr = logBuf, logBuf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = cmd.Process.Kill()
		}
		if t.Failed() {
			t.Logf("nomad log tail:\n%s", tail(logBuf.String(), 4000))
		}
	})
	addr := "http://127.0.0.1:" + strconv.Itoa(http)
	ctx := context.Background()
	anon, _ := nomad.NewClient(addr, "", "", nil, 5*time.Second)
	deadline := time.Now().Add(60 * time.Second)
	for {
		if l, err := anon.Leader(ctx); err == nil && l != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no leader")
		}
		time.Sleep(300 * time.Millisecond)
	}
	tok, err := anon.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{3}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := ops.NewEngine(d, log, dir)
	t.Cleanup(engine.Wait)
	rec := &audit.Recorder{DB: d, Log: log}
	ns := &nomad.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, DataDir: dir, Log: log}
	now := time.Now()
	enc, _ := keys.EncryptString(tok.SecretID, "")
	c := &db.Cluster{ID: db.NewID(), Name: "dev", Type: "nomad", Mode: "single", Region: "global", Datacenter: "dc1", TLSEnabled: false,
		ConfigJSON: fmt.Sprintf(`{"http_port":%d}`, http), InitState: db.InitInitialized, CreatedAt: now, UpdatedAt: now}
	err = d.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			return err
		}
		enc, _ = keys.EncryptString(tok.SecretID, db.ClusterAdminTokenAAD(c.ID))
		if err := db.SetClusterAdminToken(ctx, tx, c.ID, enc, db.InitInitialized, now); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
			VALUES ('k', 'k', 'ed25519', 'x', 'x', 'x', 1, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, created_at, updated_at) VALUES ('h1', 'dev', '127.0.0.1', 'root', 'k', ?, ?)`,
			db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		return db.InsertClusterNode(ctx, tx, &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "nomad", NodeID: "h1",
			Role: nomad.RoleServerClient, AdvertiseAddr: "127.0.0.1", APIAddr: addr, InstallState: "installed",
			NodeConfigJSON: `{"node_name":"dev"}`, CreatedAt: now, UpdatedAt: now})
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{DB: d, Keys: keys, Audit: rec, Ops: engine, Nomad: ns, Log: log}
	s.Init()
	return &env{t: t, s: s, cl: c, token: tok.SecretID, addr: addr, nomad: ns, logBuf: logBuf,
		caller: Caller{Actor: audit.Actor{ID: "admin1", Name: "root"}, SessionID: "sess1", IsAdmin: true}}
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func (e *env) raw() *nomad.Client {
	c, _ := nomad.NewClient(e.addr, "", e.token, nil, 10*time.Second)
	return c
}
