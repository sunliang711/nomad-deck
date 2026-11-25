package jobs

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"nomad-deck/internal/jobspec"
)

func TestVisualWorkflow(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	s := e.s
	spec := &jobspec.JobSpec{
		Variables: []jobspec.Variable{{Name: "msg", Type: "string", Default: "hello", HasDefault: true}},
		Job: jobspec.Job{ID: "vis", Datacenters: []string{"*"}, Groups: []jobspec.Group{{Name: "g", Count: "1",
			Tasks: []jobspec.Task{{Name: "t", Driver: "raw_exec", Config: jobspec.Config{Command: "/bin/sleep", Args: []string{"3600"}},
				Env: []jobspec.KV{{Key: "MSG", Value: "var.msg"}}, Resources: &jobspec.Resources{CPU: "50", Memory: "32"}}}}}}}
	r, err := RenderSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	formSpec, _ := json.Marshal(spec)
	p := e.plan(PlanInput{InputType: "hcl", HCL: r.HCL, EditMode: "visual", FormSpec: formSpec, RendererVersion: r.RendererVersion})
	if _, err := s.Apply(ctx, e.caller, e.cl.ID, p.PlanID); err != nil {
		t.Fatal(err)
	}
	e.waitDeployment("vis")
	if _, err := s.Scale(ctx, e.caller.Actor, e.cl.ID, "default", "vis", ScaleInput{Group: "g", Count: 3}); err != nil {
		t.Fatal(err)
	}
	es, err := s.EditSourceOf(ctx, e.caller.Actor, e.cl.ID, "default", "vis")
	if err != nil || es.Drifted || es.EditMode != "visual" {
		t.Fatalf("edit source: %+v %v", es, err)
	}
	var got jobspec.JobSpec
	if err := json.Unmarshal(es.FormSpec, &got); err != nil || got.Job.Groups[0].Count != "3" || !strings.Contains(es.HCL, "count = 3") {
		t.Fatalf("scaling must update the visual spec and its HCL: %+v\n%s", got.Job.Groups[0], es.HCL)
	}
	// parse-to-visual checks the meaning with Nomad.
	vr, err := s.ParseToVisual(ctx, e.cl.ID, es.HCL, nil)
	if err != nil || !vr.Lossless || vr.SemanticEqual == nil || !*vr.SemanticEqual {
		t.Fatalf("parse to visual: %+v %v", vr, err)
	}
	withComment := "# note\n" + es.HCL
	vr, _ = s.ParseToVisual(ctx, e.cl.ID, withComment, nil)
	if vr.Lossless || vr.SemanticEqual == nil || !*vr.SemanticEqual {
		t.Fatalf("a comment is lost but the meaning stays: %+v", vr)
	}
	// json-to-visual from the live definition.
	d, _ := s.DefinitionOf(ctx, e.cl.ID, "default", "vis", nil)
	raw, _ := json.Marshal(d.Job)
	jr, err := s.JSONToVisual(ctx, e.cl.ID, raw, "")
	if err != nil || jr.HCL == "" || jr.Spec.Job.Groups[0].Tasks[0].Env[0].Value != "hello" {
		t.Fatalf("json to visual: %+v %v", jr, err)
	}
	o, err := s.Options(ctx, e.cl.ID)
	if err != nil || len(o.Namespaces) == 0 || len(o.Drivers) == 0 {
		t.Fatalf("options: %+v %v", o, err)
	}
}
