package workbench

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
)

// ---- Search ----

// Search runs Nomad's fuzzy search across contexts.
func (s *Service) Search(ctx context.Context, clusterID, text, namespace string) (json.RawMessage, error) {
	text = strings.TrimSpace(text)
	if len(text) < 2 || len(text) > 128 {
		return nil, badRequest("搜索词需为 2～128 个字符")
	}
	if namespace == "" {
		namespace = "*"
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	err = c.Request(ctx, "POST", "search/fuzzy", map[string]any{"Text": text, "Context": "all",
		"QueryOptions": map[string]any{"Namespace": namespace}}, &raw)
	if err != nil {
		return nil, nomadErr(err)
	}
	return raw, nil
}

// ---- Job views ----

// JobView returns one runtime view of a job (no definition content).
func (s *Service) JobView(ctx context.Context, clusterID, ns, jobID, view string) (json.RawMessage, error) {
	if err := validJob(ns, jobID); err != nil {
		return nil, err
	}
	sub := map[string]string{"summary": "summary", "deployments": "deployments", "allocations": "allocations",
		"evaluations": "evaluations", "services": "services", "scale": "scale"}[view]
	switch view {
	case "children":
		return s.get(ctx, clusterID, "jobs?namespace="+url.QueryEscape(ns)+"&prefix="+url.QueryEscape(jobID+"/"))
	case "periodic":
		raw, err := s.get(ctx, clusterID, jobPath(ns, jobID, ""))
		if err != nil {
			return nil, err
		}
		var j struct {
			Periodic         json.RawMessage `json:"Periodic"`
			ParameterizedJob json.RawMessage `json:"ParameterizedJob"`
		}
		_ = json.Unmarshal(raw, &j)
		b, _ := json.Marshal(map[string]any{"periodic": j.Periodic, "parameterized": j.ParameterizedJob})
		return b, nil
	case "":
		return nil, badRequest("未指定视图")
	}
	if sub == "" {
		return nil, badRequest("不支持的视图 %s", view)
	}
	return s.get(ctx, clusterID, jobPath(ns, jobID, sub))
}

// ---- Deployments ----

// DeploymentAction promotes (all or some groups), fails, pauses or resumes
// a deployment.
func (s *Service) DeploymentAction(ctx context.Context, actor audit.Actor, clusterID, id, action string, groups []string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	var path string
	body := map[string]any{"DeploymentID": id}
	switch action {
	case "promote":
		path = "deployment/promote/" + id
		if len(groups) == 0 {
			body["All"] = true
		} else {
			body["Groups"] = groups
		}
	case "fail":
		path = "deployment/fail/" + id
	case "pause", "resume":
		path = "deployment/pause/" + id
		body["Pause"] = action == "pause"
	default:
		return nil, badRequest("不支持的操作 %s", action)
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	err = c.Request(ctx, "POST", path, body, &raw)
	s.auditOp(ctx, actor, clusterID, "deployment_"+action, "deployment/"+id, map[string]any{"groups": groups}, err)
	if err != nil {
		return nil, nomadErr(err)
	}
	return raw, nil
}

// ---- Periodic and parameterized jobs ----

// ForcePeriodic launches a periodic job now.
func (s *Service) ForcePeriodic(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string) (json.RawMessage, error) {
	if err := validJob(ns, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	err = c.Request(ctx, "POST", jobPath(ns, jobID, "periodic/force"), nil, &raw)
	s.auditOp(ctx, actor, clusterID, "job_periodic_force", ns+"/"+jobID, nil, err)
	if err != nil {
		return nil, nomadErr(err)
	}
	return raw, nil
}

// DispatchInput dispatches a parameterized job.
type DispatchInput struct {
	Meta    map[string]string `json:"meta"`
	Payload string            `json:"payload"` // base64
}

// MaxPayload is Nomad's dispatch payload limit.
const MaxPayload = 16 << 10

// Dispatch dispatches a parameterized job after checking the required
// meta keys and the payload policy.
func (s *Service) Dispatch(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string, in DispatchInput) (json.RawMessage, error) {
	if err := validJob(ns, jobID); err != nil {
		return nil, err
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil {
		return nil, badRequest("payload 需为 base64")
	}
	if len(payload) > MaxPayload {
		return nil, badRequest("payload 超过 Nomad 的 16 KiB 上限")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var j struct {
		ParameterizedJob *struct {
			Payload      string   `json:"Payload"`
			MetaRequired []string `json:"MetaRequired"`
			MetaOptional []string `json:"MetaOptional"`
		} `json:"ParameterizedJob"`
	}
	if err := c.Request(ctx, "GET", jobPath(ns, jobID, ""), nil, &j); err != nil {
		return nil, nomadErr(err)
	}
	pj := j.ParameterizedJob
	if pj == nil {
		return nil, conflict("not_parameterized", "该 Job 不是 Parameterized Job")
	}
	allowed := map[string]bool{}
	for _, k := range append(append([]string{}, pj.MetaRequired...), pj.MetaOptional...) {
		allowed[k] = true
	}
	for _, k := range pj.MetaRequired {
		if _, ok := in.Meta[k]; !ok {
			return nil, badRequest("缺少必填 meta %s", k)
		}
	}
	for k := range in.Meta {
		if !allowed[k] {
			return nil, badRequest("meta %s 不在 meta_required 或 meta_optional 中", k)
		}
	}
	switch {
	case pj.Payload == "required" && len(payload) == 0:
		return nil, badRequest("该 Job 要求 payload")
	case pj.Payload == "forbidden" && len(payload) > 0:
		return nil, badRequest("该 Job 禁止 payload")
	}
	var raw json.RawMessage
	err = c.Request(ctx, "POST", jobPath(ns, jobID, "dispatch"), map[string]any{"Payload": payload, "Meta": in.Meta}, &raw)
	s.auditOp(ctx, actor, clusterID, "job_dispatch", ns+"/"+jobID, map[string]any{"meta_keys": len(in.Meta), "payload_bytes": len(payload)}, err)
	if err != nil {
		return nil, nomadErr(err)
	}
	return raw, nil
}

// ---- Allocations ----

// Alloc returns an allocation without its embedded job definition.
func (s *Service) Alloc(ctx context.Context, clusterID, id string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	raw, err := s.get(ctx, clusterID, "allocation/"+id)
	if err != nil {
		return nil, err
	}
	return stripJob(raw), nil
}

// AllocChecks returns the allocation's Nomad service check results.
func (s *Service) AllocChecks(ctx context.Context, clusterID, id string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	return s.get(ctx, clusterID, "client/allocation/"+id+"/checks")
}

type statsEntry struct {
	at   time.Time
	body json.RawMessage
	err  error
	wait chan struct{}
}

// statsCache shares one upstream stats request per object and sampling
// period among all viewers.
type statsCache struct {
	mu sync.Mutex
	m  map[string]*statsEntry
}

func newStatsCache() *statsCache { return &statsCache{m: map[string]*statsEntry{}} }

func (s *Service) cached(ctx context.Context, key string, ttl time.Duration, fetch func() (json.RawMessage, error)) (json.RawMessage, error) {
	c := s.stats
	if c == nil {
		return fetch()
	}
	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		if e.wait != nil {
			ch := e.wait
			c.mu.Unlock()
			select {
			case <-ch:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			c.mu.Lock()
			e = c.m[key]
			c.mu.Unlock()
			if e != nil {
				return e.body, e.err
			}
			return fetch()
		}
		if time.Since(e.at) < ttl {
			c.mu.Unlock()
			return e.body, e.err
		}
	}
	e := &statsEntry{wait: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()
	body, err := fetch()
	c.mu.Lock()
	e.at, e.body, e.err = time.Now(), body, err
	close(e.wait)
	e.wait = nil
	c.mu.Unlock()
	return body, err
}

func (s *Service) statsInterval(ctx context.Context) time.Duration {
	n := db.IntSetting(ctx, s.DB.Reader, "nomad.stats_interval_seconds", 2)
	if n < 1 {
		n = 1
	}
	return time.Duration(n) * time.Second
}

// AllocStats returns live task resource usage (shared per sampling period).
func (s *Service) AllocStats(ctx context.Context, clusterID, id string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	return s.cached(ctx, clusterID+"|alloc|"+id, s.statsInterval(ctx), func() (json.RawMessage, error) {
		return s.get(ctx, clusterID, "client/allocation/"+id+"/stats")
	})
}

// AllocAction restarts (one task or all), stops or signals an allocation.
func (s *Service) AllocAction(ctx context.Context, actor audit.Actor, clusterID, id, action, task, signal string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	var method, path string
	var body any
	switch action {
	case "restart":
		method, path = "POST", "client/allocation/"+id+"/restart"
		if task != "" {
			body = map[string]any{"TaskName": task}
		} else {
			body = map[string]any{"AllTasks": true}
		}
	case "stop":
		method, path = "POST", "allocation/"+id+"/stop"
	case "signal":
		if !reSignal.MatchString(signal) {
			return nil, badRequest("信号名称不合法")
		}
		method, path = "POST", "client/allocation/"+id+"/signal"
		body = map[string]any{"Signal": signal, "Task": task}
	default:
		return nil, badRequest("不支持的操作 %s", action)
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	err = c.Request(ctx, method, path, body, &raw)
	s.auditOp(ctx, actor, clusterID, "alloc_"+action, "alloc/"+id, map[string]any{"task": task, "signal": signal}, err)
	if err != nil {
		return nil, nomadErr(err)
	}
	return raw, nil
}

// ---- Clients ----

// ClientRow is one client in the client list.
type ClientRow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Address     string `json:"address"`
	Datacenter  string `json:"datacenter"`
	NodePool    string `json:"node_pool"`
	Status      string `json:"status"`
	Eligibility string `json:"scheduling_eligibility"`
	Drain       bool   `json:"drain"`
	Version     string `json:"version"`
	Allocations int    `json:"running_allocations"`
	CPUTotal    int64  `json:"cpu_total_mhz"`
	CPUAlloc    int64  `json:"cpu_allocated_mhz"`
	MemTotal    int64  `json:"memory_total_mb"`
	MemAlloc    int64  `json:"memory_allocated_mb"`
	MemberOf    string `json:"member_node_id,omitempty"`
}

type allocUsage struct {
	ID                 string `json:"ID"`
	NodeID             string `json:"NodeID"`
	JobID              string `json:"JobID"`
	Namespace          string `json:"Namespace"`
	TaskGroup          string `json:"TaskGroup"`
	ClientStatus       string `json:"ClientStatus"`
	AllocatedResources *struct {
		Tasks map[string]struct {
			Cpu struct {
				CpuShares int64 `json:"CpuShares"`
			} `json:"Cpu"`
			Memory struct {
				MemoryMB int64 `json:"MemoryMB"`
			} `json:"Memory"`
		} `json:"Tasks"`
	} `json:"AllocatedResources"`
}

func (a allocUsage) usage() (cpu, mem int64) {
	if a.AllocatedResources == nil {
		return
	}
	for _, t := range a.AllocatedResources.Tasks {
		cpu += t.Cpu.CpuShares
		mem += t.Memory.MemoryMB
	}
	return
}

func (s *Service) runningAllocs(ctx context.Context, clusterID string) ([]allocUsage, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var allocs []allocUsage
	if err := c.Request(ctx, "GET", "allocations?namespace=*&resources=true&task_states=false", nil, &allocs); err != nil {
		return nil, nomadErr(err)
	}
	out := allocs[:0]
	for _, a := range allocs {
		if a.ClientStatus == "running" || a.ClientStatus == "pending" {
			out = append(out, a)
		}
	}
	return out, nil
}

// Clients lists client nodes with allocated resources and the host
// membership they correspond to.
func (s *Service) Clients(ctx context.Context, clusterID string) ([]ClientRow, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var nodes []struct {
		ID                    string `json:"ID"`
		Name                  string `json:"Name"`
		Address               string `json:"Address"`
		Datacenter            string `json:"Datacenter"`
		NodePool              string `json:"NodePool"`
		Status                string `json:"Status"`
		SchedulingEligibility string `json:"SchedulingEligibility"`
		Drain                 bool   `json:"Drain"`
		Version               string `json:"Version"`
		NodeResources         *struct {
			Cpu struct {
				CpuShares int64 `json:"CpuShares"`
			} `json:"Cpu"`
			Memory struct {
				MemoryMB int64 `json:"MemoryMB"`
			} `json:"Memory"`
		} `json:"NodeResources"`
	}
	if err := c.Request(ctx, "GET", "nodes?resources=true", nil, &nodes); err != nil {
		return nil, nomadErr(err)
	}
	allocs, err := s.runningAllocs(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	members, _ := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	byName := map[string]string{}
	for _, m := range members {
		var mc struct {
			NodeName string `json:"node_name"`
		}
		_ = json.Unmarshal([]byte(m.NodeConfigJSON), &mc)
		byName[mc.NodeName] = m.NodeID
	}
	out := []ClientRow{}
	for _, n := range nodes {
		r := ClientRow{ID: n.ID, Name: n.Name, Address: n.Address, Datacenter: n.Datacenter, NodePool: n.NodePool, Status: n.Status,
			Eligibility: n.SchedulingEligibility, Drain: n.Drain, Version: n.Version, MemberOf: byName[n.Name]}
		if n.NodeResources != nil {
			r.CPUTotal, r.MemTotal = n.NodeResources.Cpu.CpuShares, n.NodeResources.Memory.MemoryMB
		}
		for _, a := range allocs {
			if a.NodeID == n.ID {
				r.Allocations++
				cpu, mem := a.usage()
				r.CPUAlloc += cpu
				r.MemAlloc += mem
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Client returns one client node with its allocations.
func (s *Service) Client(ctx context.Context, clusterID, id string) (map[string]json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	node, err := s.get(ctx, clusterID, "node/"+id)
	if err != nil {
		return nil, err
	}
	allocs, err := s.get(ctx, clusterID, "node/"+id+"/allocations")
	if err != nil {
		return nil, err
	}
	var list []json.RawMessage
	_ = json.Unmarshal(allocs, &list)
	for i := range list {
		list[i] = stripJob(list[i])
	}
	stripped, _ := json.Marshal(list)
	return map[string]json.RawMessage{"node": node, "allocations": stripped}, nil
}

// ClientStats returns host resource usage (shared per sampling period).
func (s *Service) ClientStats(ctx context.Context, clusterID, id string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	return s.cached(ctx, clusterID+"|node|"+id, s.statsInterval(ctx), func() (json.RawMessage, error) {
		return s.get(ctx, clusterID, "client/stats?node_id="+id)
	})
}

// ClientActionInput carries the options of a client action.
type ClientActionInput struct {
	Eligible       *bool  `json:"eligible"`
	Deadline       string `json:"deadline"` // drain deadline, e.g. 1h ("" = default, "-1" = force)
	IgnoreSystem   bool   `json:"ignore_system_jobs"`
	Cancel         bool   `json:"cancel"`
	KeepIneligible bool   `json:"keep_ineligible"`
}

// ClientAction toggles eligibility, drains (or cancels a drain) or purges
// a client.
func (s *Service) ClientAction(ctx context.Context, actor audit.Actor, clusterID, id, action string, in ClientActionInput) error {
	if err := validUUID(id); err != nil {
		return err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	switch action {
	case "eligibility":
		if in.Eligible == nil {
			return badRequest("请指定 eligible")
		}
		err = c.SetEligibility(ctx, id, *in.Eligible)
	case "drain":
		if in.Cancel {
			err = c.CancelDrain(ctx, id, !in.KeepIneligible)
		} else {
			d := time.Hour
			switch in.Deadline {
			case "":
			case "-1":
				d = -1
			default:
				if d, err = time.ParseDuration(in.Deadline); err != nil || d <= 0 {
					return badRequest("截止时间格式不正确")
				}
			}
			err = c.DrainNode(ctx, id, d, in.IgnoreSystem, map[string]string{"by": actor.Name})
		}
	case "purge":
		var n struct {
			Status string `json:"Status"`
		}
		if err := c.Request(ctx, "GET", "node/"+id, nil, &n); err != nil {
			return nomadErr(err)
		}
		if n.Status != "down" {
			return conflict("node_not_down", "只能 Purge 已下线的节点（当前 %s）", n.Status)
		}
		err = c.PurgeNode(ctx, id)
	default:
		return badRequest("不支持的操作 %s", action)
	}
	s.auditOp(ctx, actor, clusterID, "client_"+action, "node/"+id, map[string]any{"eligible": in.Eligible, "deadline": in.Deadline,
		"cancel": in.Cancel}, err)
	if err != nil {
		return nomadErr(err)
	}
	return nil
}

// ---- Servers and topology ----

// Servers returns the server members, Raft configuration and autopilot health.
func (s *Service) Servers(ctx context.Context, clusterID string) (map[string]any, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	var members json.RawMessage
	if err := c.Request(ctx, "GET", "agent/members", nil, &members); err != nil {
		return nil, nomadErr(err)
	}
	out["members"] = members
	if raft, err := c.RaftConfiguration(ctx); err == nil {
		out["raft"] = raft
	}
	if ap, err := c.Autopilot(ctx); err == nil {
		out["autopilot"] = ap
	}
	return out, nil
}

// TopologyNode is a client with the allocations placed on it.
type TopologyNode struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Datacenter  string          `json:"datacenter"`
	Status      string          `json:"status"`
	CPUTotal    int64           `json:"cpu_total_mhz"`
	MemTotal    int64           `json:"memory_total_mb"`
	Allocations []TopologyAlloc `json:"allocations"`
}

// TopologyAlloc is an allocation's share of a node.
type TopologyAlloc struct {
	ID        string `json:"id"`
	JobID     string `json:"job_id"`
	Namespace string `json:"namespace"`
	TaskGroup string `json:"task_group"`
	CPU       int64  `json:"cpu_mhz"`
	Memory    int64  `json:"memory_mb"`
}

// Topology groups clients by datacenter with each allocation's resources.
func (s *Service) Topology(ctx context.Context, clusterID string) (map[string]any, error) {
	rows, err := s.Clients(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	allocs, err := s.runningAllocs(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	dcs := map[string][]TopologyNode{}
	var cpuT, cpuA, memT, memA int64
	for _, r := range rows {
		tn := TopologyNode{ID: r.ID, Name: r.Name, Datacenter: r.Datacenter, Status: r.Status, CPUTotal: r.CPUTotal, MemTotal: r.MemTotal,
			Allocations: []TopologyAlloc{}}
		for _, a := range allocs {
			if a.NodeID != r.ID {
				continue
			}
			cpu, mem := a.usage()
			tn.Allocations = append(tn.Allocations, TopologyAlloc{ID: a.ID, JobID: a.JobID, Namespace: a.Namespace, TaskGroup: a.TaskGroup,
				CPU: cpu, Memory: mem})
		}
		cpuT, cpuA, memT, memA = cpuT+r.CPUTotal, cpuA+r.CPUAlloc, memT+r.MemTotal, memA+r.MemAlloc
		dcs[r.Datacenter] = append(dcs[r.Datacenter], tn)
	}
	return map[string]any{"datacenters": dcs, "totals": map[string]int64{"cpu_total_mhz": cpuT, "cpu_allocated_mhz": cpuA,
		"memory_total_mb": memT, "memory_allocated_mb": memA}}, nil
}

// Evaluations lists evaluations (optionally by status or job).
func (s *Service) Evaluations(ctx context.Context, clusterID, status, jobID string) (json.RawMessage, error) {
	path := "evaluations?namespace=*"
	var filters []string
	if status != "" {
		if !reWord.MatchString(status) {
			return nil, badRequest("status 不合法")
		}
		filters = append(filters, fmt.Sprintf(`Status == %q`, status))
	}
	if jobID != "" {
		filters = append(filters, fmt.Sprintf(`JobID == %q`, jobID))
	}
	if len(filters) > 0 {
		path += "&filter=" + url.QueryEscape(strings.Join(filters, " and "))
	}
	return s.get(ctx, clusterID, path)
}

// Evaluation returns one evaluation.
func (s *Service) Evaluation(ctx context.Context, clusterID, id string) (json.RawMessage, error) {
	if err := validUUID(id); err != nil {
		return nil, err
	}
	return s.get(ctx, clusterID, "evaluation/"+id+"?related=true")
}

// ---- Storage ----

// Volumes lists CSI volumes and, on Nomad 1.10+, dynamic host volumes.
func (s *Service) Volumes(ctx context.Context, clusterID string) (map[string]json.RawMessage, error) {
	csi, err := s.get(ctx, clusterID, "volumes?type=csi&namespace=*")
	if err != nil {
		return nil, err
	}
	out := map[string]json.RawMessage{"csi": csi}
	if host, err := s.get(ctx, clusterID, "volumes?type=host&namespace=*"); err == nil {
		out["host"] = host
	}
	return out, nil
}

// Volume returns one CSI volume.
func (s *Service) Volume(ctx context.Context, clusterID, ns, id string) (json.RawMessage, error) {
	if !reVolID.MatchString(id) || !reNS.MatchString(ns) {
		return nil, badRequest("卷 ID 不合法")
	}
	return s.get(ctx, clusterID, "volume/csi/"+url.PathEscape(id)+"?namespace="+url.QueryEscape(ns))
}

// DeregisterVolume deregisters an unused CSI volume.
func (s *Service) DeregisterVolume(ctx context.Context, actor audit.Actor, clusterID, ns, id string) error {
	if !reVolID.MatchString(id) || !reNS.MatchString(ns) {
		return badRequest("卷 ID 不合法")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	err = c.Request(ctx, "DELETE", "volume/csi/"+url.PathEscape(id)+"?namespace="+url.QueryEscape(ns), nil, nil)
	s.auditOp(ctx, actor, clusterID, "csi_volume_deregister", ns+"/"+id, nil, err)
	if err != nil {
		return nomadErr(err)
	}
	return nil
}

// Plugins lists CSI plugins.
func (s *Service) Plugins(ctx context.Context, clusterID string) (json.RawMessage, error) {
	return s.get(ctx, clusterID, "plugins?type=csi")
}

// ---- Variables ----

// VariableMeta is a variable's path and metadata (no items).
type VariableMeta struct {
	Namespace   string `json:"namespace"`
	Path        string `json:"path"`
	CreateIndex uint64 `json:"create_index"`
	ModifyIndex uint64 `json:"modify_index"`
	CreateTime  int64  `json:"create_time"`
	ModifyTime  int64  `json:"modify_time"`
	JobScoped   bool   `json:"job_scoped"`
}

// Variables lists variable paths and metadata.
func (s *Service) Variables(ctx context.Context, clusterID, namespace, prefix string) ([]VariableMeta, error) {
	if namespace == "" {
		namespace = "*"
	}
	if !reNS.MatchString(namespace) || len(prefix) > 512 {
		return nil, badRequest("参数不合法")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Namespace   string `json:"Namespace"`
		Path        string `json:"Path"`
		CreateIndex uint64 `json:"CreateIndex"`
		ModifyIndex uint64 `json:"ModifyIndex"`
		CreateTime  int64  `json:"CreateTime"`
		ModifyTime  int64  `json:"ModifyTime"`
	}
	if err := c.Request(ctx, "GET", "vars?namespace="+url.QueryEscape(namespace)+"&prefix="+url.QueryEscape(prefix), nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []VariableMeta{}
	for _, v := range raw {
		out = append(out, VariableMeta{Namespace: v.Namespace, Path: v.Path, CreateIndex: v.CreateIndex, ModifyIndex: v.ModifyIndex,
			CreateTime: v.CreateTime, ModifyTime: v.ModifyTime, JobScoped: strings.HasPrefix(v.Path, "nomad/jobs")})
	}
	return out, nil
}

// Variable is a variable with its items (or only key names when masked).
type Variable struct {
	VariableMeta
	Keys  []string          `json:"keys"`
	Items map[string]string `json:"items,omitempty"`
}

func validVarPath(ns, path string) error {
	if !reNS.MatchString(ns) || ns == "*" || path == "" || len(path) > 512 || strings.Contains(path, "..") || strings.HasPrefix(path, "/") {
		return badRequest("Namespace 或路径不合法")
	}
	return nil
}

// GetVariable returns a variable; values are only included when reveal is
// set (admin, audited).
func (s *Service) GetVariable(ctx context.Context, actor audit.Actor, clusterID, ns, path string, reveal bool) (*Variable, error) {
	if err := validVarPath(ns, path); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Namespace   string            `json:"Namespace"`
		Path        string            `json:"Path"`
		CreateIndex uint64            `json:"CreateIndex"`
		ModifyIndex uint64            `json:"ModifyIndex"`
		CreateTime  int64             `json:"CreateTime"`
		ModifyTime  int64             `json:"ModifyTime"`
		Items       map[string]string `json:"Items"`
	}
	if err := c.Request(ctx, "GET", "var/"+escapeVarPath(path)+"?namespace="+url.QueryEscape(ns), nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	v := &Variable{VariableMeta: VariableMeta{Namespace: raw.Namespace, Path: raw.Path, CreateIndex: raw.CreateIndex,
		ModifyIndex: raw.ModifyIndex, CreateTime: raw.CreateTime, ModifyTime: raw.ModifyTime,
		JobScoped: strings.HasPrefix(raw.Path, "nomad/jobs")}, Keys: []string{}}
	for k := range raw.Items {
		v.Keys = append(v.Keys, k)
	}
	sort.Strings(v.Keys)
	if reveal {
		v.Items = raw.Items
		s.auditOp(ctx, actor, clusterID, "variable_reveal", "var/"+ns+"/"+path, map[string]any{"keys": len(v.Keys)}, nil)
	}
	return v, nil
}

func escapeVarPath(p string) string {
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

// PutVariable writes a variable with check-and-set on the given index
// (0 = must not exist yet).
func (s *Service) PutVariable(ctx context.Context, actor audit.Actor, clusterID, ns, path string, items map[string]string, cas uint64) (*VariableMeta, error) {
	if err := validVarPath(ns, path); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, badRequest("至少需要一个键值")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw struct {
		ModifyIndex uint64 `json:"ModifyIndex"`
		CreateIndex uint64 `json:"CreateIndex"`
	}
	err = c.Request(ctx, "PUT", fmt.Sprintf("var/%s?namespace=%s&cas=%d", escapeVarPath(path), url.QueryEscape(ns), cas),
		map[string]any{"Namespace": ns, "Path": path, "Items": items}, &raw)
	s.auditOp(ctx, actor, clusterID, "variable_put", "var/"+ns+"/"+path, map[string]any{"keys": len(items), "cas": cas}, err)
	if err != nil {
		if isCASConflict(err) {
			return nil, conflict("cas_conflict", "Variable 已被他人修改，请刷新后重试")
		}
		return nil, nomadErr(err)
	}
	return &VariableMeta{Namespace: ns, Path: path, ModifyIndex: raw.ModifyIndex, CreateIndex: raw.CreateIndex}, nil
}

// DeleteVariable deletes a variable with check-and-set.
func (s *Service) DeleteVariable(ctx context.Context, actor audit.Actor, clusterID, ns, path string, cas uint64) error {
	if err := validVarPath(ns, path); err != nil {
		return err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	err = c.Request(ctx, "DELETE", fmt.Sprintf("var/%s?namespace=%s&cas=%d", escapeVarPath(path), url.QueryEscape(ns), cas), nil, nil)
	s.auditOp(ctx, actor, clusterID, "variable_delete", "var/"+ns+"/"+path, map[string]any{"cas": cas}, err)
	if err != nil {
		if isCASConflict(err) {
			return conflict("cas_conflict", "Variable 已被他人修改，请刷新后重试")
		}
		return nomadErr(err)
	}
	return nil
}

func isCASConflict(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "409") || strings.Contains(msg, "cas") && strings.Contains(msg, "conflict")
}
