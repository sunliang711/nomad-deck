//go:build integration

// End-to-end test against real Linux hosts (systemd + sshd) reachable over
// SSH, with Nomad releases downloaded and relayed by the control plane.
// See "make it-nomad".
package nomad

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

func pickVersions(t *testing.T) (string, string) {
	if from, to := os.Getenv("ND_E2E_FROM"), os.Getenv("ND_E2E_TO"); from != "" && to != "" {
		return from, to
	}
	vs, err := (&release.HashiCorp{}).Versions(context.Background(), http.DefaultClient, "nomad")
	if err != nil {
		t.Fatal(err)
	}
	to := vs[0]
	toMinor := to[:strings.LastIndex(to, ".")]
	for _, v := range vs {
		if v[:strings.LastIndex(v, ".")] != toMinor {
			return v, to
		}
	}
	t.Fatal("no previous minor found")
	return "", ""
}

type e2e struct {
	t   *testing.T
	s   *Service
	dir string
}

func (e *e2e) mustSucceed(task *db.OperationTask, err error) *db.OperationTask {
	e.t.Helper()
	if err != nil {
		e.t.Fatalf("submit: %v", err)
	}
	ctx := context.Background()
	deadline := time.Now().Add(30 * time.Minute)
	for time.Now().Before(deadline) {
		got, _ := db.GetTask(ctx, e.s.DB.Reader, task.ID)
		if got.Status == db.TaskPending || got.Status == db.TaskRunning {
			time.Sleep(time.Second)
			continue
		}
		if got.Status != db.TaskSuccess {
			steps, _ := db.ListSteps(ctx, e.s.DB.Reader, task.ID)
			var b strings.Builder
			for _, st := range steps {
				data, _ := os.ReadFile(filepath.Join(e.dir, st.LogPath))
				b.WriteString("## " + st.Name + " [" + st.Status + "] " + st.ErrorMessage + "\n" + string(data))
			}
			e.t.Fatalf("%s: %s %s\n%s", got.Action, got.Status, got.ErrorMessage, b.String())
		}
		return got
	}
	e.t.Fatalf("task %s did not finish", task.Action)
	return nil
}

func TestE2ENomadCluster(t *testing.T) {
	hostList := os.Getenv("ND_E2E_HOSTS")
	if hostList == "" {
		t.Skip("ND_E2E_HOSTS not set")
	}
	names := strings.Split(hostList, ",")
	if len(names) < 5 {
		t.Fatal("need 5 hosts")
	}
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "e2e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{5}, 32))
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	rec := &audit.Recorder{DB: d, Log: log}
	pool := sshx.NewPool(8)
	defer pool.Close()
	hs := &hosts.Service{DB: d, Keys: keys, Audit: rec, Pool: pool, LocalMachineID: "e2e-runner"}
	engine := ops.NewEngine(d, log, dir)
	s := &Service{DB: d, Keys: keys, Audit: rec, Hosts: hs, Ops: engine, DataDir: dir, Log: log,
		Releases: &release.Provider{DB: d, CacheDir: filepath.Join(dir, "cache")}, Proxy: &netx.Manager{DB: d, Keys: keys},
		PollEvery: time.Second, JoinTimeout: 4 * time.Minute, DrainDeadline: 3 * time.Minute}
	e := &e2e{t: t, s: s, dir: dir}
	actor := audit.Actor{Name: "e2e"}
	from, to := pickVersions(t)
	t.Logf("deploying Nomad %s, upgrading to %s", from, to)
	if _, err := hs.GenerateKey(ctx, actor, "e2e"); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, n := range names {
		addrs, err := net.LookupHost(n)
		if err != nil {
			t.Fatal(err)
		}
		node, err := hs.CreateNode(ctx, actor, hosts.NodeInput{Name: n, Host: addrs[0], SSHUser: os.Getenv("ND_E2E_USER"), UseSudo: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := hs.PushKey(ctx, actor, node.ID, os.Getenv("ND_E2E_PASSWORD")); err != nil {
			t.Fatal(err)
		}
		if _, err := hs.Test(ctx, actor, node.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := d.Writer.Exec(`UPDATE nodes SET time_sync = 'synced' WHERE id = ?`, node.ID); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, node.ID)
	}
	c, err := s.CreateCluster(ctx, actor, CreateInput{Name: "e2e-nomad", Mode: "cluster",
		ClientDefaults: ClientSettings{RawExec: true, CPUTotalCompute: 4000},
		Nodes: []cluster.MemberInput{{NodeID: ids[0], Role: RoleServer}, {NodeID: ids[1], Role: RoleServer},
			{NodeID: ids[2], Role: RoleServerClient}}})
	if err != nil {
		t.Fatal(err)
	}
	id := c.ID
	noProxy := false
	status := func() *StatusReport {
		rep, err := s.StatusDetail(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return rep
	}
	healthy := func(stage string) *StatusReport {
		t.Helper()
		var rep *StatusReport
		for i := 0; i < 30; i++ {
			if rep = status(); rep.Health == "healthy" {
				return rep
			}
			time.Sleep(2 * time.Second)
		}
		t.Fatalf("%s: %+v", stage, rep)
		return nil
	}

	e.mustSucceed(s.Deploy(ctx, actor, id, cluster.DeployInput{Version: from, UseProxy: &noProxy}))
	rep := healthy("after deploy")
	if rep.Voters != 3 || rep.ReadyClients != 1 || rep.Leader == "" {
		t.Fatalf("after deploy: %+v", rep)
	}
	for _, n := range rep.Nodes {
		if n.Version != from {
			t.Fatalf("version after deploy: %+v", n)
		}
	}
	cl, _ := s.loadCluster(ctx, d.Reader, id)
	if cl.InitState != db.InitInitialized {
		t.Fatal("ACL must be bootstrapped")
	}

	// Run users follow the role.
	runUser := func(nodeID string) string {
		n, _ := db.GetNode(ctx, d.Reader, nodeID)
		sc, err := hs.Connect(ctx, n)
		if err != nil {
			t.Fatal(err)
		}
		r, _ := sc.Run(ctx, "ps -o user= -C nomad | head -1", sshx.RunOptions{Sudo: true})
		return strings.TrimSpace(string(r.Stdout))
	}
	if u := runUser(ids[0]); u != "nomad" {
		t.Fatalf("pure server must run as nomad, got %q", u)
	}
	if u := runUser(ids[2]); u != "root" {
		t.Fatalf("server_client must run as root, got %q", u)
	}

	// Scale out: a client and a server_client.
	e.mustSucceed(s.NodeJoin(ctx, actor, id, ids[3], cluster.JoinInput{Role: RoleClient, UseProxy: &noProxy}))
	e.mustSucceed(s.NodeJoin(ctx, actor, id, ids[4], cluster.JoinInput{Role: RoleServerClient, UseProxy: &noProxy}))
	rep = healthy("after join")
	if rep.Voters != 4 || rep.ReadyClients != 3 {
		t.Fatalf("after join: %+v", rep)
	}

	// A raw_exec service pinned to nn4, to be drained away later.
	cl, _ = s.loadCluster(ctx, d.Reader, id)
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		t.Fatal(err)
	}
	job := map[string]any{"Job": map[string]any{"ID": "sleeper", "Name": "sleeper", "Type": "service", "Datacenters": []string{"dc1"},
		"TaskGroups": []any{map[string]any{"Name": "g", "Count": 1,
			"Constraints": []any{map[string]any{"LTarget": "${node.unique.name}", "RTarget": "nn4|nn5", "Operand": "regexp"}},
			"Tasks": []any{map[string]any{"Name": "t", "Driver": "raw_exec",
				"Config": map[string]any{"command": "/bin/sleep", "args": []string{"3600"}}}}}}}}
	if err := api.Request(ctx, "PUT", "jobs", job, nil); err != nil {
		t.Fatal(err)
	}
	running := func() string {
		var allocs []struct {
			NodeName     string `json:"NodeName"`
			ClientStatus string `json:"ClientStatus"`
		}
		// A fresh client each time: CA rotation replaces the trust bundle.
		c, _ := s.loadCluster(ctx, d.Reader, id)
		fresh, _, err := s.apiClient(ctx, c, "")
		if err != nil {
			return ""
		}
		_ = fresh.Request(ctx, "GET", "job/sleeper/allocations", nil, &allocs)
		for _, a := range allocs {
			if a.ClientStatus == "running" {
				return a.NodeName
			}
		}
		return ""
	}
	waitRunning := func(stage string) string {
		for i := 0; i < 60; i++ {
			if n := running(); n != "" {
				return n
			}
			time.Sleep(2 * time.Second)
		}
		t.Fatalf("%s: job not running", stage)
		return ""
	}
	t.Logf("sleeper runs on %s", waitRunning("initial"))

	// Doctor (Docker is absent in the test hosts: warnings only).
	doc, err := s.Doctor(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range doc.Checks {
		if ch.Status == "FAIL" {
			t.Errorf("doctor FAIL: %+v", ch)
		}
	}
	t.Logf("doctor: %s", doc.Summary)

	// Gossip key rotation without restarts.
	oldGossip, _ := s.gossipKey(cl)
	e.mustSucceed(s.RotateGossip(ctx, actor, id))
	cl, _ = s.loadCluster(ctx, d.Reader, id)
	newGossip, _ := s.gossipKey(cl)
	api, _, _ = s.apiClient(ctx, cl, "")
	keysNow, _, _ := api.KeyringList(ctx)
	if newGossip == oldGossip || len(keysNow) != 1 || keysNow[newGossip] == 0 {
		t.Fatalf("gossip rotation: %v", keysNow)
	}

	// Managed configuration change on a client.
	m4, _ := db.GetClusterNode(ctx, d.Reader, id, ids[3])
	cfg4 := memberConfig(m4).ClientSettings
	cfg4.Meta = map[string]string{"rack": "r4"}
	e.mustSucceed(s.UpdateNodeConfig(ctx, actor, id, ids[3], NodeConfigInput{ClientSettings: cfg4}))
	var nd struct {
		Meta map[string]string `json:"Meta"`
	}
	m4, _ = db.GetClusterNode(ctx, d.Reader, id, ids[3])
	if err := api.Request(ctx, "GET", "node/"+memberConfig(m4).ClientNodeID, nil, &nd); err != nil || nd.Meta["rack"] != "r4" {
		t.Fatalf("client meta after config change: %v %v", nd.Meta, err)
	}

	// Certificates: renew, roll one node back, rotate the CA.
	before, _ := db.GetClusterNode(ctx, d.Reader, id, ids[0])
	time.Sleep(2 * time.Second)
	e.mustSucceed(s.RenewCerts(ctx, actor, id, false))
	renewed, _ := db.GetClusterNode(ctx, d.Reader, id, ids[0])
	if renewed.CertExpiresAt.Equal(before.CertExpiresAt) {
		t.Fatal("renewal must issue a new certificate")
	}
	e.mustSucceed(s.RollbackGeneration(ctx, actor, id, ids[0], false))
	rolled, _ := db.GetClusterNode(ctx, d.Reader, id, ids[0])
	if memberConfig(rolled).ConfigGeneration >= memberConfig(renewed).ConfigGeneration ||
		!rolled.CertExpiresAt.Truncate(time.Second).Equal(before.CertExpiresAt.Truncate(time.Second)) {
		t.Fatal("rollback must restore the previous generation and certificate")
	}
	healthy("after rollback")
	oldCA := cl.CACertPEM
	e.mustSucceed(s.RotateCA(ctx, actor, id, false))
	cl, _ = s.loadCluster(ctx, d.Reader, id)
	if certs, _ := pki.ParseCerts(cl.CACertPEM); len(certs) != 1 || cl.CACertPEM == oldCA {
		t.Fatal("CA rotation must end with only the new CA")
	}
	healthy("after CA rotation")

	// Snapshot, rolling upgrade with drained clients, restore.
	e.mustSucceed(s.CreateSnapshot(ctx, actor, id))
	snaps, _ := s.ListSnapshots(ctx, id)
	e.mustSucceed(s.Upgrade(ctx, actor, id, cluster.UpgradeInput{Version: to, UseProxy: &noProxy, Confirm: true, DrainClients: true}))
	rep = healthy("after upgrade")
	for _, n := range rep.Nodes {
		if n.Version != to || n.Eligibility == "ineligible" {
			t.Fatalf("after upgrade: %+v", n)
		}
	}
	if after, _ := s.ListSnapshots(ctx, id); len(after) != len(snaps)+1 || after[0].TriggerType != "pre_upgrade" {
		t.Fatalf("pre-upgrade snapshot missing: %+v", after)
	}
	waitRunning("after upgrade")
	e.mustSucceed(s.Restore(ctx, actor, id, snaps[0].ID, cluster.RestoreInput{}))
	healthy("after restore")

	// Scale in: the server_client (drain + remove-peer), then the client.
	e.mustSucceed(s.NodeRemove(ctx, actor, id, ids[4]))
	e.mustSucceed(s.NodeRemove(ctx, actor, id, ids[3]))
	rep = healthy("after remove")
	if rep.Voters != 3 || len(rep.Nodes) != 3 {
		t.Fatalf("after remove: %+v", rep)
	}
	n5, _ := db.GetNode(ctx, d.Reader, ids[4])
	sc, _ := hs.Connect(ctx, n5)
	if r, _ := sc.Run(ctx, "test -e "+Base+" && echo present || echo gone", sshx.RunOptions{Sudo: true}); strings.TrimSpace(string(r.Stdout)) != "gone" {
		t.Fatal("removed node must be wiped")
	}
	// The pinned job lost every eligible node: its allocation is no longer running there.
	if n := running(); n == "nn4" || n == "nn5" {
		t.Fatalf("allocation still on a removed node: %s", n)
	}

	e.mustSucceed(s.Uninstall(ctx, actor, id, "e2e-nomad"))
	if _, err := db.GetCluster(ctx, d.Reader, id); err == nil {
		t.Fatal("cluster must be deleted")
	}
	engine.Wait()
}
