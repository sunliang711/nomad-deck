package vault

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/vaultbackup"
)

type svcEnv struct {
	t       *testing.T
	lc      *localCluster
	s       *Service
	cluster *db.Cluster
	members map[string]*db.ClusterNode // by local node name
	dir     string
}

var testActor = audit.Actor{Name: "tester"}

// newSvcEnv wires a Service to a local Vault cluster: cluster and member
// records point at the local processes, which play the deployed nodes.
func newSvcEnv(t *testing.T, size int) *svcEnv {
	lc := newLocalCluster(t, size)
	for _, n := range lc.nodes {
		lc.start(n)
	}
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{9}, 32))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := ops.NewEngine(d, log, dir)
	t.Cleanup(engine.Wait)
	s := &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Ops: engine, DataDir: dir, Log: log,
		PollEvery: 300 * time.Millisecond, JoinTimeout: 90 * time.Second, AuditPath: filepath.Join(dir, "vault-audit.log")}
	e := &svcEnv{t: t, lc: lc, s: s, members: map[string]*db.ClusterNode{}, dir: dir}
	s.RestartNode = func(ctx context.Context, m *db.ClusterNode) error {
		for _, n := range lc.nodes {
			if n.name == memberConfig(m).RaftNodeID {
				n.stop()
				lc.start(n)
			}
		}
		return nil
	}
	now := time.Now()
	c := &db.Cluster{ID: db.NewID(), Name: "local", Type: "vault", Mode: "cluster", TLSEnabled: true, CACertPEM: lc.caPEM,
		ConfigJSON: `{}`, CreatedAt: now, UpdatedAt: now}
	if size == 1 {
		c.Mode = "single"
	}
	err = d.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			return err
		}
		if err := db.InsertCustody(ctx, tx, &db.VaultCustody{ClusterID: c.ID, KeyShares: 5, KeyThreshold: 3, AutoUnsealByDeck: true, UpdatedAt: now}); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
			VALUES ('k', 'k', 'ed25519', 'x', 'x', 'x', 1, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		for i, n := range lc.nodes {
			nodeID := db.NewID()
			if _, err := tx.Exec(`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, created_at, updated_at) VALUES (?, ?, '127.0.0.1', 'root', 'k', ?, ?)`,
				nodeID, n.name, db.FormatTime(now), db.FormatTime(now)); err != nil {
				return err
			}
			m := &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "vault", NodeID: nodeID, Role: "raft_node",
				AdvertiseAddr: "127.0.0.1", APIAddr: n.addr(), InstallState: "installed", InstalledVersion: "local",
				NodeConfigJSON: `{"raft_node_id":"` + n.name + `"}`, CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now}
			if err := db.InsertClusterNode(ctx, tx, m); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ms, _ := db.ListClusterNodes(ctx, d.Reader, c.ID)
	for _, m := range ms {
		e.members[m.NodeName] = m
	}
	e.cluster = c
	return e
}

func (e *svcEnv) wait(task *db.OperationTask, err error) *db.OperationTask {
	e.t.Helper()
	if err != nil {
		e.t.Fatalf("submit: %v", err)
	}
	ctx := context.Background()
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		got, _ := db.GetTask(ctx, e.s.DB.Reader, task.ID)
		switch got.Status {
		case db.TaskPending, db.TaskRunning:
			time.Sleep(200 * time.Millisecond)
			continue
		}
		return got
	}
	e.t.Fatalf("task %s did not finish", task.Action)
	return nil
}

func (e *svcEnv) logs(task *db.OperationTask) string {
	steps, _ := db.ListSteps(context.Background(), e.s.DB.Reader, task.ID)
	var b strings.Builder
	for _, st := range steps {
		data, _ := os.ReadFile(filepath.Join(e.dir, st.LogPath))
		b.WriteString("## " + st.Name + " [" + st.Status + "] " + st.ErrorMessage + "\n" + string(data))
	}
	return b.String()
}

func (e *svcEnv) mustSucceed(task *db.OperationTask, err error) *db.OperationTask {
	e.t.Helper()
	got := e.wait(task, err)
	if got.Status != db.TaskSuccess {
		e.t.Fatalf("%s: %s %s\n%s", got.Action, got.Status, got.ErrorMessage, e.logs(got))
	}
	return got
}

func (e *svcEnv) custody() *db.VaultCustody {
	cu, err := db.GetCustody(context.Background(), e.s.DB.Reader, e.cluster.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return cu
}

func (e *svcEnv) gens() map[int]string {
	gs, _ := db.ListKeyGenerations(context.Background(), e.s.DB.Reader, e.cluster.ID)
	out := map[int]string{}
	for _, g := range gs {
		out[g.Generation] = g.State
	}
	return out
}

func (e *svcEnv) sealed(name string) bool {
	for _, n := range e.lc.nodes {
		if n.name == name {
			st, err := e.lc.client(n, "").SealStatus(context.Background())
			if err != nil {
				e.t.Fatal(err)
			}
			return st.Sealed
		}
	}
	e.t.Fatalf("no node %s", name)
	return false
}

func (e *svcEnv) restart(name string) {
	for _, n := range e.lc.nodes {
		if n.name == name {
			n.stop()
			e.lc.start(n)
		}
	}
}

func TestServiceLifecycle(t *testing.T) {
	e := newSvcEnv(t, 3)
	ctx := context.Background()
	s := e.s
	id := e.cluster.ID

	// Init: keys stored as generation 1, admin token issued, root token revoked, joins done.
	e.mustSucceed(s.Init(ctx, testActor, id, InitInput{}))
	cl, _ := db.GetCluster(ctx, s.DB.Reader, id)
	cu := e.custody()
	if cl.InitState != db.InitInitialized || cu.SealGeneration != 1 || cu.AdminTokenEncrypted == "" || cu.BootstrapRootTokenEncrypted != "" {
		t.Fatalf("after init: state=%s custody=%+v", cl.InitState, cu)
	}
	if e.gens()[1] != db.GenActive {
		t.Fatalf("generations: %v", e.gens())
	}
	for _, n := range []string{"n1", "n2", "n3"} {
		if e.sealed(n) {
			t.Fatalf("%s sealed after init", n)
		}
	}
	nodes, health, err := s.SyncStatus(ctx, id)
	if err != nil || health != "healthy" {
		t.Fatalf("status: %s %v %+v", health, err, nodes)
	}
	voters := 0
	for _, n := range nodes {
		if n.Voter {
			voters++
		}
	}
	if voters != 3 {
		t.Fatalf("voters: %+v", nodes)
	}
	if _, err := os.Stat(s.AuditPath); err != nil {
		t.Fatalf("audit device must write to %s: %v", s.AuditPath, err)
	}
	if _, err := s.Init(ctx, testActor, id, InitInput{}); err == nil {
		t.Fatal("init twice must be refused")
	}

	// Gate: healthy voter allowed (tolerance 1); with n3 down n2 is blocked, n3 itself allowed.
	if r, err := s.CheckGate(ctx, id, e.members["n2"].NodeID); err != nil || !r.Allowed {
		t.Fatalf("gate n2: %+v %v", r, err)
	}

	// Unseal one node, then auto-unseal sweep.
	e.restart("n2")
	e.mustSucceed(s.Unseal(ctx, testActor, id, UnsealInput{NodeIDs: []string{e.members["n2"].NodeID}}))
	if e.sealed("n2") {
		t.Fatal("n2 must be unsealed")
	}
	e.restart("n3")
	waitFor(t, "sweep unseals n3", 60*time.Second, func() (bool, error) {
		if _, err := s.AutoUnsealSweep(ctx); err != nil {
			return false, err
		}
		time.Sleep(2 * time.Second)
		return !e.sealed("n3"), nil
	})

	// Manual seal writes the suppression; the sweep then leaves the node sealed.
	e.mustSucceed(s.Seal(ctx, testActor, id, SealInput{NodeIDs: []string{e.members["n2"].NodeID}}))
	if !e.sealed("n2") || e.custody().UnsealSuppressedReason != "manual_seal" {
		t.Fatal("manual seal must seal n2 and suppress auto-unseal")
	}
	if n, _ := s.AutoUnsealSweep(ctx); n != 0 {
		t.Fatal("suppressed cluster must be skipped by the sweep")
	}
	if err := s.UpdateCustody(ctx, testActor, id, CustodyInput{ClearSuppression: true}); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.AutoUnsealSweep(ctx); n != 1 {
		t.Fatal("sweep must resume after clearing the suppression")
	}
	waitFor(t, "n2 unsealed", 60*time.Second, func() (bool, error) { return !e.sealed("n2"), nil })

	// Normal rekey: generation 2 active, generation 1 retired, new keys unseal.
	e.mustSucceed(s.Rekey(ctx, testActor, id, RekeyInput{}))
	if g := e.gens(); g[2] != db.GenActive || g[1] != db.GenRetired || e.custody().SealGeneration != 2 {
		t.Fatalf("after rekey: %v", g)
	}
	e.restart("n3")
	e.mustSucceed(s.Unseal(ctx, testActor, id, UnsealInput{NodeIDs: []string{e.members["n3"].NodeID}}))

	clu, _ := s.loadCluster(ctx, s.DB.Reader, id)
	active := func() *Client {
		ms, _ := db.ListClusterNodes(ctx, s.DB.Reader, id)
		am, err := s.activeMember(ctx, clu, ms)
		if err != nil {
			t.Fatal(err)
		}
		c, _ := s.client(clu, am, "")
		return c
	}
	// startOnly stores a pending generation without verifying it.
	startOnly := func() *db.KeyGeneration {
		var g *db.KeyGeneration
		e.mustSucceed(s.Ops.Submit(ctx, ops.Spec{Action: "test.rekey_start", Run: func(ctx context.Context, tk *ops.Task) error {
			var err error
			g, err = s.startRekey(ctx, tk, clu, active(), RekeyInput{KeyShares: 5, KeyThreshold: 3})
			return err
		}}))
		return g
	}
	verifyKeys := func(g *db.KeyGeneration, n int) {
		keys, _, _ := s.keysOf(ctx, s.DB.Reader, id, g.Generation)
		c := active()
		for _, k := range keys[:n] {
			if _, err := c.RekeyVerifyUpdate(ctx, k, g.RekeyVerificationNonce); err != nil {
				t.Fatal(err)
			}
		}
	}
	markInDoubt := func(g *db.KeyGeneration) {
		_ = db.SetKeyGenerationState(ctx, s.DB.Writer, id, g.Generation, db.GenVerificationInDoubt, g.RekeyVerificationNonce, s.DB.Now())
	}

	// In doubt, Vault actually switched: the standby check unseals with the new keys.
	g3 := startOnly()
	verifyKeys(g3, 3)
	markInDoubt(g3)
	e.mustSucceed(s.Rekey(ctx, testActor, id, RekeyInput{}))
	if g := e.gens(); g[3] != db.GenActive || g[2] != db.GenRetired {
		t.Fatalf("reconcile switched: %v", g)
	}
	if cl, _ := db.GetCluster(ctx, s.DB.Reader, id); cl.MaintenanceMode {
		t.Fatal("conclusive reconcile must leave maintenance")
	}

	// In doubt, Vault never switched: new keys invalid, old keys unseal -> abandoned.
	g4 := startOnly()
	markInDoubt(g4)
	if rs, err := active().RekeyStatus(ctx); err != nil || active().RekeyCancel(ctx, rs.Nonce) != nil {
		t.Fatal("cancel the pending rekey")
	}
	if _, err := active().RekeyVerifyStatus(ctx); !IsNoRekeyInProgress(err) {
		t.Fatalf("verification must be gone after cancel: %v", err)
	}
	e.mustSucceed(s.Rekey(ctx, testActor, id, RekeyInput{}))
	if g := e.gens(); g[4] != db.GenAbandoned || g[3] != db.GenActive {
		t.Fatalf("reconcile not switched: %v", g)
	}

	// In doubt with verification still running: continue and activate.
	g5 := startOnly()
	verifyKeys(g5, 2)
	markInDoubt(g5)
	e.mustSucceed(s.Rekey(ctx, testActor, id, RekeyInput{}))
	if g := e.gens(); g[5] != db.GenActive || g[3] != db.GenRetired || g[4] != db.GenAbandoned {
		t.Fatalf("reconcile continued: %v", g)
	}

	// Emergency token recovery after the admin token is revoked.
	tok, _ := s.adminToken(ctx, id)
	if err := active().WithToken(tok).RevokeSelf(ctx); err != nil {
		t.Fatal(err)
	}
	e.mustSucceed(s.RecoverToken(ctx, testActor, id))
	tok2, _ := s.adminToken(ctx, id)
	if tok2 == tok {
		t.Fatal("a new admin token must be issued")
	}
	if _, err := active().WithToken(tok2).LookupSelf(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecoverToken(ctx, testActor, id); err == nil {
		t.Fatal("recovery must be refused while the token works")
	}
	if err := s.RenewTokens(ctx); err != nil {
		t.Fatal(err)
	}

	// Offline backup with history.
	vaultbackup.DefaultMemory = 8 * 1024
	data, name, err := s.ExportBackup(ctx, testActor, id, "long enough passphrase", true)
	if err != nil || !strings.HasSuffix(name, ".ndvkb") {
		t.Fatal(err)
	}
	p, err := vaultbackup.Decrypt(data, "long enough passphrase")
	if err != nil || p.ActiveGeneration != 5 || len(p.Generations) != 4 { // 1,2,3,5 (4 abandoned is excluded)
		t.Fatalf("backup: %+v %v", p, err)
	}

	// Gate with a node down.
	for _, n := range e.lc.nodes {
		if n.name == "n3" {
			n.stop()
		}
	}
	waitFor(t, "autopilot sees n3 down", 90*time.Second, func() (bool, error) {
		r, err := s.CheckGate(ctx, id, e.members["n2"].NodeID)
		return err == nil && !r.Allowed, err
	})
	if r, err := s.CheckGate(ctx, id, e.members["n3"].NodeID); err != nil || !r.Allowed {
		t.Fatalf("an unhealthy target with a healthy majority must be allowed: %+v %v", r, err)
	}
}

func TestServiceSingleNodeRekeyReconcile(t *testing.T) {
	e := newSvcEnv(t, 1)
	ctx := context.Background()
	s := e.s
	id := e.cluster.ID
	e.mustSucceed(s.Init(ctx, testActor, id, InitInput{}))
	clu, _ := s.loadCluster(ctx, s.DB.Reader, id)
	ms, _ := db.ListClusterNodes(ctx, s.DB.Reader, id)
	c, _ := s.client(clu, ms[0], "")
	var g *db.KeyGeneration
	e.mustSucceed(s.Ops.Submit(ctx, ops.Spec{Action: "test.rekey_start", Run: func(ctx context.Context, tk *ops.Task) error {
		var err error
		g, err = s.startRekey(ctx, tk, clu, c, RekeyInput{KeyShares: 5, KeyThreshold: 3})
		return err
	}}))
	keys, _, _ := s.keysOf(ctx, s.DB.Reader, id, g.Generation)
	for _, k := range keys[:3] {
		if _, err := c.RekeyVerifyUpdate(ctx, k, g.RekeyVerificationNonce); err != nil {
			t.Fatal(err)
		}
	}
	_ = db.SetKeyGenerationState(ctx, s.DB.Writer, id, g.Generation, db.GenVerificationInDoubt, g.RekeyVerificationNonce, s.DB.Now())
	// Without the maintenance window authorization nothing changes and the cluster stays in maintenance.
	got := e.wait(s.Rekey(ctx, testActor, id, RekeyInput{}))
	if got.Status != db.TaskFailed || !strings.Contains(got.ErrorMessage, "维护窗口") {
		t.Fatalf("expected refusal: %s %s", got.Status, got.ErrorMessage)
	}
	if cl, _ := db.GetCluster(ctx, s.DB.Reader, id); !cl.MaintenanceMode || e.gens()[2] != db.GenVerificationInDoubt {
		t.Fatal("states must be unchanged and the cluster in maintenance")
	}
	e.mustSucceed(s.Rekey(ctx, testActor, id, RekeyInput{AuthorizeMaintenance: true}))
	if gs := e.gens(); gs[2] != db.GenActive || gs[1] != db.GenRetired || e.sealed("n1") {
		t.Fatalf("single-node reconcile: %v", gs)
	}
}
