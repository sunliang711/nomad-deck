//go:build integration

// Integration tests against a real Linux host with systemd and sshd.
// Start one with test/linux-host and run:
//
//	ND_IT_ADDR=127.0.0.1:22222 ND_IT_USER=deck ND_IT_PASSWORD=deck-password-1 \
//	  go test -tags integration ./internal/hosts/ -v
package hosts

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

type itEnv struct {
	svc    *Service
	engine *ops.Engine
	node   *db.Node
	actor  audit.Actor
	dir    string
}

func setupIT(t *testing.T) *itEnv {
	addr := os.Getenv("ND_IT_ADDR")
	if addr == "" {
		t.Skip("ND_IT_ADDR not set")
	}
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{7}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Pool: sshx.NewPool(4), LocalMachineID: "control-plane-id"}
	t.Cleanup(svc.Pool.Close)
	actor := audit.Actor{Name: "it"}
	if _, err := svc.GenerateKey(ctx, actor, "it-key"); err != nil {
		t.Fatal(err)
	}
	n, err := svc.CreateNode(ctx, actor, NodeInput{Name: "it-node", Host: host, SSHPort: port, SSHUser: os.Getenv("ND_IT_USER"), UseSudo: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PushKey(ctx, actor, n.ID, os.Getenv("ND_IT_PASSWORD")); err != nil {
		t.Fatalf("push key: %v", err)
	}
	// Pushing twice must be idempotent.
	if err := svc.PushKey(ctx, actor, n.ID, os.Getenv("ND_IT_PASSWORD")); err != nil {
		t.Fatalf("push key again: %v", err)
	}
	n, _ = db.GetNode(ctx, d.Reader, n.ID)
	if n.HostKeyFingerprint == "" {
		t.Fatal("host key must be pinned on first connection")
	}
	return &itEnv{svc: svc, engine: ops.NewEngine(d, log, dir), node: n, actor: actor, dir: dir}
}

func TestIntegrationProbeAndIdentity(t *testing.T) {
	e := setupIT(t)
	ctx := context.Background()
	res, err := e.svc.Test(ctx, e.actor, e.node.ID)
	if err != nil {
		t.Fatal(err)
	}
	p := res.Probe
	t.Logf("probe: family=%s code=%s arch=%s sudo=%v time=%s skew=%dms docker=%s warnings=%v",
		p.OSFamily, p.OSCodename, p.Arch, p.SudoReady, p.TimeSync, p.ClockSkewMS, p.DockerMode, res.Warnings)
	if p.OSFamily != "debian" || p.OSCodename != "noble" || !p.SudoReady || p.MachineID == "" || len(p.Missing) != 0 || !p.OptWritable {
		t.Fatalf("unexpected probe: %+v", p)
	}
	n, _ := db.GetNode(ctx, e.svc.DB.Reader, e.node.ID)
	if n.Status != "online" || n.MachineID != p.MachineID {
		t.Fatalf("node not updated: %+v", n)
	}

	// The same machine registered again under another name is rejected.
	dup, err := e.svc.CreateNode(ctx, e.actor, NodeInput{Name: "dup", Host: "localhost", SSHPort: e.node.SSHPort, SSHUser: e.node.SSHUser, UseSudo: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Test(ctx, e.actor, dup.ID)
	var ae *auth.Error
	if !errors.As(err, &ae) || ae.Code != "duplicate_host" {
		t.Fatalf("expected duplicate_host, got %v", err)
	}

	// A wrong pinned fingerprint is refused.
	db.UpdateNodeHostKey(ctx, e.svc.DB.Writer, e.node.ID, "SHA256:wrong", e.svc.DB.Now())
	e.svc.Pool.Close()
	n, _ = db.GetNode(ctx, e.svc.DB.Reader, e.node.ID)
	if _, err := e.svc.Connect(ctx, n); !errors.As(err, &ae) || ae.Code != "host_key_mismatch" {
		t.Fatalf("expected host_key_mismatch, got %v", err)
	}
}

func TestIntegrationDetachedStepsSurviveDisconnect(t *testing.T) {
	e := setupIT(t)
	ctx := context.Background()
	c, err := e.svc.Connect(ctx, e.node)
	if err != nil {
		t.Fatal(err)
	}
	op := db.NewID()

	var logBuf bytes.Buffer
	r, err := sshx.RunStep(ctx, c, sshx.StepSpec{Product: "system", OpID: op, Step: "ok", Log: &logBuf, Poll: 200 * time.Millisecond,
		Script: "echo line-one\nsleep 1\necho line-two\n"})
	if err != nil || r.Status != "success" || r.ExitCode != 0 {
		t.Fatalf("step: %+v %v", r, err)
	}
	if !strings.Contains(logBuf.String(), "line-one\nline-two") {
		t.Fatalf("log: %q", logBuf.String())
	}
	r, err = sshx.RunStep(ctx, c, sshx.StepSpec{Product: "system", OpID: op, Step: "bad", Poll: 200 * time.Millisecond, Script: "exit 3\n"})
	if err != nil || r.Status != "failed" || r.ExitCode != 3 {
		t.Fatalf("failing step: %+v %v", r, err)
	}

	// Start a step, drop the control plane connection, check later.
	spec := sshx.StepSpec{Product: "system", OpID: op, Step: "detach", Script: "sleep 3\necho finished\n"}
	if _, err := sshx.StartStep(ctx, c, spec); err != nil {
		t.Fatal(err)
	}
	e.svc.Pool.Close() // simulates a control plane crash
	time.Sleep(4 * time.Second)
	c2, err := e.svc.Connect(ctx, e.node)
	if err != nil {
		t.Fatal(err)
	}
	r, err = sshx.CheckStep(ctx, c2, spec)
	if err != nil || r.Status != "success" {
		t.Fatalf("detached step must complete after disconnect: %+v %v", r, err)
	}

	// A step whose unit is killed is reported as interrupted.
	kill := sshx.StepSpec{Product: "system", OpID: op, Step: "kill", Script: "sleep 60\n"}
	unit, err := sshx.StartStep(ctx, c2, kill)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	if _, err := c2.Run(ctx, "systemctl kill --signal=KILL "+unit, sshx.RunOptions{Sudo: true}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	r, err = sshx.CheckStep(ctx, c2, kill)
	if err != nil || r.Status != "interrupted" {
		t.Fatalf("killed step: %+v %v", r, err)
	}
	for _, s := range []string{"ok", "bad", "detach", "kill"} {
		sshx.CleanupStep(ctx, c2, "system", op, s)
	}
}

func TestIntegrationInstallVerifiesDigest(t *testing.T) {
	e := setupIT(t)
	ctx := context.Background()
	c, err := e.svc.Connect(ctx, e.node)
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("nomad-deck relay payload\n"), 4096)
	sum := sha256.Sum256(payload)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(payload)
	zw.Close()
	gzPath := filepath.Join(e.dir, "payload.gz")
	os.WriteFile(gzPath, gz.Bytes(), 0o600)
	a := &release.Artifact{PayloadName: "payload", PayloadSHA256: hex.EncodeToString(sum[:]), GzipPath: gzPath, Gzipped: true}
	op := db.NewID()
	if err := e.svc.InstallArtifact(ctx, c, op, a, "/opt/nomad-deck/test/payload", "0644", 256<<10); err != nil {
		t.Fatal(err)
	}
	out, err := c.Run(ctx, "sha256sum /opt/nomad-deck/test/payload | cut -d' ' -f1; stat -c %a /opt/nomad-deck/test/payload", sshx.RunOptions{Sudo: true})
	if err != nil || !strings.HasPrefix(string(out.Stdout), a.PayloadSHA256) || !strings.Contains(string(out.Stdout), "644") {
		t.Fatalf("installed file: %q %v", out.Stdout, err)
	}
	a.PayloadSHA256 = strings.Repeat("0", 64)
	if err := e.svc.InstallArtifact(ctx, c, db.NewID(), a, "/opt/nomad-deck/test/payload2", "0644", 0); err == nil ||
		!strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("tampered install must fail, got %v", err)
	}
	if _, err := c.Run(ctx, "test ! -e /opt/nomad-deck/test/payload2", sshx.RunOptions{Sudo: true}); err != nil {
		t.Fatal("a failed install must not leave the destination file")
	}
}

// TestIntegrationRealNomadRelay downloads a real Nomad release on the
// control plane, verifies HashiCorp's PGP signature and SHA-256, relays the
// binary to the host and runs it there. Requires internet access.
func TestIntegrationRealNomadRelay(t *testing.T) {
	if os.Getenv("ND_IT_NETWORK") == "" {
		t.Skip("ND_IT_NETWORK not set")
	}
	e := setupIT(t)
	ctx := context.Background()
	res, err := e.svc.Test(ctx, e.actor, e.node.ID)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	src := &release.HashiCorp{CacheDir: filepath.Join(e.dir, "cache")}
	versions, err := src.Versions(ctx, client, "nomad")
	if err != nil || len(versions) == 0 {
		t.Fatalf("versions: %v %v", versions, err)
	}
	var log bytes.Buffer
	a, err := src.Fetch(ctx, client, "nomad", versions[0], "linux", res.Probe.Arch, &log)
	if err != nil {
		t.Fatalf("fetch: %v\n%s", err, log.String())
	}
	t.Logf("fetched nomad %s (%d bytes):\n%s", a.Version, a.PayloadSize, log.String())
	c, _ := e.svc.Connect(ctx, e.node)
	if err := e.svc.InstallArtifact(ctx, c, db.NewID(), a, "/opt/nomad-deck/nomad/bin/versions/nomad-"+a.Version+"/nomad", "0755", 0); err != nil {
		t.Fatal(err)
	}
	out, err := c.Run(ctx, "/opt/nomad-deck/nomad/bin/versions/nomad-"+a.Version+"/nomad version", sshx.RunOptions{Sudo: true})
	if err != nil || !strings.Contains(string(out.Stdout), "Nomad v"+a.Version) {
		t.Fatalf("nomad version on host: %q %v", out.Stdout, err)
	}
}
