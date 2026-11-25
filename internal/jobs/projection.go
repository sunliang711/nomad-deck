package jobs

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
)

// Summary is the whitelist projection of a job that viewers may see. HCL
// variables are expanded into the Job JSON and env, templates, arguments,
// artifacts and meta may hold credentials, so only fields known to be
// harmless are copied; nothing else of the definition leaves the server.
type Summary struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Namespace   string         `json:"namespace"`
	Region      string         `json:"region"`
	Datacenters []string       `json:"datacenters"`
	NodePool    string         `json:"node_pool"`
	Priority    int            `json:"priority"`
	Update      map[string]any `json:"update,omitempty"`
	Periodic    map[string]any `json:"periodic,omitempty"`
	Parameter   map[string]any `json:"parameterized,omitempty"`
	Groups      []GroupSummary `json:"groups"`
}

// GroupSummary is the safe projection of a task group.
type GroupSummary struct {
	Name        string          `json:"name"`
	Count       int             `json:"count"`
	NetworkMode string          `json:"network_mode,omitempty"`
	Ports       []string        `json:"ports,omitempty"`
	Services    []ServiceSum    `json:"services,omitempty"`
	Volumes     []VolumeSummary `json:"volumes,omitempty"`
	Scaling     map[string]any  `json:"scaling,omitempty"`
	Tasks       []TaskSummary   `json:"tasks"`
}

// ServiceSum is a service name with its check types.
type ServiceSum struct {
	Name   string   `json:"name"`
	Checks []string `json:"checks,omitempty"`
}

// VolumeSummary is a volume request name and type.
type VolumeSummary struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TaskSummary is the safe projection of a task.
type TaskSummary struct {
	Name      string       `json:"name"`
	Driver    string       `json:"driver"`
	Image     string       `json:"image,omitempty"`
	CPU       int          `json:"cpu"`
	MemoryMB  int          `json:"memory_mb"`
	MemoryMax int          `json:"memory_max_mb,omitempty"`
	Lifecycle string       `json:"lifecycle,omitempty"`
	Sidecar   bool         `json:"sidecar,omitempty"`
	Mounts    []string     `json:"mount_targets,omitempty"`
	Services  []ServiceSum `json:"services,omitempty"`
}

func pick(m map[string]any, keys ...string) map[string]any {
	if m == nil {
		return nil
	}
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func services(v any) []ServiceSum {
	var out []ServiceSum
	for _, s := range list(v) {
		sm := obj(s)
		ss := ServiceSum{Name: str(sm["Name"])}
		for _, c := range list(sm["Checks"]) {
			ss.Checks = append(ss.Checks, str(obj(c)["Type"]))
		}
		out = append(out, ss)
	}
	return out
}

// Summarize builds the safe projection of a Job JSON document.
func Summarize(j Job) *Summary {
	s := &Summary{ID: str(j["ID"]), Type: str(j["Type"]), Namespace: str(j["Namespace"]), Region: str(j["Region"]),
		NodePool: str(j["NodePool"]), Priority: int(u64(j["Priority"])), Datacenters: []string{}, Groups: []GroupSummary{}}
	for _, d := range list(j["Datacenters"]) {
		s.Datacenters = append(s.Datacenters, str(d))
	}
	s.Update = pick(obj(j["Update"]), "Stagger", "MaxParallel", "HealthCheck", "MinHealthyTime", "HealthyDeadline",
		"ProgressDeadline", "AutoRevert", "AutoPromote", "Canary")
	s.Periodic = pick(obj(j["Periodic"]), "Enabled", "Spec", "Specs", "SpecType", "ProhibitOverlap", "TimeZone")
	s.Parameter = pick(obj(j["ParameterizedJob"]), "Payload", "MetaRequired", "MetaOptional")
	for _, g := range list(j["TaskGroups"]) {
		gm := obj(g)
		gs := GroupSummary{Name: str(gm["Name"]), Count: int(u64(gm["Count"])), Services: services(gm["Services"]), Tasks: []TaskSummary{}}
		for _, n := range list(gm["Networks"]) {
			nm := obj(n)
			gs.NetworkMode = str(nm["Mode"])
			for _, key := range []string{"ReservedPorts", "DynamicPorts"} {
				for _, p := range list(nm[key]) {
					gs.Ports = append(gs.Ports, str(obj(p)["Label"]))
				}
			}
		}
		vols := obj(gm["Volumes"])
		names := make([]string, 0, len(vols))
		for k := range vols {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			gs.Volumes = append(gs.Volumes, VolumeSummary{Name: k, Type: str(obj(vols[k])["Type"])})
		}
		gs.Scaling = pick(obj(gm["Scaling"]), "Min", "Max", "Enabled")
		for _, t := range list(gm["Tasks"]) {
			tm := obj(t)
			ts := TaskSummary{Name: str(tm["Name"]), Driver: str(tm["Driver"]), Services: services(tm["Services"])}
			if ts.Driver == "docker" || ts.Driver == "podman" {
				ts.Image = str(obj(tm["Config"])["image"])
			}
			if r := obj(tm["Resources"]); r != nil {
				ts.CPU, ts.MemoryMB, ts.MemoryMax = int(u64(r["CPU"])), int(u64(r["MemoryMB"])), int(u64(r["MemoryMaxMB"]))
			}
			if l := obj(tm["Lifecycle"]); l != nil {
				ts.Lifecycle = str(l["Hook"])
				ts.Sidecar, _ = l["Sidecar"].(bool)
			}
			for _, vm := range list(tm["VolumeMounts"]) {
				ts.Mounts = append(ts.Mounts, str(obj(vm)["Destination"]))
			}
			gs.Tasks = append(gs.Tasks, ts)
		}
		s.Groups = append(s.Groups, gs)
	}
	return s
}

// FieldChange is one difference between two summaries.
type FieldChange struct {
	Path string `json:"path"`
	Old  any    `json:"old"`
	New  any    `json:"new"`
}

// DiffSummaries lists the differences between two summaries (the only
// version comparison viewers get).
func DiffSummaries(a, b *Summary) []FieldChange {
	var am, bm any
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	_ = json.Unmarshal(ab, &am)
	_ = json.Unmarshal(bb, &bm)
	out := []FieldChange{}
	diffValue("", am, bm, &out)
	return out
}

func diffValue(path string, a, b any, out *[]FieldChange) {
	am, aok := a.(map[string]any)
	bm, bok := b.(map[string]any)
	if aok && bok {
		keys := map[string]bool{}
		for k := range am {
			keys[k] = true
		}
		for k := range bm {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			diffValue(join(path, k), am[k], bm[k], out)
		}
		return
	}
	al, aok := a.([]any)
	bl, bok := b.([]any)
	if aok && bok && len(al) == len(bl) {
		for i := range al {
			diffValue(fmt.Sprintf("%s[%d]", path, i), al[i], bl[i], out)
		}
		return
	}
	if !reflect.DeepEqual(a, b) {
		*out = append(*out, FieldChange{Path: path, Old: a, New: b})
	}
}

func join(p, k string) string {
	if p == "" {
		return k
	}
	return p + "." + k
}
