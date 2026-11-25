package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
)

func (s *Service) auditJob(ctx context.Context, actor audit.Actor, clusterID, ns, jobID, action string, summary map[string]any, err error) {
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_" + action, ResourceType: "nomad_job",
		ResourceID: clusterID + "/" + ns + "/" + jobID, ResourceName: jobID, Summary: summary, Err: err})
}

// latestAuthoritative returns the latest confirmed revision when it is the
// live version (not drifted).
func (s *Service) latestAuthoritative(ctx context.Context, clusterID, ns, jobID string, j Job) *db.JobRevision {
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, clusterID, ns, jobID)
	for _, r := range revs {
		if r.SubmitStatus != db.RevConfirmed || r.Source == "stop_archive" {
			continue
		}
		if r.RemoteJobVersion != nil && *r.RemoteJobVersion == u64(j["Version"]) && r.ResultJobModifyIndex == u64(j["JobModifyIndex"]) {
			return r
		}
		return nil
	}
	return nil
}

func (s *Service) revisionVars(r *db.JobRevision) map[string]string {
	if r == nil || r.VariablesEncrypted == "" {
		return nil
	}
	b, err := s.Keys.Decrypt(r.VariablesEncrypted, db.JobVariablesAAD(r.ID))
	if err != nil {
		return nil
	}
	var m map[string]string
	_ = json.Unmarshal(b, &m)
	return m
}

// ---- Start / stop / purge ----

// Start resubmits a stopped job from its remote definition. When Nomad no
// longer has the job, a 409 names the local archive to plan from.
func (s *Service) Start(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string) (*ApplyResult, error) {
	if err := validRef(ns, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	j, err := getJob(ctx, c, ns, jobID)
	if err != nil {
		if isNotFound(err) {
			if a := s.latestArchive(ctx, clusterID, ns, jobID); a != nil {
				return nil, &auth.Error{Status: 409, Code: "remote_definition_gone",
					Message: fmt.Sprintf("Nomad 已回收该 Job 的定义，请以本地归档（版本记录 %d 号，revision_id=%s）走 Plan → Apply 重新提交", a.RevisionNo, a.ID)}
			}
		}
		return nil, nomadErr(err)
	}
	if stop, _ := j["Stop"].(bool); !stop {
		return nil, conflict("job_running", "Job 未停止")
	}
	j["Stop"] = false
	rec := &planRecord{ClusterID: clusterID, Namespace: ns, JobID: jobID, JobJSON: canonical(j), JobModifyIndex: u64(j["JobModifyIndex"]),
		InputType: "json", EditMode: "json", Source: "workbench"}
	// Stopping creates a new (stopped) version without a local revision:
	// the stop archive carries the source, spec and variables.
	if a := s.latestArchive(ctx, clusterID, ns, jobID); a != nil && a.HCLContent != "" {
		rec.HCL, rec.EditMode, rec.FormSpec, rec.RendererVersion = a.HCLContent, a.EditMode, a.FormSpecJSON, a.RendererVersion
		rec.Variables = s.revisionVars(a)
	} else if d, err := s.DefinitionOf(ctx, clusterID, ns, jobID, nil); err == nil && d.HCL != "" && d.Editable {
		rec.HCL, rec.EditMode = d.HCL, "hcl"
	}
	rec.Hash = planHash(rec.JobJSON, clusterID, ns)
	return s.submit(ctx, actor, rec)
}

// Stop archives the live definition (Job JSON, source and variables) as a
// stop_archive revision and stops the job.
func (s *Service) Stop(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string) (string, error) {
	if err := validRef(ns, jobID); err != nil {
		return "", err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return "", err
	}
	j, err := getJob(ctx, c, ns, jobID)
	if err != nil {
		return "", nomadErr(err)
	}
	ver := u64(j["Version"])
	rev := &db.JobRevision{ID: db.NewID(), ClusterID: clusterID, Namespace: ns, JobID: jobID, Source: "stop_archive", EditMode: "json",
		ResultJobModifyIndex: u64(j["JobModifyIndex"]), BaseJobModifyIndex: u64(j["JobModifyIndex"]), RemoteJobVersion: &ver,
		SubmitStatus: db.RevConfirmed, SubmittedBy: actor.Name, CreatedAt: s.DB.Now()}
	if d, err := s.DefinitionOf(ctx, clusterID, ns, jobID, nil); err == nil && d.HCL != "" {
		rev.HCLContent, rev.HCLSHA256, rev.EditMode = d.HCL, sha([]byte(d.HCL)), "hcl"
		if d.RevisionID != "" {
			if r, err := db.GetRevision(ctx, s.DB.Reader, d.RevisionID); err == nil {
				rev.VariablesEncrypted = ""
				if vars := s.revisionVars(r); len(vars) > 0 {
					vb, _ := json.Marshal(vars)
					if rev.VariablesEncrypted, err = s.Keys.Encrypt(vb, db.JobVariablesAAD(rev.ID)); err != nil {
						return "", err
					}
				}
				rev.FormSpecJSON, rev.RendererVersion = r.FormSpecJSON, r.RendererVersion
				if r.EditMode == "visual" {
					rev.EditMode = "visual"
				}
			}
		}
	}
	if rev.JobJSONEncrypted, err = s.Keys.Encrypt(canonical(j), db.JobJSONAAD(rev.ID)); err != nil {
		return "", err
	}
	if err := db.InsertRevision(ctx, s.DB.Writer, rev); err != nil {
		return "", err
	}
	var resp struct {
		EvalID string `json:"EvalID"`
	}
	err = c.Request(ctx, http.MethodDelete, jobPath(jobID)+q(ns), nil, &resp)
	s.auditJob(ctx, actor, clusterID, ns, jobID, "stop", map[string]any{"archive_revision": rev.RevisionNo, "version": ver}, err)
	if err != nil {
		return "", nomadErr(err)
	}
	return resp.EvalID, nil
}

// Purge deletes a job and its history from Nomad (the job ID must be typed
// to confirm).
func (s *Service) Purge(ctx context.Context, actor audit.Actor, clusterID, ns, jobID, confirm string) error {
	if err := validRef(ns, jobID); err != nil {
		return err
	}
	if confirm != jobID {
		return badRequest("请输入 Job ID 以确认彻底删除")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	err = c.Request(ctx, http.MethodDelete, jobPath(jobID)+q(ns)+"&purge=true", nil, nil)
	s.auditJob(ctx, actor, clusterID, ns, jobID, "purge", nil, err)
	if err != nil {
		return nomadErr(err)
	}
	return nil
}

// ---- Revert ----

// Revert rolls back to a version Nomad still keeps (native revert with
// EnforcePriorVersion) and records the target version's spec, source and
// variables as the new revision. A version Nomad no longer keeps answers
// 409 with the local revision to plan from.
func (s *Service) Revert(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string, version uint64) (*ApplyResult, error) {
	if err := validRef(ns, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	vs, _, err := versions(ctx, c, ns, jobID, false)
	if err != nil {
		return nil, nomadErr(err)
	}
	if len(vs) == 0 {
		return nil, errNoJob
	}
	current := vs[0]
	var target Job
	for _, v := range vs {
		if u64(v["Version"]) == version {
			target = v
		}
	}
	local := s.revisionForVersion(ctx, clusterID, ns, jobID, version)
	if target == nil {
		if local != nil && local.JobJSONEncrypted != "" {
			return nil, &auth.Error{Status: 409, Code: "remote_version_gone",
				Message: fmt.Sprintf("Nomad 已回收版本 %d，请以本地归档（revision_id=%s）走 Plan → Apply 重新提交", version, local.ID)}
		}
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: fmt.Sprintf("Nomad 与本地都没有版本 %d", version)}
	}
	if u64(current["Version"]) == version {
		return nil, conflict("same_version", "目标版本就是当前版本")
	}
	rev := &db.JobRevision{ID: db.NewID(), ClusterID: clusterID, Namespace: ns, JobID: jobID, Source: "revert", EditMode: "json",
		BaseJobModifyIndex: u64(current["JobModifyIndex"]), SubmitStatus: db.RevInDoubt, SubmittedBy: actor.Name, CreatedAt: s.DB.Now(),
		PlanSummary: fmt.Sprintf("revert to version %d", version)}
	jobJSON := canonical(target)
	if local != nil {
		rev.EditMode, rev.FormSpecJSON, rev.HCLContent, rev.HCLSHA256, rev.RendererVersion = local.EditMode, local.FormSpecJSON,
			local.HCLContent, local.HCLSHA256, local.RendererVersion
		if b, err := s.Keys.Decrypt(local.JobJSONEncrypted, db.JobJSONAAD(local.ID)); err == nil {
			jobJSON = b
		}
		if vars := s.revisionVars(local); len(vars) > 0 {
			vb, _ := json.Marshal(vars)
			if rev.VariablesEncrypted, err = s.Keys.Encrypt(vb, db.JobVariablesAAD(rev.ID)); err != nil {
				return nil, err
			}
		}
	}
	if rev.JobJSONEncrypted, err = s.Keys.Encrypt(jobJSON, db.JobJSONAAD(rev.ID)); err != nil {
		return nil, err
	}
	if err := db.InsertRevision(ctx, s.DB.Writer, rev); err != nil {
		return nil, err
	}
	var resp struct {
		EvalID         string `json:"EvalID"`
		JobModifyIndex uint64 `json:"JobModifyIndex"`
	}
	err = c.Request(ctx, http.MethodPost, jobPath(jobID)+"/revert"+q(ns), map[string]any{"JobID": jobID, "JobVersion": version,
		"EnforcePriorVersion": u64(current["Version"])}, &resp)
	s.auditJob(ctx, actor, clusterID, ns, jobID, "revert", map[string]any{"to_version": version, "revision": rev.RevisionNo}, err)
	if err != nil {
		if definiteRejection(err) {
			_ = db.SetRevisionStatus(ctx, s.DB.Writer, rev.ID, db.RevFailed)
		}
		return nil, nomadErr(err)
	}
	v := s.versionAt(ctx, c, ns, jobID, resp.JobModifyIndex)
	if err := db.ConfirmRevision(ctx, s.DB.Writer, rev.ID, resp.JobModifyIndex, v, resp.EvalID, db.RevConfirmed); err != nil {
		return nil, err
	}
	out := &ApplyResult{RevisionID: rev.ID, RevisionNo: rev.RevisionNo, EvalID: resp.EvalID, JobModifyIndex: resp.JobModifyIndex, Status: db.RevConfirmed}
	if v != nil {
		out.Version = *v
	}
	return out, nil
}

// ---- Restart ----

// RestartInput selects what to restart.
type RestartInput struct {
	Group   string `json:"group"`
	AllocID string `json:"alloc_id"`
}

type allocStub struct {
	ID           string `json:"ID"`
	TaskGroup    string `json:"TaskGroup"`
	ClientStatus string `json:"ClientStatus"`
	NodeName     string `json:"NodeName"`
}

// Restart restarts the running allocations of a job (or one group, or one
// allocation) one at a time, waiting for each to run again.
func (s *Service) Restart(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string, in RestartInput) (*db.OperationTask, error) {
	if err := validRef(ns, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var allocs []allocStub
	if err := c.Request(ctx, http.MethodGet, jobPath(jobID)+"/allocations"+q(ns), nil, &allocs); err != nil {
		return nil, nomadErr(err)
	}
	var targets []allocStub
	for _, a := range allocs {
		if a.ClientStatus != "running" || in.Group != "" && a.TaskGroup != in.Group || in.AllocID != "" && a.ID != in.AllocID {
			continue
		}
		targets = append(targets, a)
	}
	if len(targets) == 0 {
		return nil, conflict("nothing_running", "没有符合条件的运行中 Allocation")
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "nomad.job_restart", TargetType: "cluster", TargetID: clusterID,
		Locks: []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}, TriggeredBy: actor.Name,
		Params: map[string]any{"namespace": ns, "job": jobID, "group": in.Group, "alloc": in.AllocID, "allocs": len(targets)},
		Run: func(ctx context.Context, t *ops.Task) error {
			for _, a := range targets {
				step, err := t.Step("重启 Allocation "+a.ID[:8]+"（"+a.TaskGroup+"@"+a.NodeName+"）", "")
				if err != nil {
					return err
				}
				err = s.restartAlloc(ctx, c, a.ID, step.Logf)
				step.Finish(err, nil)
				if err != nil {
					return fmt.Errorf("滚动重启在 %s 处停止：%w", a.ID[:8], err)
				}
			}
			return nil
		}})
	if err != nil {
		return nil, err
	}
	s.auditJob(ctx, actor, clusterID, ns, jobID, "restart", map[string]any{"group": in.Group, "alloc": in.AllocID, "allocs": len(targets),
		"task": task.ID}, nil)
	return task, nil
}

func (s *Service) restartAlloc(ctx context.Context, c *nomad.Client, allocID string, log func(string, ...any)) error {
	restarts := func() (int, string, error) {
		var a struct {
			ClientStatus string `json:"ClientStatus"`
			TaskStates   map[string]struct {
				State    string `json:"State"`
				Restarts int    `json:"Restarts"`
			} `json:"TaskStates"`
		}
		if err := c.Request(ctx, http.MethodGet, "allocation/"+url.PathEscape(allocID), nil, &a); err != nil {
			return -1, "", err
		}
		n, running := 0, a.ClientStatus == "running"
		for _, ts := range a.TaskStates {
			n += ts.Restarts
			if ts.State != "running" && ts.State != "dead" {
				running = false
			}
		}
		if running {
			return n, "running", nil
		}
		return n, a.ClientStatus, nil
	}
	before, _, err := restarts()
	if err != nil {
		return nomadErr(err)
	}
	if err := c.Request(ctx, http.MethodPost, "client/allocation/"+url.PathEscape(allocID)+"/restart", map[string]any{"AllTasks": true}, nil); err != nil {
		return nomadErr(err)
	}
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		if n, st, rerr := restarts(); rerr == nil && n > before && st == "running" {
			log("已重启并恢复运行（重启次数 %d）", n)
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("Allocation %s 重启后未恢复运行", allocID[:8])
}

// ---- Scaling ----

// ScaleInput changes a group's count.
type ScaleInput struct {
	Group  string `json:"group"`
	Count  int    `json:"count"`
	Reason string `json:"reason"`
}

// ScaleResult is the outcome of a scale request.
type ScaleResult struct {
	RevisionID  string `json:"revision_id"`
	OperationID string `json:"operation_id"`
	Status      string `json:"submit_status"`
	EvalID      string `json:"eval_id,omitempty"`
	Version     uint64 `json:"version,omitempty"`
	Overridden  bool   `json:"count_overridden"`
}

// RewriteCount rewrites the literal count of a group in HCL with hclwrite
// (nothing else changes). It reports false when the count is not a literal
// (variable or expression) or the group is not found.
func RewriteCount(src, group string, count int) (string, bool) {
	f, diags := hclwrite.ParseConfig([]byte(src), "job.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		return "", false
	}
	for _, jb := range f.Body().Blocks() {
		if jb.Type() != "job" {
			continue
		}
		for _, gb := range jb.Body().Blocks() {
			if gb.Type() != "group" || len(gb.Labels()) != 1 || gb.Labels()[0] != group {
				continue
			}
			attr := gb.Body().GetAttribute("count")
			if attr != nil {
				expr := strings.TrimSpace(string(attr.Expr().BuildTokens(nil).Bytes()))
				if _, err := strconv.Atoi(expr); err != nil {
					return "", false
				}
			}
			gb.Body().SetAttributeValue("count", cty.NumberIntVal(int64(count)))
			out := f.Bytes()
			if _, d := hclsyntax.ParseConfig(out, "job.hcl", hcl.InitialPos); d.HasErrors() {
				return "", false
			}
			return string(out), true
		}
	}
	return "", false
}

// SyncSpecCount updates a visual spec's group count and re-renders its HCL
// (set by the visual builder).
var SyncSpecCount func(spec, group string, count int) (newSpec, newHCL string, ok bool)

// Scale changes a group's count with the operation ID protocol: an
// in_doubt intent revision first, EnforceIndex on the current index, the
// operation ID in the scaling event meta; a definite rejection fails the
// revision, a success confirms it, anything else stays in_doubt for
// reconciliation. The stored source keeps the new count so the next Apply
// does not undo the scaling.
func (s *Service) Scale(ctx context.Context, actor audit.Actor, clusterID, ns, jobID string, in ScaleInput) (*ScaleResult, error) {
	if err := validRef(ns, jobID); err != nil {
		return nil, err
	}
	if in.Count < 0 || in.Count > 10000 || in.Group == "" || len(in.Reason) > 512 {
		return nil, badRequest("副本数需为 0～10000，并指定 Task Group")
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	j, err := getJob(ctx, c, ns, jobID)
	if err != nil {
		return nil, nomadErr(err)
	}
	var tg map[string]any
	for _, g := range list(j["TaskGroups"]) {
		if str(obj(g)["Name"]) == in.Group {
			tg = obj(g)
		}
	}
	if tg == nil {
		return nil, badRequest("Task Group %s 不存在", in.Group)
	}
	if sc := obj(tg["Scaling"]); sc != nil {
		if min, max := u64(sc["Min"]), u64(sc["Max"]); in.Count < int(min) || max > 0 && in.Count > int(max) {
			return nil, badRequest("副本数需在 scaling 块的 %d～%d 之间", min, max)
		}
	}
	var dep struct {
		Status string `json:"Status"`
	}
	if err := c.Request(ctx, http.MethodGet, jobPath(jobID)+"/deployment"+q(ns), nil, &dep); err == nil && (dep.Status == "running" || dep.Status == "paused") {
		return nil, conflict("deployment_in_progress", "Job 有进行中的 Deployment（%s），Nomad 会拒绝扩缩", dep.Status)
	}
	from := int(u64(tg["Count"]))
	base := u64(j["JobModifyIndex"])
	tg["Count"] = in.Count
	opID := randomID()
	summary, _ := json.Marshal(map[string]any{"group": in.Group, "from": from, "to": in.Count, "reason": in.Reason})
	rev := &db.JobRevision{ID: db.NewID(), ClusterID: clusterID, Namespace: ns, JobID: jobID, Source: "scale", EditMode: "json",
		OperationID: opID, BaseJobModifyIndex: base, SubmitStatus: db.RevInDoubt, PlanSummary: string(summary),
		SubmittedBy: actor.Name, CreatedAt: s.DB.Now()}
	if prev := s.latestAuthoritative(ctx, clusterID, ns, jobID, j); prev != nil {
		rev.EditMode, rev.RendererVersion, rev.VariablesEncrypted = prev.EditMode, prev.RendererVersion, ""
		if vars := s.revisionVars(prev); len(vars) > 0 {
			vb, _ := json.Marshal(vars)
			if rev.VariablesEncrypted, err = s.Keys.Encrypt(vb, db.JobVariablesAAD(rev.ID)); err != nil {
				return nil, err
			}
		}
		over := map[string]int{}
		if prev.CountOverriddenJSON != "" {
			_ = json.Unmarshal([]byte(prev.CountOverriddenJSON), &over)
		}
		delete(over, in.Group)
		synced := false
		if prev.EditMode == "visual" && prev.FormSpecJSON != "" && SyncSpecCount != nil {
			if spec, h, ok := SyncSpecCount(prev.FormSpecJSON, in.Group, in.Count); ok {
				rev.FormSpecJSON, rev.HCLContent, synced = spec, h, true
			}
		}
		if !synced && prev.HCLContent != "" {
			if h, ok := RewriteCount(prev.HCLContent, in.Group, in.Count); ok {
				rev.HCLContent, synced = h, true
				if prev.EditMode == "visual" {
					rev.EditMode = "hcl" // the spec could not follow; the rewritten HCL is authoritative
				}
			} else {
				rev.HCLContent, rev.FormSpecJSON = prev.HCLContent, prev.FormSpecJSON
			}
		}
		if !synced && prev.EditMode != "json" {
			over[in.Group] = in.Count
		}
		if rev.HCLContent != "" {
			rev.HCLSHA256 = sha([]byte(rev.HCLContent))
		}
		if len(over) > 0 {
			b, _ := json.Marshal(over)
			rev.CountOverriddenJSON = string(b)
		}
	}
	if rev.JobJSONEncrypted, err = s.Keys.Encrypt(canonical(j), db.JobJSONAAD(rev.ID)); err != nil {
		return nil, err
	}
	if err := db.InsertRevision(ctx, s.DB.Writer, rev); err != nil {
		return nil, err
	}
	var resp struct {
		EvalID         string `json:"EvalID"`
		JobModifyIndex uint64 `json:"JobModifyIndex"`
	}
	err = c.Request(ctx, http.MethodPost, jobPath(jobID)+"/scale"+q(ns), map[string]any{"Count": in.Count,
		"Target": map[string]string{"Group": in.Group}, "Message": in.Reason, "Meta": map[string]string{"nomaddeck_operation_id": opID},
		"EnforceIndex": true, "JobModifyIndex": base}, &resp)
	s.auditJob(ctx, actor, clusterID, ns, jobID, "scale", map[string]any{"group": in.Group, "from": from, "to": in.Count,
		"operation_id": opID, "revision": rev.RevisionNo}, err)
	res := &ScaleResult{RevisionID: rev.ID, OperationID: opID, Overridden: rev.CountOverriddenJSON != ""}
	if err != nil {
		if definiteRejection(err) {
			_ = db.SetRevisionStatus(ctx, s.DB.Writer, rev.ID, db.RevFailed)
			return nil, nomadErr(err)
		}
		res.Status = db.RevInDoubt
		return res, &auth.Error{Status: 502, Code: "scale_in_doubt", Message: fmt.Sprintf("扩缩结果未知（%v），已记录待对账，不会自动重试", err)}
	}
	v := s.versionAt(ctx, c, ns, jobID, resp.JobModifyIndex)
	if err := db.ConfirmRevision(ctx, s.DB.Writer, rev.ID, resp.JobModifyIndex, v, resp.EvalID, db.RevConfirmed); err != nil {
		return nil, err
	}
	res.Status, res.EvalID = db.RevConfirmed, resp.EvalID
	if v != nil {
		res.Version = *v
	}
	return res, nil
}

// ---- Reconciliation ----

// Reconcile settles the in_doubt revisions of a job: scaling revisions are
// matched by their operation ID in the scaling events; submissions by a
// later version carrying the submitted definition. An unchanged job means
// the request never took effect; a changed job without matching evidence
// needs an administrator's review (never claimed on counts alone).
func (s *Service) Reconcile(ctx context.Context, clusterID, ns, jobID string) error {
	revs, err := db.ListRevisions(ctx, s.DB.Reader, clusterID, ns, jobID)
	if err != nil {
		return err
	}
	var pending []*db.JobRevision
	for _, r := range revs {
		if r.SubmitStatus == db.RevInDoubt {
			pending = append(pending, r)
		}
	}
	if len(pending) == 0 {
		return nil
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return err
	}
	j, err := getJob(ctx, c, ns, jobID)
	if err != nil && !isNotFound(err) {
		return nomadErr(err)
	}
	for _, r := range pending {
		status, index, version, evalID := s.settle(ctx, c, r, j)
		if status == db.RevConfirmed {
			_ = db.ConfirmRevision(ctx, s.DB.Writer, r.ID, index, version, evalID, status)
		} else if status != db.RevInDoubt {
			_ = db.SetRevisionStatus(ctx, s.DB.Writer, r.ID, status)
		}
	}
	return nil
}

func (s *Service) settle(ctx context.Context, c *nomad.Client, r *db.JobRevision, j Job) (string, uint64, *uint64, string) {
	if j == nil {
		return db.RevNeedsReview, 0, nil, ""
	}
	current := u64(j["JobModifyIndex"])
	if r.Source == "scale" && r.OperationID != "" {
		var group struct {
			Group string `json:"group"`
		}
		_ = json.Unmarshal([]byte(r.PlanSummary), &group)
		var st struct {
			TaskGroups map[string]struct {
				Events []struct {
					Meta   map[string]any `json:"Meta"`
					EvalID string         `json:"EvalID"`
				} `json:"Events"`
			} `json:"TaskGroups"`
		}
		if err := c.Request(ctx, http.MethodGet, jobPath(r.JobID)+"/scale"+q(r.Namespace), nil, &st); err != nil {
			return db.RevInDoubt, 0, nil, ""
		}
		for _, ev := range st.TaskGroups[group.Group].Events {
			if fmt.Sprint(ev.Meta["nomaddeck_operation_id"]) != r.OperationID {
				continue
			}
			if ev.EvalID != "" {
				var e struct {
					JobModifyIndex uint64 `json:"JobModifyIndex"`
				}
				if err := c.Request(ctx, http.MethodGet, "evaluation/"+url.PathEscape(ev.EvalID), nil, &e); err == nil && e.JobModifyIndex > 0 {
					return db.RevConfirmed, e.JobModifyIndex, s.versionAt(ctx, c, r.Namespace, r.JobID, e.JobModifyIndex), ev.EvalID
				}
			}
			return db.RevNeedsReview, 0, nil, ""
		}
		if current == r.BaseJobModifyIndex {
			return db.RevFailed, 0, nil, ""
		}
		return db.RevNeedsReview, 0, nil, ""
	}
	if current == r.BaseJobModifyIndex {
		return db.RevFailed, 0, nil, ""
	}
	local, err := s.revisionJob(r)
	if err != nil {
		return db.RevNeedsReview, 0, nil, ""
	}
	vs, _, err := versions(ctx, c, r.Namespace, r.JobID, false)
	if err != nil {
		return db.RevInDoubt, 0, nil, ""
	}
	var match Job
	matches := 0
	for _, v := range vs {
		if u64(v["JobModifyIndex"]) > r.BaseJobModifyIndex && matchesSubmitted(local, v) {
			matches++
			if match == nil {
				match = v
			}
		}
	}
	if matches == 1 {
		v := u64(match["Version"])
		return db.RevConfirmed, u64(match["JobModifyIndex"]), &v, ""
	}
	return db.RevNeedsReview, 0, nil, ""
}

// ResolveReview lets an administrator settle a needs_review revision.
func (s *Service) ResolveReview(ctx context.Context, actor audit.Actor, clusterID, revisionID string, applied bool, version *uint64) error {
	r, err := db.GetRevision(ctx, s.DB.Reader, revisionID)
	if err != nil || r.ClusterID != clusterID {
		return &auth.Error{Status: 404, Code: "not_found", Message: "版本记录不存在"}
	}
	if r.SubmitStatus != db.RevNeedsReview {
		return conflict("not_needs_review", "该记录不处于 needs_review")
	}
	if !applied {
		err = db.SetRevisionStatus(ctx, s.DB.Writer, r.ID, db.RevFailed)
	} else {
		if version == nil {
			return badRequest("确认已执行时需指定对应的 Job 版本")
		}
		c, err2 := s.api(ctx, clusterID)
		if err2 != nil {
			return err2
		}
		vs, _, err2 := versions(ctx, c, r.Namespace, r.JobID, false)
		if err2 != nil {
			return nomadErr(err2)
		}
		var idx uint64
		for _, v := range vs {
			if u64(v["Version"]) == *version {
				idx = u64(v["JobModifyIndex"])
			}
		}
		if idx == 0 {
			return badRequest("Nomad 中没有版本 %d", *version)
		}
		err = db.ConfirmRevision(ctx, s.DB.Writer, r.ID, idx, version, r.EvalID, db.RevConfirmed)
	}
	s.auditJob(ctx, actor, clusterID, r.Namespace, r.JobID, "revision_review", map[string]any{"revision": r.RevisionNo, "applied": applied}, err)
	return err
}
