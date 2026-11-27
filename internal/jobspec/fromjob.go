package jobspec

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"
)

// FromJob maps a Nomad Job JSON document onto the visual model. JSON has
// no fragments, so every non-empty field the model does not cover is
// reported as lost.
func FromJob(j map[string]any) (*JobSpec, []Issue) {
	m := &mapper{issues: []Issue{}}
	spec := &JobSpec{}
	job := &spec.Job
	r := m.take(j, "job")
	job.ID = r.s("ID")
	if name := r.s("Name"); name != "" && name != job.ID {
		m.lost("job.Name", "Job Name 与 ID 不同，无法保留")
	}
	job.Namespace, job.Region, job.NodePool, job.Type = r.s("Namespace"), r.s("Region"), r.s("NodePool"), r.s("Type")
	job.Datacenters = r.strs("Datacenters")
	job.Priority = r.n("Priority")
	job.Meta = r.kv("Meta")
	job.Constraints = m.constraints(r.list("Constraints"))
	if p := r.obj("Periodic"); p != nil {
		pr := m.take(p, "job.periodic")
		per := &Periodic{Crons: pr.strs("Specs"), ProhibitOverlap: pr.b("ProhibitOverlap"), TimeZone: pr.s("TimeZone"), Enabled: pr.b("Enabled")}
		if spec := pr.s("Spec"); spec != "" && len(per.Crons) == 0 {
			per.Crons = []string{spec}
		}
		pr.ignore("SpecType")
		pr.done()
		job.Periodic = per
	}
	job.Update = m.update(r.obj("Update"), "job.update")
	for _, g := range r.list("TaskGroups") {
		if gm, ok := g.(map[string]any); ok {
			job.Groups = append(job.Groups, m.group(gm))
		}
	}
	r.ignore("Stop", "Status", "StatusDescription", "Version", "SubmitTime", "CreateIndex", "ModifyIndex", "JobModifyIndex",
		"Stable", "ParentID", "Dispatched", "Payload", "ConsulToken", "VaultToken", "NomadTokenID", "VaultNamespace",
		"ConsulNamespace", "DispatchIdempotencyToken", "UI")
	r.done()
	return spec, m.issues
}

type mapper struct{ issues []Issue }

func (m *mapper) lost(path, msg string) {
	m.issues = append(m.issues, Issue{Path: path, Kind: "unsupported", Message: msg})
}

type rec struct {
	m    *mapper
	v    map[string]any
	path string
	used map[string]bool
}

func (m *mapper) take(v map[string]any, path string) *rec {
	return &rec{m: m, v: v, path: path, used: map[string]bool{}}
}

func (r *rec) get(k string) any { r.used[k] = true; return r.v[k] }

func (r *rec) ignore(keys ...string) {
	for _, k := range keys {
		r.used[k] = true
	}
}

func (r *rec) s(k string) string {
	s, _ := r.get(k).(string)
	return s
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

func (r *rec) n(k string) string {
	if f, ok := num(r.get(k)); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return ""
}

// d formats a duration in nanoseconds ("" for zero/absent).
func (r *rec) d(k string) string {
	f, ok := num(r.get(k))
	if !ok || f == 0 {
		return ""
	}
	return time.Duration(int64(f)).String()
}

func (r *rec) b(k string) string {
	switch x := r.get(k).(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return ""
}

func (r *rec) obj(k string) map[string]any {
	o, _ := r.get(k).(map[string]any)
	return o
}

func (r *rec) list(k string) []any {
	l, _ := r.get(k).([]any)
	return l
}

func (r *rec) strs(k string) []string {
	var out []string
	for _, x := range r.list(k) {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func kvOf(o map[string]any) []KV {
	keys := make([]string, 0, len(o))
	for k := range o {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []KV
	for _, k := range keys {
		out = append(out, KV{Key: k, Value: fmt.Sprint(o[k])})
	}
	return out
}

func (r *rec) kv(k string) []KV { return kvOf(r.obj(k)) }

func empty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case bool:
		return !x
	case map[string]any:
		return len(x) == 0
	case []any:
		return len(x) == 0
	}
	if f, ok := num(v); ok {
		return f == 0
	}
	return false
}

// done reports every non-empty field that was not mapped.
func (r *rec) done() {
	keys := make([]string, 0)
	for k, v := range r.v {
		if !r.used[k] && !empty(v) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		r.m.lost(r.path+"."+k, "字段 "+k+" 不受可视化模型支持，转换后丢失")
	}
}

func (m *mapper) constraints(l []any) []Constraint {
	var out []Constraint
	for _, c := range l {
		cm, _ := c.(map[string]any)
		r := m.take(cm, "constraint")
		out = append(out, Constraint{Attribute: r.s("LTarget"), Operator: r.s("Operand"), Value: r.s("RTarget")})
		r.done()
	}
	return out
}

func (m *mapper) update(u map[string]any, path string) *Update {
	if u == nil {
		return nil
	}
	r := m.take(u, path)
	up := &Update{MaxParallel: r.n("MaxParallel"), HealthCheck: r.s("HealthCheck"), MinHealthyTime: r.d("MinHealthyTime"),
		HealthyDeadline: r.d("HealthyDeadline"), ProgressDeadline: r.d("ProgressDeadline"), AutoRevert: r.b("AutoRevert"),
		AutoPromote: r.b("AutoPromote"), Canary: r.n("Canary"), Stagger: r.d("Stagger")}
	r.done()
	return up
}

func (m *mapper) restart(o map[string]any, path string) *Restart {
	if o == nil {
		return nil
	}
	r := m.take(o, path)
	rs := &Restart{Attempts: r.n("Attempts"), Interval: r.d("Interval"), Delay: r.d("Delay"), Mode: r.s("Mode")}
	r.ignore("RenderTemplates")
	r.done()
	return rs
}

func (m *mapper) services(l []any, path string) []Service {
	var out []Service
	for _, s := range l {
		sm, _ := s.(map[string]any)
		r := m.take(sm, path+".service")
		svc := Service{Name: r.s("Name"), Port: r.s("PortLabel"), Provider: r.s("Provider"), AddressMode: r.s("AddressMode"), Tags: r.strs("Tags")}
		for _, c := range r.list("Checks") {
			cm, _ := c.(map[string]any)
			cr := m.take(cm, r.path+".check")
			svc.Checks = append(svc.Checks, Check{Name: cr.s("Name"), Type: cr.s("Type"), Path: cr.s("Path"), Port: cr.s("PortLabel"),
				AddressMode: cr.s("AddressMode"), Interval: cr.d("Interval"), Timeout: cr.d("Timeout")})
			cr.done()
		}
		r.ignore("TaskName")
		r.done()
		out = append(out, svc)
	}
	return out
}

func (m *mapper) group(gm map[string]any) Group {
	r := m.take(gm, "")
	g := Group{Name: r.s("Name")}
	r.path = "group[" + g.Name + "]"
	g.Count = r.n("Count")
	g.Meta = r.kv("Meta")
	g.Constraints = m.constraints(r.list("Constraints"))
	if nets := r.list("Networks"); len(nets) > 0 {
		nm, _ := nets[0].(map[string]any)
		nr := m.take(nm, r.path+".network")
		n := &Network{Mode: nr.s("Mode")}
		for _, key := range []string{"ReservedPorts", "DynamicPorts"} {
			for _, p := range nr.list(key) {
				pm, _ := p.(map[string]any)
				pr := m.take(pm, nr.path+".port")
				pt := Port{Label: pr.s("Label"), To: pr.n("To"), HostNetwork: pr.s("HostNetwork")}
				if key == "ReservedPorts" {
					pt.Static = pr.n("Value")
				} else {
					pr.ignore("Value")
				}
				if pt.HostNetwork == "default" {
					pt.HostNetwork = ""
				}
				pr.done()
				n.Ports = append(n.Ports, pt)
			}
		}
		nr.ignore("MBits", "Device", "CIDR", "IP")
		nr.done()
		if len(nets) > 1 {
			m.lost(r.path+".Networks", "多个 network 块无法保留")
		}
		g.Network = n
	}
	vols := r.obj("Volumes")
	names := make([]string, 0, len(vols))
	for k := range vols {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		vm, _ := vols[k].(map[string]any)
		vr := m.take(vm, r.path+".volume["+k+"]")
		g.Volumes = append(g.Volumes, Volume{Name: k, Type: vr.s("Type"), Source: vr.s("Source"), ReadOnly: vr.b("ReadOnly"),
			AccessMode: vr.s("AccessMode"), AttachmentMode: vr.s("AttachmentMode"), PerAlloc: vr.b("PerAlloc")})
		vr.ignore("Name")
		vr.done()
	}
	g.Services = m.services(r.list("Services"), r.path)
	g.Restart = m.restart(r.obj("RestartPolicy"), r.path+".restart")
	if rp := r.obj("ReschedulePolicy"); rp != nil {
		rr := m.take(rp, r.path+".reschedule")
		g.Reschedule = &Reschedule{Attempts: rr.n("Attempts"), Interval: rr.d("Interval"), Delay: rr.d("Delay"),
			DelayFunction: rr.s("DelayFunction"), MaxDelay: rr.d("MaxDelay"), Unlimited: rr.b("Unlimited")}
		rr.done()
	}
	g.Update = m.update(r.obj("Update"), r.path+".update")
	if ed := r.obj("EphemeralDisk"); ed != nil {
		er := m.take(ed, r.path+".ephemeral_disk")
		g.EphemeralDisk = &EphemeralDisk{Size: er.n("SizeMB"), Migrate: er.b("Migrate"), Sticky: er.b("Sticky")}
		er.done()
	}
	for _, t := range r.list("Tasks") {
		if tm, ok := t.(map[string]any); ok {
			g.Tasks = append(g.Tasks, m.task(tm, r.path))
		}
	}
	r.ignore("Migrate", "Name")
	r.done()
	return g
}

func (m *mapper) task(tm map[string]any, gpath string) Task {
	r := m.take(tm, "")
	t := Task{Name: r.s("Name"), Driver: r.s("Driver")}
	r.path = gpath + ".task[" + t.Name + "]"
	if l := r.obj("Lifecycle"); l != nil {
		lr := m.take(l, r.path+".lifecycle")
		t.Lifecycle = &Lifecycle{Hook: lr.s("Hook"), Sidecar: lr.b("Sidecar")}
		lr.done()
	}
	if cfg := r.obj("Config"); cfg != nil {
		cr := m.take(cfg, r.path+".config")
		c := &t.Config
		c.Image, c.ForcePull, c.Command = cr.s("image"), cr.b("force_pull"), cr.s("command")
		c.Args, c.Ports, c.NetworkMode, c.Privileged = cr.strs("args"), cr.strs("ports"), cr.s("network_mode"), cr.b("privileged")
		c.Volumes = cr.strs("volumes")
		for _, a := range cr.list("auth") {
			am, _ := a.(map[string]any)
			ar := m.take(am, cr.path+".auth")
			c.Auth = &Auth{Username: ar.s("username"), Password: ar.s("password")}
			ar.done()
		}
		for _, mo := range cr.list("mount") {
			mm, _ := mo.(map[string]any)
			mr := m.take(mm, cr.path+".mount")
			mt := Mount{Type: mr.s("type"), Source: mr.s("source"), Target: mr.s("target"), Readonly: mr.b("readonly")}
			for _, bo := range mr.list("bind_options") {
				bm, _ := bo.(map[string]any)
				br := m.take(bm, mr.path+".bind_options")
				mt.BindOptions = &BindOptions{Propagation: br.s("propagation")}
				br.done()
			}
			mr.done()
			c.Mounts = append(c.Mounts, mt)
		}
		for _, lo := range cr.list("logging") {
			lm, _ := lo.(map[string]any)
			lr := m.take(lm, cr.path+".logging")
			lg := &Logging{Type: lr.s("type")}
			for _, cf := range lr.list("config") {
				cm, _ := cf.(map[string]any)
				lg.Config = append(lg.Config, kvOf(cm)...)
			}
			lr.done()
			c.Logging = lg
		}
		cr.done()
	}
	t.Env = r.kv("Env")
	for _, vm := range r.list("VolumeMounts") {
		mm, _ := vm.(map[string]any)
		vr := m.take(mm, r.path+".volume_mount")
		t.VolumeMounts = append(t.VolumeMounts, VolumeMount{Volume: vr.s("Volume"), Destination: vr.s("Destination"),
			ReadOnly: vr.b("ReadOnly"), PropagationMode: vr.s("PropagationMode")})
		vr.ignore("SELinuxLabel")
		vr.done()
	}
	if res := r.obj("Resources"); res != nil {
		rr := m.take(res, r.path+".resources")
		t.Resources = &Resources{CPU: rr.n("CPU"), Memory: rr.n("MemoryMB"), MemoryMax: rr.n("MemoryMaxMB")}
		rr.ignore("DiskMB", "IOPS")
		rr.done()
	}
	if lc := r.obj("LogConfig"); lc != nil {
		lr := m.take(lc, r.path+".logs")
		t.Logs = &Logs{MaxFiles: lr.n("MaxFiles"), MaxFileSize: lr.n("MaxFileSizeMB")}
		lr.ignore("Disabled", "Enabled")
		lr.done()
	}
	t.Restart = m.restart(r.obj("RestartPolicy"), r.path+".restart")
	t.Services = m.services(r.list("Services"), r.path)
	if v := r.obj("Vault"); v != nil {
		vr := m.take(v, r.path+".vault")
		t.Vault = &Vault{Role: vr.s("Role"), Cluster: vr.s("Cluster"), ChangeMode: vr.s("ChangeMode"), Env: vr.b("Env")}
		vr.ignore("Policies", "DisableFile", "Namespace", "ChangeSignal", "AllowTokenExpiration")
		vr.done()
	}
	for _, id := range r.list("Identities") {
		im, _ := id.(map[string]any)
		ir := m.take(im, r.path+".identity")
		t.Identities = append(t.Identities, Identity{Name: ir.s("Name"), Aud: ir.strs("Audience"), File: ir.b("File"), TTL: ir.d("TTL")})
		ir.ignore("ServiceName", "ChangeMode", "ChangeSignal", "Env", "Filepath")
		ir.done()
	}
	for _, tp := range r.list("Templates") {
		pm, _ := tp.(map[string]any)
		pr := m.take(pm, r.path+".template")
		t.Templates = append(t.Templates, Template{Destination: pr.s("DestPath"), Data: pr.s("EmbeddedTmpl"), Env: pr.b("Envvars"),
			Perms: pr.s("Perms"), ChangeMode: pr.s("ChangeMode"), LeftDelimiter: pr.s("LeftDelim"), RightDelimiter: pr.s("RightDelim"),
			Splay: pr.d("Splay")})
		pr.done()
	}
	t.Meta = r.kv("Meta")
	if kt := r.d("KillTimeout"); kt != "" && kt != "5s" {
		m.lost(r.path+".KillTimeout", "kill_timeout="+kt+" 不受可视化模型支持，转换后恢复默认值")
	}
	r.ignore("Leader", "ShutdownDelay", "Name", "Driver")
	r.done()
	return t
}
