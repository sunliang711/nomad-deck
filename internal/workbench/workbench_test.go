package workbench

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/nomaddev"
)

var actor = audit.Actor{ID: "a1", Name: "root"}

func code(err error) string {
	if e, ok := err.(*auth.Error); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func setup(t *testing.T) (*Service, *nomaddev.Env) {
	dev := nomaddev.Start(t)
	s := &Service{DB: dev.DB, Audit: dev.Audit, Nomad: dev.Nomad, Hub: &Hub{Idle: time.Second, Wait: 2 * time.Second}}
	s.Init()
	return s, dev
}

func register(t *testing.T, dev *nomaddev.Env, job map[string]any) {
	t.Helper()
	if err := dev.Raw().Request(context.Background(), "POST", "jobs", map[string]any{"Job": job}, nil); err != nil {
		t.Fatal(err)
	}
}

func sleeper(id string) map[string]any {
	return map[string]any{"ID": id, "Name": id, "Type": "service", "Datacenters": []string{"*"},
		"TaskGroups": []any{map[string]any{"Name": "g", "Count": 1, "Tasks": []any{map[string]any{"Name": "t", "Driver": "raw_exec",
			"Config":    map[string]any{"command": "/bin/sleep", "args": []string{"3600"}},
			"Env":       map[string]string{"SECRET": "hunter2"},
			"Resources": map[string]any{"CPU": 50, "MemoryMB": 32}}}}}}
}

func recv(t *testing.T, ch <-chan Event, want func(Event) bool) Event {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		select {
		case ev := <-ch:
			if want(ev) {
				return ev
			}
		case <-deadline:
			t.Fatal("no matching event")
		}
	}
}

func TestSharedWatch(t *testing.T) {
	s, dev := setup(t)
	id := dev.Cluster.ID
	a, cancelA, err := s.Hub.Subscribe(id, "jobs")
	if err != nil {
		t.Fatal(err)
	}
	b, cancelB, _ := s.Hub.Subscribe(id, "jobs")
	if s.Hub.Started() != 1 {
		t.Fatalf("two subscribers must share one upstream query, started %d", s.Hub.Started())
	}
	recv(t, a, func(e Event) bool { return e.Error == "" })
	register(t, dev, sleeper("web"))
	has := func(e Event) bool { return strings.Contains(string(e.Data), `"web"`) }
	recv(t, a, has)
	recv(t, b, has)
	// Allocation topic data never carries the embedded job definition.
	al, cancelAl, _ := s.Hub.Subscribe(id, "allocs/default/web")
	ev := recv(t, al, func(e Event) bool { return strings.Contains(string(e.Data), `"ID"`) })
	if strings.Contains(string(ev.Data), "hunter2") {
		t.Fatal("allocation stubs must not carry the job definition")
	}
	cancelAl()
	cancelA()
	cancelB()
	time.Sleep(4 * time.Second)
	c, cancelC, _ := s.Hub.Subscribe(id, "jobs")
	defer cancelC()
	recv(t, c, func(e Event) bool { return has(e) })
	if s.Hub.Started() != 3 {
		t.Fatalf("an idle query must be reaped and restarted, started %d", s.Hub.Started())
	}
	if _, _, err := s.Hub.Subscribe(id, "bogus/x"); err == nil {
		t.Fatal("unknown topics are rejected")
	}
}

func TestViewsAndOperations(t *testing.T) {
	s, dev := setup(t)
	ctx := context.Background()
	id := dev.Cluster.ID
	register(t, dev, sleeper("web"))
	var allocID string
	for i := 0; i < 60 && allocID == ""; i++ {
		raw, err := s.JobView(ctx, id, "default", "web", "allocations")
		if err != nil {
			t.Fatal(err)
		}
		var allocs []struct {
			ID           string `json:"ID"`
			ClientStatus string `json:"ClientStatus"`
		}
		_ = json.Unmarshal(raw, &allocs)
		for _, a := range allocs {
			if a.ClientStatus == "running" {
				allocID = a.ID
			}
		}
		time.Sleep(time.Second)
	}
	if allocID == "" {
		t.Fatal("allocation not running")
	}
	raw, err := s.Alloc(ctx, id, allocID)
	if err != nil || strings.Contains(string(raw), "hunter2") || strings.Contains(string(raw), `"Job":`) {
		t.Fatalf("allocation detail must drop the job definition: %v", err)
	}
	st1, err := s.AllocStats(ctx, id, allocID)
	if err != nil || !strings.Contains(string(st1), "ResourceUsage") {
		t.Fatalf("stats: %s %v", st1, err)
	}
	st2, _ := s.AllocStats(ctx, id, allocID)
	if string(st1) != string(st2) {
		t.Fatal("stats within one sampling period come from one upstream request")
	}
	for _, v := range []string{"summary", "deployments", "evaluations", "services", "scale", "children", "periodic"} {
		if _, err := s.JobView(ctx, id, "default", "web", v); err != nil {
			t.Fatalf("view %s: %v", v, err)
		}
	}
	clients, err := s.Clients(ctx, id)
	if err != nil || len(clients) != 1 || clients[0].Allocations != 1 || clients[0].CPUAlloc != 50 || clients[0].MemberOf != "h1" {
		t.Fatalf("clients: %+v %v", clients, err)
	}
	if _, err := s.ClientStats(ctx, id, clients[0].ID); err != nil {
		t.Fatal(err)
	}
	topo, err := s.Topology(ctx, id)
	if err != nil || topo["totals"].(map[string]int64)["memory_allocated_mb"] != 32 {
		t.Fatalf("topology: %+v %v", topo, err)
	}
	if _, err := s.Servers(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Evaluations(ctx, id, "complete", "web"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Volumes(ctx, id); err != nil {
		t.Fatal(err)
	}
	if raw, err := s.Search(ctx, id, "we", ""); err != nil || !strings.Contains(string(raw), "web") {
		t.Fatalf("search: %s %v", raw, err)
	}
	if _, err := s.AllocAction(ctx, actor, id, allocID, "signal", "t", "SIGHUP"); err != nil {
		t.Fatalf("signal: %v", err)
	}
	if err := s.ClientAction(ctx, actor, id, clients[0].ID, "purge", ClientActionInput{}); code(err) != "node_not_down" {
		t.Fatalf("purging a live node must be refused: %v", err)
	}

	// Parameterized dispatch with meta and payload rules.
	pj := sleeper("render")
	pj["Type"] = "batch"
	pj["ParameterizedJob"] = map[string]any{"Payload": "optional", "MetaRequired": []string{"color"}}
	register(t, dev, pj)
	if _, err := s.Dispatch(ctx, actor, id, "default", "render", DispatchInput{}); err == nil {
		t.Fatal("required meta missing")
	}
	big := base64.StdEncoding.EncodeToString(make([]byte, MaxPayload+1))
	if _, err := s.Dispatch(ctx, actor, id, "default", "render", DispatchInput{Meta: map[string]string{"color": "red"}, Payload: big}); err == nil {
		t.Fatal("payload over 16 KiB")
	}
	res, err := s.Dispatch(ctx, actor, id, "default", "render", DispatchInput{Meta: map[string]string{"color": "red"},
		Payload: base64.StdEncoding.EncodeToString([]byte("hello"))})
	if err != nil || !strings.Contains(string(res), "render/dispatch-") {
		t.Fatalf("dispatch: %s %v", res, err)
	}
	children, _ := s.JobView(ctx, id, "default", "render", "children")
	if !strings.Contains(string(children), "render/dispatch-") {
		t.Fatalf("children: %s", children)
	}
	periodic := sleeper("nightly")
	periodic["Type"] = "batch"
	periodic["Periodic"] = map[string]any{"Enabled": true, "Spec": "0 3 * * *", "SpecType": "cron"}
	register(t, dev, periodic)
	if res, err := s.ForcePeriodic(ctx, actor, id, "default", "nightly"); err != nil || !strings.Contains(string(res), "EvalID") {
		t.Fatalf("force: %s %v", res, err)
	}

	// Variables: masked reads, reveal, CAS.
	meta, err := s.PutVariable(ctx, actor, id, "default", "app/config", map[string]string{"password": "p1"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutVariable(ctx, actor, id, "default", "app/config", map[string]string{"password": "p2"}, 0); code(err) != "cas_conflict" {
		t.Fatalf("cas on create: %v", err)
	}
	v, err := s.GetVariable(ctx, actor, id, "default", "app/config", false)
	if err != nil || v.Items != nil || v.Keys[0] != "password" {
		t.Fatalf("masked read: %+v %v", v, err)
	}
	v, _ = s.GetVariable(ctx, actor, id, "default", "app/config", true)
	if v.Items["password"] != "p1" {
		t.Fatalf("reveal: %+v", v)
	}
	if _, err := s.PutVariable(ctx, actor, id, "default", "app/config", map[string]string{"password": "p2"}, meta.ModifyIndex); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteVariable(ctx, actor, id, "default", "app/config", meta.ModifyIndex); code(err) != "cas_conflict" {
		t.Fatalf("stale delete: %v", err)
	}
	list, _ := s.Variables(ctx, id, "default", "app")
	if len(list) != 1 {
		t.Fatalf("variables: %+v", list)
	}
	if err := s.DeleteVariable(ctx, actor, id, "default", "app/config", list[0].ModifyIndex); err != nil {
		t.Fatal(err)
	}
}
