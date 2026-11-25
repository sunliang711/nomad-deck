package jobs

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
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
