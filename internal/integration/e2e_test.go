//go:build integration

// End-to-end test of the Nomad -> Vault integration and Docker management
// against real Linux hosts (systemd + sshd). See "make it-integration".
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
	"nomad-deck/internal/vault"
)

type env struct {
	t   *testing.T
	d   *db.DB
	dir string
}

func (e *env) ok(task *db.OperationTask, err error) {
	e.t.Helper()
	if err != nil {
		e.t.Fatalf("submit: %v", err)
	}
	if task == nil {
		return
	}
	ctx := context.Background()
	for deadline := time.Now().Add(40 * time.Minute); time.Now().Before(deadline); time.Sleep(time.Second) {
		got, _ := db.GetTask(ctx, e.d.Reader, task.ID)
		if got.Status == db.TaskPending || got.Status == db.TaskRunning {
			continue
		}
		if got.Status != db.TaskSuccess {
			steps, _ := db.ListSteps(ctx, e.d.Reader, task.ID)
			var b strings.Builder
			for _, st := range steps {
				data, _ := os.ReadFile(filepath.Join(e.dir, st.LogPath))
				b.WriteString("## " + st.Name + " [" + st.Status + "] " + st.ErrorMessage + "\n" + string(data))
			}
			e.t.Fatalf("%s: %s %s\n%s", got.Action, got.Status, got.ErrorMessage, b.String())
		}
		return
	}
	e.t.Fatalf("task %s did not finish", task.Action)
}

func doctorClean(t *testing.T, rep *cluster.DoctorReport, stage string) {
	t.Helper()
	for _, c := range rep.Checks {
		if c.Status == "FAIL" {
			t.Errorf("%s doctor FAIL: %+v", stage, c)
		}
	}
	t.Logf("%s doctor: %s", stage, rep.Summary)
	if t.Failed() {
		t.FailNow()
	}
}

func TestE2EIntegration(t *testing.T) {
	hostList := os.Getenv("ND_E2E_HOSTS")
	if hostList == "" {
		t.Skip("ND_E2E_HOSTS not set")
	}
	names := strings.Split(hostList, ",")
	if len(names) < 3 {
		t.Fatal("need 3 hosts")
	}
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "e2e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{6}, 32))
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	rec := &audit.Recorder{DB: d, Log: log}
	pool := sshx.NewPool(8)
	defer pool.Close()
	hs := &hosts.Service{DB: d, Keys: keys, Audit: rec, Pool: pool, LocalMachineID: "e2e-runner"}
	engine := ops.NewEngine(d, log, dir)
	rel := &release.Provider{DB: d, CacheDir: filepath.Join(dir, "cache")}
	px := &netx.Manager{DB: d, Keys: keys}
	ns := &nomad.Service{DB: d, Keys: keys, Audit: rec, Hosts: hs, Ops: engine, Releases: rel, Proxy: px, DataDir: dir, Log: log,
		PollEvery: time.Second, JoinTimeout: 4 * time.Minute, DrainDeadline: 3 * time.Minute}
	vs := &vault.Service{DB: d, Keys: keys, Audit: rec, Hosts: hs, Ops: engine, Releases: rel, Proxy: px, DataDir: dir, Log: log,
		PollEvery: time.Second, JoinTimeout: 4 * time.Minute}
	is := &Service{DB: d, Keys: keys, Audit: rec, Ops: engine, Nomad: ns, Vault: vs, Log: log, PollEvery: time.Second}
	is.Wire()
	e := &env{t: t, d: d, dir: dir}
	actor := audit.Actor{Name: "e2e"}
	noProxy := false
	if _, err := hs.GenerateKey(ctx, actor, "e2e"); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, n := range names[:3] {
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
	sh := func(nodeID, cmd string) string {
		t.Helper()
		n, _ := db.GetNode(ctx, d.Reader, nodeID)
		c, err := hs.Connect(ctx, n)
		if err != nil {
			t.Fatal(err)
		}
		r, err := c.Run(ctx, cmd, sshx.RunOptions{Sudo: true})
		if err != nil {
			t.Fatalf("%s: %v %s", cmd, err, r.Stderr)
		}
		return strings.TrimSpace(string(r.Stdout))
	}
	hc := http.DefaultClient
	nv, _ := (&release.HashiCorp{}).Versions(ctx, hc, "nomad")
	vv, _ := (&release.HashiCorp{}).Versions(ctx, hc, "vault")

	// Nomad: single server_client on nn1, client nn2.
	nc, err := ns.CreateCluster(ctx, actor, nomad.CreateInput{Name: "e2e-nomad", Mode: "single",
		ClientDefaults: nomad.ClientSettings{RawExec: true, CPUTotalCompute: 4000},
		Nodes:          []cluster.MemberInput{{NodeID: ids[0]}}})
	if err != nil {
		t.Fatal(err)
	}
	e.ok(ns.Deploy(ctx, actor, nc.ID, cluster.DeployInput{Version: nv[0], UseProxy: &noProxy}))
	e.ok(ns.NodeJoin(ctx, actor, nc.ID, ids[1], cluster.JoinInput{Role: nomad.RoleClient, UseProxy: &noProxy}))

	// Docker on nn2: install the previous patch, change the config, upgrade in place.
	sh(ids[1], "apt-get update -qq >/dev/null")
	var n2 *db.Node
	if _, err := hs.Test(ctx, actor, ids[1]); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Writer.Exec(`UPDATE nodes SET time_sync = 'synced' WHERE id = ?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	n2, _ = db.GetNode(ctx, d.Reader, ids[1])
	target, err := func() (release.DockerTarget, error) {
		var probe struct {
			Raw map[string]string `json:"raw"`
		}
		_ = jsonUnmarshal(n2.ProbeJSON, &probe)
		return release.DockerTargetFromProbe(probe.Raw, n2.Arch)
	}()
	if err != nil {
		t.Fatal(err)
	}
	ix, err := rel.Docker(ctx).Index(ctx, hc, target, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The newest pair of consecutive patches of one minor (in-place upgrade).
	dv := ix.EngineVersions()
	newest, prev := "", ""
	have := map[string]bool{}
	for _, v := range dv {
		have[v] = true
	}
	for _, v := range dv {
		i := strings.LastIndex(v, ".")
		p := 0
		if _, err := fmt.Sscanf(v[i+1:], "%d", &p); err == nil && p > 0 && have[fmt.Sprintf("%s.%d", v[:i], p-1)] {
			newest, prev = v, fmt.Sprintf("%s.%d", v[:i], p-1)
			break
		}
	}
	if prev == "" {
		t.Fatalf("no consecutive Docker patch versions in %v", dv)
	}
	t.Logf("Docker %s, upgrading in place to %s", prev, newest)
	e.ok(ns.InstallDocker(ctx, actor, ids[1], nomad.DockerInstallInput{Version: prev, UseProxy: &noProxy}, false))
	if got := sh(ids[1], "docker version --format '{{.Server.Version}}'"); got != prev {
		t.Fatalf("docker version %q", got)
	}
	if !strings.Contains(sh(ids[1], "cat "+nomad.DockerDaemonJSON), `"live-restore": true`) {
		t.Fatal("managed daemon.json must enable live-restore")
	}
	if !strings.Contains(sh(ids[1], "apt-mark showhold"), "docker-ce") {
		t.Fatal("docker packages must be held")
	}
	e.ok(ns.UpdateDockerConfig(ctx, actor, ids[1], nomad.DockerConfigInput{DockerConfig: nomad.DockerConfig{LogMaxSize: "20m", LogMaxFile: 2}}))
	if !strings.Contains(sh(ids[1], "cat "+nomad.DockerDaemonJSON), `"max-size": "20m"`) {
		t.Fatal("config change not applied")
	}
	sh(ids[1], "docker run -d --name keep busybox:1.36 sleep 3600 >/dev/null")
	keepID := sh(ids[1], "docker inspect -f '{{.Id}}' keep")
	plan, err := ns.PlanDockerUpgrade(ctx, nc.ID, newest)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("docker upgrade plan: %+v", plan.Items)
	e.ok(ns.UpgradeDocker(ctx, actor, ids[1], nomad.DockerInstallInput{Version: newest, UseProxy: &noProxy}))
	if got := sh(ids[1], "docker version --format '{{.Server.Version}}'"); got != newest {
		t.Fatalf("docker after upgrade %q", got)
	}
	if sh(ids[1], "docker inspect -f '{{.Id}} {{.State.Running}}' keep") != keepID+" true" {
		t.Fatal("container must survive an in-place patch upgrade")
	}

	// Vault: single node on nn3, KV v2 with a secret.
	vc, err := vs.CreateCluster(ctx, actor, vault.CreateInput{Name: "e2e-vault", Mode: "single", Nodes: []vault.MemberInput{{NodeID: ids[2]}}})
	if err != nil {
		t.Fatal(err)
	}
	e.ok(vs.Deploy(ctx, actor, vc.ID, vault.DeployInput{Version: vv[0], UseProxy: &noProxy, ConfirmSwap: true}))
	e.ok(vs.Init(ctx, actor, vc.ID, vault.InitInput{}))
	admin, err := vs.AdminClient(ctx, vc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.Request(ctx, "POST", "sys/mounts/secret", map[string]any{"type": "kv", "options": map[string]string{"version": "2"}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := admin.Request(ctx, "POST", "secret/data/apps/web", map[string]any{"data": map[string]string{"password": "s3cr3t"}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := ns.PutNamespace(ctx, actor, nc.ID, nomad.Namespace{Name: "other"}, true); err != nil {
		t.Fatal(err)
	}

	// Integration: plan, apply, real login, denied namespace.
	iv, err := is.Create(ctx, actor, Input{Name: "e2e", SourceClusterID: nc.ID, TargetClusterID: vc.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := is.PutRole(ctx, actor, iv.ID, "", RoleInput{RoleName: "web", SecretPaths: []string{"secret/apps/web"},
		BoundClaims: map[string]string{"nomad_namespace": "default"}}); err != nil {
		t.Fatal(err)
	}
	p, err := is.PlanFor(ctx, iv.ID)
	if err != nil || len(p.Errors) > 0 || p.Scope != "vault_and_nomad" {
		t.Fatalf("plan: %+v %v", p, err)
	}
	e.ok(is.Apply(ctx, actor, iv.ID, ApplyInput{ConfirmSingle: true}))
	login := DoctorInput{LoginRole: "web", SecretPath: "secret/apps/web", DeniedNamespace: "other"}
	rep, err := is.Doctor(ctx, actor, iv.ID, login)
	if err != nil {
		t.Fatal(err)
	}
	doctorClean(t, rep, "after apply")

	// A role-only change touches Vault only: no Nomad generation changes.
	gens := func() string {
		ms, _ := db.ListClusterNodes(ctx, d.Reader, nc.ID)
		var b strings.Builder
		for _, m := range ms {
			b.WriteString(m.NodeConfigJSON)
		}
		return b.String()
	}
	before := gens()
	if _, err := is.PutRole(ctx, actor, iv.ID, "", RoleInput{RoleName: "per-job", PolicyMode: "templated",
		BoundClaims: map[string]string{"nomad_namespace": "other"}}); err != nil {
		t.Fatal(err)
	}
	if p, _ := is.PlanFor(ctx, iv.ID); p.Scope != "vault_only" {
		t.Fatalf("role-only change must be vault_only: %+v", p)
	}
	e.ok(is.Apply(ctx, actor, iv.ID, ApplyInput{ConfirmSingle: true}))
	if gens() != before {
		t.Fatal("a role-only apply must not touch Nomad")
	}

	// CA rotations keep the trust in both directions.
	e.ok(vs.RotateCA(ctx, actor, vc.ID, true))
	rep, _ = is.Doctor(ctx, actor, iv.ID, login)
	doctorClean(t, rep, "after Vault CA rotation")
	e.ok(ns.RotateCA(ctx, actor, nc.ID, true))
	rep, _ = is.Doctor(ctx, actor, iv.ID, login)
	doctorClean(t, rep, "after Nomad CA rotation")

	// Uninstall is refused while the integration exists; teardown removes both sides.
	if _, err := ns.Uninstall(ctx, actor, nc.ID, "e2e-nomad"); err == nil {
		t.Fatal("uninstall must be refused while an integration references the cluster")
	}
	e.ok(is.Delete(ctx, actor, iv.ID, ApplyInput{ConfirmSingle: true}))
	if mounts, _ := admin.ListAuth(ctx); mounts["jwt-nomad-e2e-nomad/"].Type != "" {
		t.Fatal("JWT mount must be removed")
	}
	if strings.Contains(sh(ids[0], "ls "+nomad.ConfigLink+"/"), "60-vault.hcl") {
		t.Fatal("60-vault.hcl must be removed")
	}
	e.ok(ns.Uninstall(ctx, actor, nc.ID, "e2e-nomad"))
	e.ok(vs.Uninstall(ctx, actor, vc.ID, "e2e-vault"))
	engine.Wait()
}

func jsonUnmarshal(s string, v any) error { return json.Unmarshal([]byte(s), v) }
