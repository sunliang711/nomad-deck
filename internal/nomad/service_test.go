package nomad

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
)

var testActor = audit.Actor{Name: "tester"}

type svcEnv struct {
	t       *testing.T
	ls      *localServer
	servers []*localServer
	s       *Service
	cl      *db.Cluster
}

// newSvcEnv wires a Service to a local Nomad server: the cluster and its
// single server member point at the local process.
func newSvcEnv(t *testing.T) *svcEnv { return newSvcEnvN(t, 1) }

func newSvcEnvN(t *testing.T, size int) *svcEnv {
	lss := startLocalCluster(t, size)
	ls := lss[0]
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
	mode := "single"
	if size > 1 {
		mode = "cluster"
	}
	c := &db.Cluster{ID: db.NewID(), Name: "local", Type: "nomad", Mode: mode, Region: "global", Datacenter: "dc1",
		TLSEnabled: true, CACertPEM: ls.caPEM, ConfigJSON: `{"http_port":` + strconv.Itoa(ls.http) + `}`, CreatedAt: now, UpdatedAt: now}
	err = d.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.InsertCluster(ctx, tx, c); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO ssh_keys (id, name, algorithm, public_key, private_key_encrypted, fingerprint, is_default, created_at, updated_at)
			VALUES ('k', 'k', 'ed25519', 'x', 'x', 'x', 1, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
			return err
		}
		for i, x := range lss {
			hid := "h" + strconv.Itoa(i+1)
			if _, err := tx.Exec(`INSERT INTO nodes (id, name, host, ssh_user, ssh_key_id, created_at, updated_at) VALUES (?, ?, '127.0.0.1', 'root', 'k', ?, ?)`,
				hid, x.name, db.FormatTime(now), db.FormatTime(now)); err != nil {
				return err
			}
			if err := db.InsertClusterNode(ctx, tx, &db.ClusterNode{ID: db.NewID(), ClusterID: c.ID, ClusterType: "nomad", NodeID: hid,
				Role: RoleServer, AdvertiseAddr: "127.0.0.1", APIAddr: x.addr(), InstallState: "installed",
				NodeConfigJSON: `{"node_name":"` + x.name + `"}`, CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ls.waitLeader(ctx)
	return &svcEnv{t: t, ls: ls, servers: lss, s: s, cl: c}
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

func (e *svcEnv) member(name string) *db.ClusterNode {
	ms, _ := db.ListClusterNodes(context.Background(), e.s.DB.Reader, e.cl.ID)
	for _, m := range ms {
		if m.NodeName == name {
			return m
		}
	}
	e.t.Fatalf("no member %s", name)
	return nil
}

func TestLocalClusterGateAndRemoval(t *testing.T) {
	e := newSvcEnvN(t, 3)
	ctx := context.Background()
	if err := e.s.bootstrap(ctx, e.load(), t.Logf); err != nil {
		t.Fatal(err)
	}
	cl := e.load()
	ms, _ := db.ListClusterNodes(ctx, e.s.DB.Reader, cl.ID)
	for _, m := range ms {
		if err := e.s.waitHealthyServer(ctx, cl, m, t.Logf); err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range ms {
		g, err := e.s.CheckGate(ctx, cl.ID, m.NodeID)
		if err != nil || !g.Allowed || g.FailureTolerance != 1 || g.Voters != 3 {
			t.Fatalf("gate %s: %+v %v", m.NodeName, g, err)
		}
	}
	// Leadership transfer and rolling order (leader last among servers).
	leader := e.s.leaderMember(ctx, cl, ms)
	if leader == nil {
		t.Fatal("no leader member")
	}
	order := e.s.rollingOrder(ctx, cl, ms)
	if order[len(order)-1].ID != leader.ID {
		t.Fatalf("leader must be last: %s", order[len(order)-1].NodeName)
	}
	api, _, err := e.s.apiClient(ctx, cl, "")
	if err != nil {
		t.Fatal(err)
	}
	raft, _ := api.RaftConfiguration(ctx)
	var target RaftServer
	for _, sv := range raft {
		if !sv.Leader {
			target = sv
			break
		}
	}
	if err := api.TransferLeadership(ctx, target.ID); err != nil {
		t.Fatalf("transfer leadership: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		if l := e.s.leaderMember(ctx, cl, ms); l != nil && l.ID != leader.ID {
			t.Logf("leadership moved from %s to %s", leader.NodeName, l.NodeName)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("leadership did not move")
		}
		time.Sleep(300 * time.Millisecond)
	}
	// Stop local3: a healthy server may no longer go down, the failed one may.
	e.servers[2].stop()
	down := e.member("local3")
	deadline = time.Now().Add(60 * time.Second)
	for {
		g, err := e.s.CheckGate(ctx, cl.ID, down.NodeID)
		// Right after stopping a leader, autopilot reports nobody healthy
		// until the re-election settles; wait for the two survivors.
		if err == nil && !g.TargetHealthy && g.HealthyVoters >= 2 {
			if !g.Allowed {
				t.Fatalf("an unhealthy server with a healthy majority should pass: %+v", g)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("local3 never reported unhealthy: %+v %v", g, err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	g, err := e.s.CheckGate(ctx, cl.ID, e.member("local1").NodeID)
	if err != nil || g.Allowed || g.FailureTolerance != 0 {
		t.Fatalf("with one server down a healthy server must be blocked: %+v %v", g, err)
	}
	api, _, _ = e.s.apiClient(ctx, cl, down.ID)
	raft, _ = api.RaftConfiguration(ctx)
	if sv, ok := raftServerOf(cl, down, raft); ok {
		if err := api.RemovePeer(ctx, sv.ID); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Log("autopilot already removed the dead server from raft")
	}
	_ = api.ForceLeave(ctx, "local3.global")
	raft, _ = api.RaftConfiguration(ctx)
	if len(raft) != 2 {
		t.Fatalf("raft after removal: %+v", raft)
	}
	// Snapshot and restore without SSH.
	snap, err := e.s.takeSnapshot(ctx, cl, "manual", "tester")
	if err != nil {
		t.Fatal(err)
	}
	task, err := e.s.Restore(ctx, testActor, cl.ID, snap.ID, RestoreInput{})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e.s, task.ID)
	if c := e.load(); c.MaintenanceMode || c.InitState != db.InitInitialized {
		t.Fatalf("after restore: maintenance=%v init=%s", c.MaintenanceMode, c.InitState)
	}
	views, _ := e.s.ListSnapshots(ctx, cl.ID)
	if len(views) != 1 || views[0].CredentialGeneration == "" {
		t.Fatalf("snapshots: %+v", views)
	}
}

func TestUndeployedNodeConfigAndCNISettings(t *testing.T) {
	e := newSvcEnv(t)
	e.s.Releases = &release.Provider{DB: e.s.DB, CacheDir: e.t.TempDir()}
	ctx := context.Background()

	// Create an undeployed cluster with a server_client member and verify
	// pre-deploy plugin config + CNI version validation.
	cl := e.load()
	if _, err := e.s.DB.Writer.Exec(`UPDATE cluster_nodes SET role = ?, install_state = 'pending' WHERE cluster_id = ?`, RoleServerClient, cl.ID); err != nil {
		t.Fatal(err)
	}
	cniVer := "v1.10.0"
	if _, err := e.s.UpdateSettings(ctx, testActor, cl.ID, SettingsInput{CNIVersion: &cniVer}); err != nil {
		t.Fatalf("set cni version: %v", err)
	}
	task, err := e.s.UpdateNodeConfig(ctx, testActor, cl.ID, "h1", NodeConfigInput{
		ClientSettings: ClientSettings{
			CNI:         true,
			RawExec:     true,
			Denylist:    []string{"java"},
			Meta:        map[string]string{"env": "lab"},
			HostVolumes: []HostVolume{{Name: "data", Path: "/opt/nomad-deck/nomad/volumes/data", Create: true}},
			Docker:      DockerDriver{Volumes: true, AllowPrivileged: true, ImageGCDelay: "5m"},
		},
		ReinstallCNI: true,
	})
	if err != nil {
		t.Fatalf("update pending node config: %v", err)
	}
	if task != nil {
		t.Fatalf("expected no async task for pending node, got %+v", task)
	}
	empty := ""
	if _, err := e.s.UpdateSettings(ctx, testActor, cl.ID, SettingsInput{CNIVersion: &empty}); err == nil {
		t.Fatal("clearing cni_version while client uses CNI must fail")
	}
	m1, err := db.GetClusterNode(ctx, e.s.DB.Reader, cl.ID, "h1")
	if err != nil {
		t.Fatal(err)
	}
	mc := memberConfig(m1)
	if !mc.CNI || !mc.RawExec || len(mc.HostVolumes) != 1 || mc.Meta["env"] != "lab" || !mc.Docker.AllowPrivileged {
		t.Fatalf("unexpected persisted member config: %+v", mc)
	}
}

func TestNomadUILoginOTT(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	if err := e.s.bootstrap(ctx, e.load(), t.Logf); err != nil {
		t.Fatal(err)
	}
	cl := e.load()
	permRoot, err := e.s.managementToken(cl)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.CreateUILogin(ctx, testActor, cl.ID, "https://evil.example.com"); err == nil {
		t.Fatal("untrusted target_url must be rejected")
	}
	link, err := e.s.CreateUILogin(ctx, testActor, cl.ID, "")
	if err != nil {
		t.Fatalf("CreateUILogin: %v", err)
	}
	u, err := url.Parse(link.LoginURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/ui/" || !strings.HasPrefix(link.LoginURL, e.ls.addr()+"/ui/?ott=") {
		t.Fatalf("unexpected login url: %s", link.LoginURL)
	}
	ott := u.Query().Get("ott")
	if ott == "" {
		t.Fatal("missing ott query param")
	}
	tok, err := e.ls.client("").ExchangeOneTimeToken(ctx, ott)
	if err != nil {
		t.Fatalf("ExchangeOneTimeToken: %v", err)
	}
	if tok.Type != "management" || tok.ExpirationTime == nil || tok.SecretID == permRoot {
		t.Fatalf("unexpected exchanged token: %+v", tok)
	}
	if _, err := e.ls.client("").ExchangeOneTimeToken(ctx, ott); err == nil {
		t.Fatal("second OTT exchange must fail")
	}
}

func TestNomadForceRemoveAndUninstall(t *testing.T) {
	e := newSvcEnvN(t, 3)
	ctx := context.Background()
	if err := e.s.bootstrap(ctx, e.load(), t.Logf); err != nil {
		t.Fatal(err)
	}
	cl := e.load()
	ms, _ := db.ListClusterNodes(ctx, e.s.DB.Reader, cl.ID)
	for _, m := range ms {
		if err := e.s.waitHealthyServer(ctx, cl, m, t.Logf); err != nil {
			t.Fatal(err)
		}
	}

	// Simulate losing the third server (and s.Hosts is nil so SSH fails).
	e.servers[2].stop()
	down := e.member("local3")
	deadline := time.Now().Add(60 * time.Second)
	for {
		g, err := e.s.CheckGate(ctx, cl.ID, down.NodeID)
		if err == nil && !g.TargetHealthy && g.HealthyVoters >= 2 && g.Allowed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("local3 never reported removable: %+v %v", g, err)
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Normal remove fails when SSH is unavailable.
	task, err := e.s.NodeRemove(ctx, testActor, cl.ID, down.NodeID, false)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(30 * time.Second)
	for {
		got, _ := db.GetTask(ctx, e.s.DB.Reader, task.ID)
		if got.Status == db.TaskFailed {
			break
		}
		if got.Status == db.TaskSuccess || time.Now().After(deadline) {
			t.Fatalf("expected non-force remove failure, got %s", got.Status)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Force remove cleans Raft, gossip and DB membership without SSH.
	task, err = e.s.NodeRemove(ctx, testActor, cl.ID, down.NodeID, true)
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e.s, task.ID)
	rest, err := db.ListClusterNodes(ctx, e.s.DB.Reader, cl.ID)
	if err != nil || len(rest) != 2 {
		t.Fatalf("expected 2 members after force remove, got %d %v", len(rest), err)
	}
	api, _, err := e.s.apiClient(ctx, cl, "")
	if err != nil {
		t.Fatal(err)
	}
	raft, err := api.RaftConfiguration(ctx)
	if err != nil || len(raft) != 2 {
		t.Fatalf("expected 2 raft peers after force remove, got %+v %v", raft, err)
	}

	// Normal uninstall fails when SSH is unavailable; force uninstall deletes the cluster.
	task, err = e.s.Uninstall(ctx, testActor, cl.ID, "local", false)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(30 * time.Second)
	for {
		got, _ := db.GetTask(ctx, e.s.DB.Reader, task.ID)
		if got.Status == db.TaskFailed {
			break
		}
		if got.Status == db.TaskSuccess || time.Now().After(deadline) {
			t.Fatalf("expected non-force uninstall failure, got %s", got.Status)
		}
		time.Sleep(100 * time.Millisecond)
	}
	task, err = e.s.Uninstall(ctx, testActor, cl.ID, "local", true)
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e.s, task.ID)
	if _, err := db.GetCluster(ctx, e.s.DB.Reader, cl.ID); err == nil {
		t.Fatal("cluster must be deleted after force uninstall")
	}
}

func TestAddHostVolume(t *testing.T) {
	e := newSvcEnv(t)
	ctx := context.Background()
	cl := e.load()

	// Make h1 a pending server_client member so DB persistence and validation can be tested without SSH.
	if _, err := e.s.DB.Writer.Exec(`UPDATE cluster_nodes SET role = ?, install_state = 'pending' WHERE cluster_id = ?`, RoleServerClient, cl.ID); err != nil {
		t.Fatal(err)
	}

	// Invalid path under /etc must fail.
	if _, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume:  HostVolume{Name: "pgdata", Path: "/etc/pgdata", Create: true},
		NodeIDs: []string{"h1"},
	}); err == nil {
		t.Fatal("expected /etc path to be rejected")
	}

	// Empty node_ids must fail.
	if _, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume: HostVolume{Name: "pgdata", Path: "/opt/nomad-deck/nomad/volumes/pgdata", Create: true},
	}); err == nil {
		t.Fatal("expected empty node_ids to be rejected")
	}

	// Pending member saves directly to NodeConfigJSON without an async task.
	task, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume:  HostVolume{Name: "pgdata", Path: "/opt/nomad-deck/nomad/volumes/pgdata", ReadOnly: false, Create: true},
		NodeIDs: []string{"h1"},
	})
	if err != nil {
		t.Fatalf("AddHostVolume pending: %v", err)
	}
	if task != nil {
		t.Fatalf("expected nil task for pending node, got %+v", task)
	}
	m1, err := db.GetClusterNode(ctx, e.s.DB.Reader, cl.ID, "h1")
	if err != nil {
		t.Fatal(err)
	}
	mc := memberConfig(m1)
	if len(mc.HostVolumes) != 1 || mc.HostVolumes[0].Name != "pgdata" || mc.HostVolumes[0].Path != "/opt/nomad-deck/nomad/volumes/pgdata" {
		t.Fatalf("unexpected host_volumes persisted: %+v", mc.HostVolumes)
	}

	// Duplicate volume name on the same node must be rejected.
	if _, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume:  HostVolume{Name: "pgdata", Path: "/opt/nomad-deck/nomad/volumes/pgdata", Create: true},
		NodeIDs: []string{"h1"},
	}); err == nil {
		t.Fatal("expected duplicate host volume name to be rejected")
	}

	// Pure server node must be rejected.
	if _, err := e.s.DB.Writer.Exec(`UPDATE cluster_nodes SET role = ? WHERE cluster_id = ?`, RoleServer, cl.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume:  HostVolume{Name: "redis", Path: "/opt/nomad-deck/nomad/volumes/redis", Create: true},
		NodeIDs: []string{"h1"},
	}); err == nil {
		t.Fatal("expected pure server node to be rejected")
	}

	// Installed single-node server_client requires confirm_single_node=true.
	if _, err := e.s.DB.Writer.Exec(`UPDATE cluster_nodes SET role = ?, install_state = 'installed' WHERE cluster_id = ?`, RoleServerClient, cl.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.AddHostVolume(ctx, testActor, cl.ID, AddHostVolumeInput{
		Volume:        HostVolume{Name: "redis", Path: "/opt/nomad-deck/nomad/volumes/redis", Create: true},
		NodeIDs:       []string{"h1"},
		ConfirmSingle: false,
	}); err == nil {
		t.Fatal("expected installed single-node server_client without confirm_single_node to be rejected")
	}
}
