package jobs

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

const webHCL = `variable "password" {
  type = string
}

job "web" {
  datacenters = ["*"]

  group "g" {
    count = 1

    task "t" {
      driver = "raw_exec"

      config {
        command = "/bin/sleep"
        args    = ["3600"]
      }

      env {
        PASSWORD = var.password
      }

      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}
`

func code(err error) string {
	if e, ok := err.(*auth.Error); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func (e *env) plan(in PlanInput) *PlanResult {
	e.t.Helper()
	p, err := e.s.Plan(context.Background(), e.caller, e.cl.ID, in)
	if err != nil {
		e.t.Fatalf("plan: %v", err)
	}
	return p
}

func TestPlanApplyLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	s := e.s
	in := PlanInput{InputType: "hcl", HCL: webHCL, Variables: map[string]string{"password": "s3cr3t"}}
	p := e.plan(in)
	if p.JobID != "web" || p.Namespace != "default" || p.JobModifyIndex != 0 {
		t.Fatalf("plan: %+v", p)
	}
	// Plans are bound to the caller and single-use.
	other := e.caller
	other.SessionID = "sess2"
	if _, err := s.Apply(ctx, other, e.cl.ID, p.PlanID); code(err) != "plan_not_yours" {
		t.Fatalf("foreign session: %v", err)
	}
	p = e.plan(in)
	res, err := s.Apply(ctx, e.caller, e.cl.ID, p.PlanID)
	if err != nil || res.Status != db.RevConfirmed || res.Version != 0 {
		t.Fatalf("apply: %+v %v", res, err)
	}
	if _, err := s.Apply(ctx, e.caller, e.cl.ID, p.PlanID); code(err) != "plan_not_found" {
		t.Fatalf("plan reuse: %v", err)
	}
	// The submission carries the source but no variable values; the
	// revision keeps both encrypted.
	var sub struct {
		Source    string `json:"Source"`
		Variables string `json:"Variables"`
	}
	if err := e.raw().Request(ctx, "GET", "job/web/submission?version=0", nil, &sub); err != nil || sub.Source != webHCL || sub.Variables != "" {
		t.Fatalf("submission: %+v %v", sub, err)
	}
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, e.cl.ID, "default", "web")
	if len(revs) != 1 || strings.Contains(revs[0].JobJSONEncrypted, "s3cr3t") || revs[0].VariablesEncrypted == "" {
		t.Fatal("revision must hold the encrypted Job JSON and variables")
	}
	// Viewers get the safe summary only.
	d, err := s.Get(ctx, e.cl.ID, "default", "web", false)
	if err != nil || d.Job != nil || d.Summary.Groups[0].Tasks[0].Driver != "raw_exec" {
		t.Fatalf("viewer detail: %+v %v", d, err)
	}
	b, _ := json.Marshal(d)
	if bytes.Contains(b, []byte("s3cr3t")) || bytes.Contains(b, []byte("sleep")) {
		t.Fatalf("viewer projection leaks the definition: %s", b)
	}
	// Two plans of the same content; an external change in between makes
	// the first one fail with an index conflict.
	p1 := e.plan(in)
	p2 := e.plan(in)
	if p1.PlanID == p2.PlanID {
		t.Fatal("each plan gets its own record")
	}
	j, _ := getJob(ctx, e.raw(), "default", "web")
	j["Priority"] = 60
	if err := e.raw().Request(ctx, "POST", "jobs", map[string]any{"Job": j}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, e.caller, e.cl.ID, p1.PlanID); code(err) != "index_conflict" {
		t.Fatalf("stale plan must conflict: %v", err)
	}
	// The external change shows as drift.
	es, err := s.EditSourceOf(ctx, e.caller.Actor, e.cl.ID, "default", "web")
	if err != nil || !es.Drifted {
		t.Fatalf("drift: %+v %v", es, err)
	}
	p3 := e.plan(in)
	if _, err := s.Apply(ctx, e.caller, e.cl.ID, p3.PlanID); err != nil {
		t.Fatal(err)
	}
	es, _ = s.EditSourceOf(ctx, e.caller.Actor, e.cl.ID, "default", "web")
	if es.Drifted || es.HCL != webHCL || es.Variables["password"] != "s3cr3t" {
		t.Fatalf("authoritative source after apply: %+v", es)
	}

	// Scaling: confirmed, literal count rewritten, not a drift.
	e.waitDeployment("web")
	sr, err := s.Scale(ctx, e.caller.Actor, e.cl.ID, "default", "web", ScaleInput{Group: "g", Count: 2, Reason: "load"})
	if err != nil || sr.Status != db.RevConfirmed || sr.Overridden {
		t.Fatalf("scale: %+v %v", sr, err)
	}
	es, _ = s.EditSourceOf(ctx, e.caller.Actor, e.cl.ID, "default", "web")
	if es.Drifted || !strings.Contains(es.HCL, "count = 2") {
		t.Fatalf("after scale: drifted=%v\n%s", es.Drifted, es.HCL)
	}
	var st struct {
		TaskGroups map[string]struct {
			Events []struct {
				Meta map[string]any `json:"Meta"`
			} `json:"Events"`
		} `json:"TaskGroups"`
	}
	_ = e.raw().Request(ctx, "GET", "job/web/scale", nil, &st)
	if ev := st.TaskGroups["g"].Events; len(ev) == 0 || ev[0].Meta["nomaddeck_operation_id"] != sr.OperationID {
		t.Fatalf("scaling event must carry the operation ID: %+v", st)
	}

	// Reconciliation of an in-doubt scale: the event with our operation ID
	// confirms it; an unknown operation on an unchanged job fails.
	e.waitDeployment("web")
	cur, _ := getJob(ctx, e.raw(), "default", "web")
	if err := e.raw().Request(ctx, "POST", "job/web/scale", map[string]any{"Count": 3, "Target": map[string]string{"Group": "g"},
		"Meta": map[string]string{"nomaddeck_operation_id": "op-lost"}}, nil); err != nil {
		t.Fatal(err)
	}
	lost := &db.JobRevision{ID: db.NewID(), ClusterID: e.cl.ID, Namespace: "default", JobID: "web", Source: "scale", EditMode: "json",
		OperationID: "op-lost", BaseJobModifyIndex: u64(cur["JobModifyIndex"]), SubmitStatus: db.RevInDoubt,
		PlanSummary: `{"group":"g","from":2,"to":3}`, CreatedAt: time.Now()}
	_ = db.InsertRevision(ctx, s.DB.Writer, lost)
	after, _ := getJob(ctx, e.raw(), "default", "web")
	never := &db.JobRevision{ID: db.NewID(), ClusterID: e.cl.ID, Namespace: "default", JobID: "web", Source: "scale", EditMode: "json",
		OperationID: "op-never", BaseJobModifyIndex: u64(after["JobModifyIndex"]), SubmitStatus: db.RevInDoubt,
		PlanSummary: `{"group":"g","from":3,"to":4}`, CreatedAt: time.Now()}
	_ = db.InsertRevision(ctx, s.DB.Writer, never)
	if err := s.Reconcile(ctx, e.cl.ID, "default", "web"); err != nil {
		t.Fatal(err)
	}
	if r, _ := db.GetRevision(ctx, s.DB.Reader, lost.ID); r.SubmitStatus != db.RevConfirmed || r.RemoteJobVersion == nil {
		t.Fatalf("lost scale must be confirmed: %+v", r)
	}
	if r, _ := db.GetRevision(ctx, s.DB.Reader, never.ID); r.SubmitStatus != db.RevFailed {
		t.Fatalf("never-sent scale must fail: %+v", r)
	}

	// Revert to version 0.
	e.waitDeployment("web")
	rr, err := s.Revert(ctx, e.caller.Actor, e.cl.ID, "default", "web", 0)
	if err != nil || rr.Status != db.RevConfirmed {
		t.Fatalf("revert: %+v %v", rr, err)
	}
	cur, _ = getJob(ctx, e.raw(), "default", "web")
	if u64(obj(list(cur["TaskGroups"])[0])["Count"]) != 1 {
		t.Fatal("revert must restore count 1")
	}

	// Stop archives, start resubmits, purge removes; then the archive is
	// planned as JSON.
	if _, err := s.Stop(ctx, e.caller.Actor, e.cl.ID, "default", "web"); err != nil {
		t.Fatal(err)
	}
	d, _ = s.Get(ctx, e.cl.ID, "default", "web", true)
	if !d.Stop || d.Archived == nil || d.Archived.Source != "stop_archive" {
		t.Fatalf("after stop: %+v", d)
	}
	if _, err := s.Start(ctx, e.caller.Actor, e.cl.ID, "default", "web"); err != nil {
		t.Fatal(err)
	}
	if err := s.Purge(ctx, e.caller.Actor, e.cl.ID, "default", "web", "wrong"); err == nil {
		t.Fatal("purge needs the job ID")
	}
	if _, err := s.Stop(ctx, e.caller.Actor, e.cl.ID, "default", "web"); err != nil {
		t.Fatal(err)
	}
	if err := s.Purge(ctx, e.caller.Actor, e.cl.ID, "default", "web", "web"); err != nil {
		t.Fatal(err)
	}
	_, err = s.Start(ctx, e.caller.Actor, e.cl.ID, "default", "web")
	if code(err) != "remote_definition_gone" {
		t.Fatalf("start after purge: %v", err)
	}
	d, err = s.Get(ctx, e.cl.ID, "default", "web", true)
	if err != nil || d.Archived == nil {
		t.Fatalf("archive after purge: %+v %v", d, err)
	}
	p = e.plan(PlanInput{InputType: "json", RevisionID: d.Archived.ID})
	res, err = s.Apply(ctx, e.caller, e.cl.ID, p.PlanID)
	if err != nil {
		t.Fatal(err)
	}
	es, _ = s.EditSourceOf(ctx, e.caller.Actor, e.cl.ID, "default", "web")
	if es.Drifted || es.HCL == "" || es.Variables["password"] != "s3cr3t" {
		t.Fatalf("archive resubmission keeps source and variables: drifted=%v vars=%v hcl=%d", es.Drifted, es.Variables, len(es.HCL))
	}

	// Export.
	var buf bytes.Buffer
	if err := s.Export(ctx, e.caller.Actor, e.cl.ID, ExportInput{}, &buf); err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if len(zr.File) != 1 || zr.File[0].Name != "default/web.nomad.hcl" {
		t.Fatalf("export: %v", zr.File)
	}
}

func TestMatchesSubmitted(t *testing.T) {
	local, _ := decodeJob([]byte(`{"ID":"a","Priority":50,"Meta":null,"TaskGroups":[{"Name":"g","Count":1,"Tasks":[{"Name":"t","Env":{"A":"1"}}]}]}`))
	remote, _ := decodeJob([]byte(`{"ID":"a","Priority":50,"Version":3,"JobModifyIndex":9,"TaskGroups":[{"Name":"g","Count":1,"Tasks":[{"Name":"t","Env":{"A":"1"},"Identities":[{"Name":"vault_default"}]}]}]}`))
	if !matchesSubmitted(local, remote) {
		t.Fatal("server-added fields must be ignored")
	}
	tampered, _ := decodeJob([]byte(`{"ID":"a","Priority":50,"TaskGroups":[{"Name":"g","Count":1,"Tasks":[{"Name":"t","Env":{"A":"2"}}]}]}`))
	if matchesSubmitted(tampered, remote) {
		t.Fatal("changed values must not match")
	}
}

func TestRewriteCount(t *testing.T) {
	out, ok := RewriteCount(webHCL, "g", 5)
	if !ok || !strings.Contains(out, "count = 5") || !strings.Contains(out, "PASSWORD = var.password") {
		t.Fatalf("rewrite: %v\n%s", ok, out)
	}
	withVar := strings.Replace(webHCL, "count = 1", "count = var.n", 1)
	if _, ok := RewriteCount(withVar, "g", 5); ok {
		t.Fatal("a variable count cannot be rewritten")
	}
}

func TestPreflightAndPlanDiagnostics(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	s := e.s

	// A host volume that does not exist on the dev node deterministically triggers
	// both preflight_errors and Nomad FailedTGAllocs regardless of host Docker.
	unschedulableHCL := `job "need-vol" {
  datacenters = ["dc1"]
  group "g" {
    count = 1
    volume "data" {
      type   = "host"
      source = "pgdata"
    }
    task "app" {
      driver = "raw_exec"
      config {
        command = "/bin/sleep"
        args    = ["5"]
      }
      volume_mount {
        volume      = "data"
        destination = "/data"
      }
      resources {
        cpu    = 50
        memory = 32
      }
    }
  }
}`
	j, _, err := s.ValidateInput(ctx, e.cl.ID, PlanInput{InputType: "hcl", HCL: unschedulableHCL})
	if err != nil {
		t.Fatalf("ValidateInput: %v", err)
	}
	errs := s.PreflightJob(ctx, e.cl.ID, j)
	if len(errs) == 0 || !strings.Contains(strings.Join(errs, "\n"), "pgdata") {
		t.Fatalf("expected missing host volume preflight error, got %v", errs)
	}

	p, err := s.Plan(ctx, e.caller, e.cl.ID, PlanInput{InputType: "hcl", HCL: unschedulableHCL})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if p.CanApply || len(p.PreflightErrors) == 0 || len(p.SchedulingErrors) == 0 {
		t.Fatalf("expected blocking plan result with preflight+scheduling errors, got %+v", p)
	}
	if _, err := s.Apply(ctx, e.caller, e.cl.ID, p.PlanID); code(err) != "preflight_failed" {
		t.Fatalf("expected preflight_failed on Apply, got %v", err)
	}
	// Plan must still exist after preflight_failed so ignore_preflight can submit it.
	if _, err := s.ApplyWithOptions(ctx, e.caller, e.cl.ID, p.PlanID, true); err != nil {
		t.Fatalf("ApplyWithOptions(ignore=true): %v", err)
	}
	if _, err := s.Stop(ctx, e.caller.Actor, e.cl.ID, "default", "need-vol"); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := s.Start(ctx, e.caller.Actor, e.cl.ID, "default", "need-vol"); code(err) != "preflight_failed" {
		t.Fatalf("expected preflight_failed on Start, got %v", err)
	}
	if _, err := s.StartWithOptions(ctx, e.caller.Actor, e.cl.ID, "default", "need-vol", true); err != nil {
		t.Fatalf("StartWithOptions(ignore=true): %v", err)
	}

	// Missing datacenter check via ValidateInput/PreflightJob.
	scopeHCL := `job "bad-scope" {
  datacenters = ["dc-other"]
  group "g" {
    task "t" {
      driver = "raw_exec"
      config {
        command = "/bin/sleep"
        args    = ["5"]
      }
    }
  }
}`
	vj, _, err := s.ValidateInput(ctx, e.cl.ID, PlanInput{InputType: "hcl", HCL: scopeHCL})
	if err != nil {
		t.Fatalf("ValidateInput scope: %v", err)
	}
	verrs := strings.Join(s.PreflightJob(ctx, e.cl.ID, vj), "\n")
	if !strings.Contains(verrs, "Datacenter") {
		t.Fatalf("expected datacenter preflight error, got:\n%s", verrs)
	}

	// Bridge network without CNI (nomaddev cluster_nodes has h1 with cni=false).
	bridgeHCL := `job "need-cni" {
  datacenters = ["dc1"]
  group "g" {
    network {
      mode = "bridge"
    }
    task "t" {
      driver = "raw_exec"
      config {
        command = "/bin/sleep"
        args    = ["5"]
      }
    }
  }
}`
	bj, _, err := s.ValidateInput(ctx, e.cl.ID, PlanInput{InputType: "hcl", HCL: bridgeHCL})
	if err != nil {
		t.Fatalf("ValidateInput bridge: %v", err)
	}
	berrs := strings.Join(s.PreflightJob(ctx, e.cl.ID, bj), "\n")
	if !strings.Contains(berrs, "CNI") {
		t.Fatalf("expected CNI preflight error, got:\n%s", berrs)
	}
}

func TestPreflightDriversAndCrossNodeMismatch(t *testing.T) {
	var nodesPayload any
	var nodeDetails map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/namespaces":
			_, _ = w.Write([]byte(`[{"Name":"default"}]`))
		case r.URL.Path == "/v1/node/pools":
			_, _ = w.Write([]byte(`[{"Name":"default"}]`))
		case r.URL.Path == "/v1/nodes":
			_ = json.NewEncoder(w).Encode(nodesPayload)
		case strings.HasPrefix(r.URL.Path, "/v1/node/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/node/")
			_ = json.NewEncoder(w).Encode(nodeDetails[id])
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c, err := nomad.NewClient(srv.URL, "", "", nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	ctx := context.Background()

	// Node with only exec healthy: docker and raw_exec must both report clear errors.
	nodesPayload = []map[string]any{{
		"ID": "node-1", "Name": "c1", "Datacenter": "dc1", "NodePool": "default",
		"Status": "ready", "SchedulingEligibility": "eligible",
		"Drivers": map[string]any{"exec": map[string]any{"Detected": true, "Healthy": true}},
	}}
	dockerJob := Job{"Namespace": "default", "Datacenters": []any{"dc1"}, "TaskGroups": []any{
		map[string]any{"Name": "g", "Tasks": []any{map[string]any{"Name": "web", "Driver": "docker"}}},
	}}
	if msg := strings.Join(s.Preflight(ctx, c, "c", dockerJob), "\n"); !strings.Contains(msg, "Docker 管理") {
		t.Fatalf("expected docker missing guidance, got: %s", msg)
	}
	rawJob := Job{"Namespace": "default", "Datacenters": []any{"dc1"}, "TaskGroups": []any{
		map[string]any{"Name": "g", "Tasks": []any{map[string]any{"Name": "sh", "Driver": "raw_exec"}}},
	}}
	if msg := strings.Join(s.Preflight(ctx, c, "c", rawJob), "\n"); !strings.Contains(msg, "节点插件/配置") {
		t.Fatalf("expected raw_exec missing guidance, got: %s", msg)
	}

	// Docker detected but unhealthy.
	nodesPayload = []map[string]any{{
		"ID": "node-1", "Name": "c1", "Datacenter": "dc1", "NodePool": "default",
		"Status": "ready", "SchedulingEligibility": "eligible",
		"Drivers": map[string]any{"docker": map[string]any{"Detected": true, "Healthy": false}},
	}}
	if msg := strings.Join(s.Preflight(ctx, c, "c", dockerJob), "\n"); !strings.Contains(msg, "不健康") {
		t.Fatalf("expected unhealthy docker message, got: %s", msg)
	}

	// Missing namespace and missing node_pool checks.
	nsPoolJob := Job{"Namespace": "missing-ns", "NodePool": "gpu", "Datacenters": []any{"dc1"}, "TaskGroups": []any{
		map[string]any{"Name": "g", "Tasks": []any{map[string]any{"Name": "sh", "Driver": "exec"}}},
	}}
	if msg := strings.Join(s.Preflight(ctx, c, "c", nsPoolJob), "\n"); !strings.Contains(msg, "missing-ns") || !strings.Contains(msg, "gpu") {
		t.Fatalf("expected missing namespace and node_pool errors, got: %s", msg)
	}

	// Cross-node mismatch: node-1 has docker, node-2 has pgdata volume, neither has both.
	nodesPayload = []map[string]any{
		{
			"ID": "node-1", "Name": "c1", "Datacenter": "dc1", "NodePool": "default",
			"Status": "ready", "SchedulingEligibility": "eligible",
			"Drivers": map[string]any{"docker": map[string]any{"Detected": true, "Healthy": true}},
		},
		{
			"ID": "node-2", "Name": "c2", "Datacenter": "dc1", "NodePool": "default",
			"Status": "ready", "SchedulingEligibility": "eligible",
			"Drivers": map[string]any{"raw_exec": map[string]any{"Detected": true, "Healthy": true}},
		},
	}
	nodeDetails = map[string]any{
		"node-1": map[string]any{"ID": "node-1", "HostVolumes": map[string]any{}},
		"node-2": map[string]any{"ID": "node-2", "HostVolumes": map[string]any{"pgdata": map[string]any{}}},
	}
	comboJob := Job{"Namespace": "default", "Datacenters": []any{"dc1"}, "TaskGroups": []any{
		map[string]any{
			"Name":    "db",
			"Volumes": map[string]any{"data": map[string]any{"Type": "host", "Source": "pgdata"}},
			"Tasks":   []any{map[string]any{"Name": "pg", "Driver": "docker"}},
		},
	}}
	if msg := strings.Join(s.Preflight(ctx, c, "c", comboJob), "\n"); !strings.Contains(msg, "没有单个 Client 节点同时满足全部条件") {
		t.Fatalf("expected cross-node mismatch error, got: %s", msg)
	}
}

func TestExplainFailedTGAllocsAndDriverMessages(t *testing.T) {
	reasons := ExplainFailedTGAllocs(map[string]any{
		"web": map[string]any{
			"NodesEvaluated":     2,
			"ConstraintFiltered": map[string]any{`Driver "docker" not healthy`: 2},
			"DimensionExhausted": map[string]any{"cpu": 1},
		},
	})
	joined := strings.Join(reasons, "\n")
	if !strings.Contains(joined, "驱动未就绪") || !strings.Contains(joined, "资源或端口不足") {
		t.Fatalf("unexpected reasons: %v", reasons)
	}
	if msg := driverMissingMessage("t", "raw_exec", false); !strings.Contains(msg, "raw_exec") || !strings.Contains(msg, "节点插件/配置") {
		t.Fatalf("expected raw_exec hint, got: %s", msg)
	}
}

func TestPreflightDockerBindAndStaticPortConflicts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/namespaces":
			_, _ = w.Write([]byte(`[{"Name":"default"}]`))
		case r.URL.Path == "/v1/node/pools":
			_, _ = w.Write([]byte(`[{"Name":"default"}]`))
		case r.URL.Path == "/v1/nodes":
			_, _ = w.Write([]byte(`[{"ID":"node-1","Name":"n1","Datacenter":"dc1","NodePool":"default","Status":"ready","SchedulingEligibility":"eligible","Drivers":{"docker":{"Detected":true,"Healthy":true}}}]`))
		case r.URL.Path == "/v1/node/node-1":
			_, _ = w.Write([]byte(`{"ID":"node-1","Drivers":{"docker":{"Detected":true,"Healthy":true,"Attributes":{"driver.docker.volumes.enabled":"false"}}}}`))
		case r.URL.Path == "/v1/node/node-1/allocations":
			_, _ = w.Write([]byte(`[{"JobID":"caddy","Namespace":"default","ClientStatus":"running","DesiredStatus":"run","AllocatedResources":{"Shared":{"Ports":[{"Value":80},{"Value":443}]}}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c, err := nomad.NewClient(srv.URL, "", "", nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	ctx := context.Background()

	job := Job{
		"ID":          "nginx-gateway",
		"Namespace":   "default",
		"Datacenters": []any{"dc1"},
		"TaskGroups": []any{
			map[string]any{
				"Name": "gateway",
				"Networks": []any{
					map[string]any{
						"ReservedPorts": []any{
							map[string]any{"Label": "http", "Value": float64(80)},
							map[string]any{"Label": "https", "Value": float64(443)},
						},
					},
				},
				"Tasks": []any{
					map[string]any{
						"Name":   "nginx",
						"Driver": "docker",
						"Config": map[string]any{
							"volumes": []any{"/opt/nomad-deck/nomad/etc/nomad.d/tls/vault-ca.crt:/etc/ssl/vault-ca.crt:ro"},
						},
					},
				},
			},
		},
	}

	issues := strings.Join(s.Preflight(ctx, c, "c", job), "\n")
	if !strings.Contains(issues, "Docker 允许卷挂载") {
		t.Fatalf("expected docker volumes disabled error, got:\n%s", issues)
	}
	if !strings.Contains(issues, "80（被 caddy 占用）") {
		t.Fatalf("expected static port conflict mentioning caddy, got:\n%s", issues)
	}

	// Updating the same job "caddy" must NOT conflict with its own ports.
	job["ID"] = "caddy"
	sameJobIssues := strings.Join(s.Preflight(ctx, c, "c", job), "\n")
	if strings.Contains(sameJobIssues, "被 caddy 占用") {
		t.Fatalf("updating caddy should not conflict with itself, got:\n%s", sameJobIssues)
	}
}

// waitDeployment waits until the latest deployment of a job is no longer running.
func (e *env) waitDeployment(jobID string) {
	e.t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		var dep struct {
			Status string `json:"Status"`
		}
		if err := e.raw().Request(context.Background(), "GET", "job/"+jobID+"/deployment", nil, &dep); err == nil &&
			(dep.Status == "successful" || dep.Status == "failed" || dep.Status == "cancelled") {
			return
		}
		time.Sleep(time.Second)
	}
	e.t.Fatal("deployment did not finish")
}
