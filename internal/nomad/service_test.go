package nomad

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
)

type svcEnv struct {
	t  *testing.T
	ls *localServer
	s  *Service
	cl *db.Cluster
}

// newSvcEnv wires a Service to a local Nomad server: the cluster and its
// single server member point at the local process.
func newSvcEnv(t *testing.T) *svcEnv {
	ls := startLocalServer(t)
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{7}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := ops.NewEngine(d, log, dir)
	t.Cleanup(engine.Wait)
	s := &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Ops: engine, DataDir: dir, Log: log,
		PollEvery: 200 * time.Millisecond, JoinTimeout: 20 * time.Second}
	now := time.Now()
	c := &db.Cluster{ID: db.NewID(), Name: "local", Type: "nomad", Mode: "single", Region: "global", Datacenter: "dc1",
		TLSEnabled: true, CACertPEM: ls.caPEM, ConfigJSON: `{"http_port":` + strconv.Itoa(ls.http) + `}`, CreatedAt: now, UpdatedAt: now}
	err = d.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
			VALUES ('k', 'k', 'ed25519', 'x', 'x', 'x', 1, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, created_at, updated_at) VALUES ('h1', 'local1', '127.0.0.1', 'root', 'k', ?, ?)`,
			db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		return db.InsertClusterNode(ctx, tx, &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "nomad", NodeID: "h1",
			Role: RoleServer, AdvertiseAddr: "127.0.0.1", APIAddr: ls.addr(), InstallState: "installed",
			NodeConfigJSON: `{"node_name":"local1"}`, CreatedAt: now, UpdatedAt: now})
	})
	if err != nil {
		t.Fatal(err)
	}
	ls.waitLeader(ctx)
	return &svcEnv{t: t, ls: ls, s: s, cl: c}
}

func (e *svcEnv) load() *nomadCluster {
	cl, err := e.s.loadCluster(context.Background(), e.s.DB.Reader, e.cl.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return cl
}

func TestBootstrapAndStatus(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	if err := e.s.bootstrap(ctx, e.load(), t.Logf); err != nil {
		t.Fatal(err)
	}
	cl := e.load()
	if cl.InitState != db.InitInitialized || cl.AdminTokenEncrypted == "" {
		t.Fatalf("state after bootstrap: %s", cl.InitState)
	}
	rep, err := e.s.StatusDetail(ctx, cl.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Health != "healthy" || rep.Leader != "local1" || len(rep.Nodes) != 1 || rep.Nodes[0].Version == "" || !rep.Nodes[0].Voter {
		t.Fatalf("status: %+v", rep)
	}
}

// The bootstrap call succeeded but its response was lost: the secret was
// persisted first, so token/self confirms the outcome.
func TestBootstrapLostResponse(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	cl := e.load()
	secret, err := e.s.prepareSecret(ctx, cl)
	if err != nil {
		t.Fatal(err)
	}
	if e.load().InitState != db.InitInDoubt {
		t.Fatal("secret must be stored with init_in_doubt")
	}
	if _, err := e.ls.client("").Bootstrap(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err := e.s.confirmBootstrap(ctx, e.load(), secret, t.Logf); err != nil {
		t.Fatal(err)
	}
	if e.load().InitState != db.InitInitialized {
		t.Fatal("not initialized")
	}
}

// Someone else bootstrapped the cluster: the outcome stays in doubt, and
// the official reset path (reset index) followed by a bootstrap with the
// stored secret recovers it.
func TestBootstrappedElsewhere(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	other, _ := newUUID()
	if _, err := e.ls.client("").Bootstrap(ctx, other); err != nil {
		t.Fatal(err)
	}
	err := e.s.bootstrap(ctx, e.load(), t.Logf)
	if !errors.Is(err, ErrBootstrappedElsewhere) {
		t.Fatalf("expected bootstrapped elsewhere, got %v", err)
	}
	if e.load().InitState != db.InitInDoubt {
		t.Fatal("cluster must stay in doubt")
	}
	// Supplying the other party's token resolves it.
	task, err := e.s.Ops.Submit(ctx, ops.Spec{Action: "t", TargetType: "cluster", TargetID: e.cl.ID,
		Run: func(ctx context.Context, tk *ops.Task) error { return e.s.storeToken(ctx, tk, e.cl.ID, other) }})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e.s, task.ID)
	cl := e.load()
	if cl.InitState != db.InitInitialized {
		t.Fatal("token supply must initialize the cluster")
	}
	if tok, _ := e.s.managementToken(cl); tok != other {
		t.Fatal("stored token mismatch")
	}
}

func waitTask(t *testing.T, s *Service, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		got, _ := db.GetTask(context.Background(), s.DB.Reader, id)
		if got.Status != db.TaskPending && got.Status != db.TaskRunning {
			if got.Status != db.TaskSuccess {
				t.Fatalf("task %s: %s %s", got.Action, got.Status, got.ErrorMessage)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("task timeout")
}
