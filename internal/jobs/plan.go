package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// planRecord is an immutable reviewed plan. Apply submits exactly its Job
// JSON with its JobModifyIndex; nothing from the client is re-parsed.
type planRecord struct {
	ID              string
	ClusterID       string
	Namespace       string
	JobID           string
	JobJSON         []byte
	Hash            string
	JobModifyIndex  uint64
	PolicyOverride  bool
	InputType       string
	EditMode        string
	HCL             string
	Variables       map[string]string
	FormSpec        string
	RendererVersion string
	Source          string
	CountOverridden string
	SessionID       string
	AdminID         string
	ExpiresAt       time.Time
}

type planStore struct {
	mu    sync.Mutex
	plans map[string]*planRecord
}

func newPlanStore() *planStore { return &planStore{plans: map[string]*planRecord{}} }

func (p *planStore) put(r *planRecord) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for id, x := range p.plans {
		if now.After(x.ExpiresAt) {
			delete(p.plans, id)
		}
	}
	p.plans[r.ID] = r
}

// take removes and returns a plan: a plan is usable once, whatever the outcome.
func (p *planStore) take(id string) *planRecord {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := p.plans[id]
	delete(p.plans, id)
	return r
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func planHash(job []byte, clusterID, namespace string) string {
	return sha(append(append(append([]byte{}, job...), []byte("\x00"+clusterID)...), []byte("\x00"+namespace)...))
}

// PlanInput is a plan request.
type PlanInput struct {
	// InputType is hcl (HCL source plus variable values, parsed by Nomad)
	// or json (a Job JSON document, validated without parsing).
	InputType string            `json:"input_type"`
	Namespace string            `json:"namespace"`
	HCL       string            `json:"hcl"`
	Variables map[string]string `json:"variables"`
	JobJSON   json.RawMessage   `json:"job_json"`
	// RevisionID takes the Job JSON of a local revision (stop archive or a
	// version Nomad no longer keeps).
	RevisionID      string          `json:"revision_id"`
	PolicyOverride  bool            `json:"policy_override"`
	EditMode        string          `json:"edit_mode"`
	FormSpec        json.RawMessage `json:"form_spec"`
	RendererVersion string          `json:"renderer_version"`
}

// PlanResult is what the reviewer sees.
type PlanResult struct {
	PlanID          string         `json:"plan_id"`
	PlanHash        string         `json:"plan_hash"`
	ExpiresAt       time.Time      `json:"expires_at"`
	JobID           string         `json:"job_id"`
	Namespace       string         `json:"namespace"`
	JobModifyIndex  uint64         `json:"job_modify_index"`
	Diff            any            `json:"diff"`
	Annotations     any            `json:"annotations"`
	FailedTGAllocs  any            `json:"failed_tg_allocs"`
	Warnings        string         `json:"warnings"`
	ValidationWarns string         `json:"validation_warnings,omitempty"`
	Job             Job            `json:"job"`
	CountOverridden map[string]int `json:"count_overridden,omitempty"`
}

var reVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,127}$`)

// VariablesFile renders variable values as an HCL variables file.
func VariablesFile(vars map[string]string) (string, error) {
	names := make([]string, 0, len(vars))
	for k := range vars {
		if !reVarName.MatchString(k) {
			return "", badRequest("变量名 %q 不合法", k)
		}
		names = append(names, k)
	}
	sort.Strings(names)
	f := hclwrite.NewEmptyFile()
	for _, k := range names {
		f.Body().SetAttributeValue(k, cty.StringVal(vars[k]))
	}
	return string(f.Bytes()), nil
}

// ParseHCL asks Nomad to parse HCL with variables into a canonical Job JSON.
func ParseHCL(ctx context.Context, c *nomad.Client, hcl string, vars map[string]string) (Job, error) {
	vf, err := VariablesFile(vars)
	if err != nil {
		return nil, err
	}
	var j Job
	if err := request(ctx, c, http.MethodPost, "jobs/parse", map[string]any{"JobHCL": hcl, "Variables": vf, "Canonicalize": true}, &j); err != nil {
		var ae *nomad.APIError
		if errors.As(err, &ae) && ae.Status < 500 {
			return nil, &auth.Error{Status: 400, Code: "hcl_invalid", Message: "Nomad 解析 HCL 失败：" + ae.Message}
		}
		return nil, nomadErr(err)
	}
	return j, nil
}

// Validate asks Nomad to validate a Job JSON; it returns warnings.
func Validate(ctx context.Context, c *nomad.Client, j Job) (string, error) {
	var r struct {
		ValidationErrors []string `json:"ValidationErrors"`
		Error            string   `json:"Error"`
		Warnings         string   `json:"Warnings"`
	}
	if err := request(ctx, c, http.MethodPost, "validate/job", map[string]any{"Job": j}, &r); err != nil {
		var ae *nomad.APIError
		if errors.As(err, &ae) && ae.Status < 500 {
			return "", &auth.Error{Status: 400, Code: "job_invalid", Message: "Job 校验失败：" + ae.Message}
		}
		return "", nomadErr(err)
	}
	if len(r.ValidationErrors) > 0 || r.Error != "" {
		msg := r.Error
		if len(r.ValidationErrors) > 0 {
			msg = strings.Join(r.ValidationErrors, "；")
		}
		return "", &auth.Error{Status: 400, Code: "job_invalid", Message: "Job 校验失败：" + msg}
	}
	return r.Warnings, nil
}

// resolveJob turns a plan input into a Job JSON (and the HCL source).
func (s *Service) resolveJob(ctx context.Context, c *nomad.Client, clusterID string, in *PlanInput) (Job, error) {
	switch in.InputType {
	case "hcl":
		if strings.TrimSpace(in.HCL) == "" {
			return nil, badRequest("HCL 内容为空")
		}
		if len(in.HCL) > 1<<20 {
			return nil, badRequest("HCL 内容过大")
		}
		return ParseHCL(ctx, c, in.HCL, in.Variables)
	case "json":
		raw := []byte(in.JobJSON)
		if in.RevisionID != "" {
			rev, err := db.GetRevision(ctx, s.DB.Reader, in.RevisionID)
			if err != nil || rev.ClusterID != clusterID || rev.JobJSONEncrypted == "" {
				return nil, &auth.Error{Status: 404, Code: "not_found", Message: "本地归档版本不存在"}
			}
			if raw, err = s.Keys.Decrypt(rev.JobJSONEncrypted, db.JobJSONAAD(rev.ID)); err != nil {
				return nil, err
			}
			if rev.HCLContent != "" && in.HCL == "" {
				in.HCL = rev.HCLContent
				in.FormSpec = json.RawMessage(rev.FormSpecJSON)
				in.RendererVersion = rev.RendererVersion
				if in.EditMode == "" {
					in.EditMode = rev.EditMode
				}
				if rev.VariablesEncrypted != "" && in.Variables == nil {
					if vb, err := s.Keys.Decrypt(rev.VariablesEncrypted, db.JobVariablesAAD(rev.ID)); err == nil {
						_ = json.Unmarshal(vb, &in.Variables)
					}
				}
			}
		}
		if len(raw) == 0 {
			return nil, badRequest("Job JSON 为空")
		}
		j, err := decodeJob(raw)
		if err != nil {
			return nil, badRequest("Job JSON 格式不正确：%v", err)
		}
		if inner := obj(j["Job"]); inner != nil && j["ID"] == nil {
			j = inner // accept {"Job": {...}} as well
		}
		return j, nil
	}
	return nil, badRequest("input_type 需为 hcl 或 json")
}

// Plan resolves the input, validates and plans it, and stores an immutable
// one-time plan record bound to the caller.
func (s *Service) Plan(ctx context.Context, caller Caller, clusterID string, in PlanInput) (*PlanResult, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	j, err := s.resolveJob(ctx, c, clusterID, &in)
	if err != nil {
		return nil, err
	}
	if in.Namespace != "" && str(j["Namespace"]) == "" {
		j["Namespace"] = in.Namespace
	}
	if str(j["Namespace"]) == "" {
		j["Namespace"] = "default"
	}
	ns, id := str(j["Namespace"]), str(j["ID"])
	if err := validRef(ns, id); err != nil {
		return nil, err
	}
	warns, err := Validate(ctx, c, j)
	if err != nil {
		return nil, err
	}
	var pr struct {
		Diff           any    `json:"Diff"`
		Annotations    any    `json:"Annotations"`
		FailedTGAllocs any    `json:"FailedTGAllocs"`
		JobModifyIndex uint64 `json:"JobModifyIndex"`
		Warnings       string `json:"Warnings"`
	}
	if err := c.Request(ctx, http.MethodPost, jobPath(id)+"/plan"+q(ns), map[string]any{"Job": j, "Diff": true,
		"PolicyOverride": in.PolicyOverride}, &pr); err != nil {
		return nil, nomadErr(err)
	}
	if in.EditMode == "" {
		in.EditMode = map[string]string{"hcl": "hcl", "json": "json"}[in.InputType]
	}
	if in.EditMode != "visual" && in.EditMode != "hcl" && in.EditMode != "json" {
		return nil, badRequest("edit_mode 需为 visual、hcl 或 json")
	}
	body := canonical(j)
	rec := &planRecord{ID: randomID(), ClusterID: clusterID, Namespace: ns, JobID: id, JobJSON: body,
		Hash: planHash(body, clusterID, ns), JobModifyIndex: pr.JobModifyIndex, PolicyOverride: in.PolicyOverride,
		InputType: in.InputType, EditMode: in.EditMode, HCL: in.HCL, Variables: in.Variables, RendererVersion: in.RendererVersion,
		Source: "workbench", SessionID: caller.SessionID, AdminID: caller.Actor.ID, ExpiresAt: time.Now().Add(s.planTTL())}
	if len(in.FormSpec) > 0 && string(in.FormSpec) != "null" {
		rec.FormSpec = string(in.FormSpec)
	}
	if in.EditMode == "json" {
		rec.HCL, rec.FormSpec = "", ""
	}
	res := &PlanResult{PlanID: rec.ID, PlanHash: rec.Hash, ExpiresAt: rec.ExpiresAt, JobID: id, Namespace: ns,
		JobModifyIndex: pr.JobModifyIndex, Diff: pr.Diff, Annotations: pr.Annotations, FailedTGAllocs: pr.FailedTGAllocs,
		Warnings: pr.Warnings, ValidationWarns: warns, Job: j}
	if over := s.pendingCountOverride(ctx, clusterID, ns, id); len(over) > 0 {
		res.CountOverridden = over
	}
	s.store().put(rec)
	return res, nil
}

// pendingCountOverride reports groups whose live count came from scaling
// but could not be written back into the HCL: applying the definition
// resets them to the defined count.
func (s *Service) pendingCountOverride(ctx context.Context, clusterID, ns, jobID string) map[string]int {
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, clusterID, ns, jobID)
	for _, r := range revs {
		if r.SubmitStatus != db.RevConfirmed {
			continue
		}
		if r.CountOverriddenJSON == "" {
			return nil
		}
		var m map[string]int
		_ = json.Unmarshal([]byte(r.CountOverriddenJSON), &m)
		return m
	}
	return nil
}

// ApplyResult is the outcome of an Apply.
type ApplyResult struct {
	RevisionID     string `json:"revision_id"`
	RevisionNo     int    `json:"revision_no"`
	EvalID         string `json:"eval_id"`
	JobModifyIndex uint64 `json:"job_modify_index"`
	Version        uint64 `json:"version"`
	Status         string `json:"submit_status"`
}

// Apply submits the reviewed Job JSON of a plan record exactly as reviewed,
// with EnforceIndex on the planned JobModifyIndex. The plan record is
// consumed whatever the outcome. The revision is written as in_doubt
// before the call and confirmed with Nomad's answer.
func (s *Service) Apply(ctx context.Context, caller Caller, clusterID, planID string) (*ApplyResult, error) {
	rec := s.store().take(planID)
	switch {
	case rec == nil:
		return nil, conflict("plan_not_found", "Plan 不存在、已使用或已过期，请重新 Plan")
	case time.Now().After(rec.ExpiresAt):
		return nil, conflict("plan_expired", "Plan 已过期，请重新 Plan")
	case rec.ClusterID != clusterID:
		return nil, badRequest("Plan 不属于该集群")
	case rec.SessionID != caller.SessionID || rec.AdminID != caller.Actor.ID:
		return nil, &auth.Error{Status: 403, Code: "plan_not_yours", Message: "Plan 不属于当前会话"}
	case planHash(rec.JobJSON, rec.ClusterID, rec.Namespace) != rec.Hash:
		return nil, conflict("plan_tampered", "Plan 内容校验失败，请重新 Plan")
	}
	return s.submit(ctx, caller.Actor, rec)
}

// submit registers a plan record's Job JSON and records the revision.
func (s *Service) submit(ctx context.Context, actor audit.Actor, rec *planRecord) (*ApplyResult, error) {
	c, err := s.api(ctx, rec.ClusterID)
	if err != nil {
		return nil, err
	}
	j, err := decodeJob(rec.JobJSON)
	if err != nil {
		return nil, err
	}
	rev := &db.JobRevision{ID: db.NewID(), ClusterID: rec.ClusterID, Namespace: rec.Namespace, JobID: rec.JobID, Source: rec.Source,
		EditMode: rec.EditMode, RendererVersion: rec.RendererVersion, FormSpecJSON: rec.FormSpec, HCLContent: rec.HCL,
		BaseJobModifyIndex: rec.JobModifyIndex, SubmitStatus: db.RevInDoubt, SubmittedBy: actor.Name, CreatedAt: s.DB.Now(),
		CountOverriddenJSON: rec.CountOverridden}
	if rec.HCL != "" {
		rev.HCLSHA256 = sha([]byte(rec.HCL))
	}
	if rev.JobJSONEncrypted, err = s.Keys.Encrypt(rec.JobJSON, db.JobJSONAAD(rev.ID)); err != nil {
		return nil, err
	}
	if len(rec.Variables) > 0 {
		vb, _ := json.Marshal(rec.Variables)
		if rev.VariablesEncrypted, err = s.Keys.Encrypt(vb, db.JobVariablesAAD(rev.ID)); err != nil {
			return nil, err
		}
	}
	if err := db.InsertRevision(ctx, s.DB.Writer, rev); err != nil {
		return nil, err
	}
	body := map[string]any{"Job": j, "EnforceIndex": true, "JobModifyIndex": rec.JobModifyIndex, "PolicyOverride": rec.PolicyOverride}
	if rec.HCL != "" {
		// The source only: variable values stay encrypted in NomadDeck.
		body["Submission"] = map[string]any{"Source": rec.HCL, "Format": "hcl2"}
	}
	var resp struct {
		EvalID         string `json:"EvalID"`
		JobModifyIndex uint64 `json:"JobModifyIndex"`
		Warnings       string `json:"Warnings"`
	}
	err = c.Request(ctx, http.MethodPost, "jobs"+q(rec.Namespace), body, &resp)
	if err != nil {
		if definiteRejection(err) {
			_ = db.SetRevisionStatus(ctx, s.DB.Writer, rev.ID, db.RevFailed)
			s.auditSubmit(ctx, actor, rec, rev, "failure", err)
			return nil, nomadErr(err)
		}
		s.auditSubmit(ctx, actor, rec, rev, "failure", err)
		return nil, &auth.Error{Status: 502, Code: "submit_in_doubt",
			Message: fmt.Sprintf("提交结果未知（%v），版本记录 %d 保持 in_doubt，稍后由对账流程核对", err, rev.RevisionNo)}
	}
	version := s.versionAt(ctx, c, rec.Namespace, rec.JobID, resp.JobModifyIndex)
	if err := db.ConfirmRevision(ctx, s.DB.Writer, rev.ID, resp.JobModifyIndex, version, resp.EvalID, db.RevConfirmed); err != nil {
		return nil, err
	}
	s.auditSubmit(ctx, actor, rec, rev, "success", nil)
	out := &ApplyResult{RevisionID: rev.ID, RevisionNo: rev.RevisionNo, EvalID: resp.EvalID, JobModifyIndex: resp.JobModifyIndex,
		Status: db.RevConfirmed}
	if version != nil {
		out.Version = *version
	}
	return out, nil
}

func (s *Service) auditSubmit(ctx context.Context, actor audit.Actor, rec *planRecord, rev *db.JobRevision, result string, err error) {
	ev := audit.Event{Actor: actor, Action: "nomad.job_" + rec.Source, ResourceType: "nomad_job", ResourceID: rec.ClusterID + "/" +
		rec.Namespace + "/" + rec.JobID, ResourceName: rec.JobID, Err: err,
		Summary: map[string]any{"revision": rev.RevisionNo, "edit_mode": rec.EditMode, "input_type": rec.InputType,
			"base_job_modify_index": rec.JobModifyIndex, "plan_hash": rec.Hash, "variables": len(rec.Variables)}}
	_ = result
	_ = s.Audit.Record(ctx, nil, ev)
}

// definiteRejection reports errors Nomad returns before changing anything.
func definiteRejection(err error) bool {
	var ae *nomad.APIError
	if !errors.As(err, &ae) {
		return false
	}
	msg := strings.ToLower(ae.Message)
	return ae.Status >= 400 && ae.Status < 500 || strings.Contains(msg, "enforcing job modify index") ||
		strings.Contains(msg, "conflicting job modify index") || strings.Contains(msg, "enforcing version") ||
		strings.Contains(msg, "validation failed") || strings.Contains(msg, "deployment") && strings.Contains(msg, "progress")
}

// versionAt finds the job version created at a JobModifyIndex.
func (s *Service) versionAt(ctx context.Context, c *nomad.Client, ns, jobID string, index uint64) *uint64 {
	if j, err := getJob(ctx, c, ns, jobID); err == nil && u64(j["JobModifyIndex"]) == index {
		v := u64(j["Version"])
		return &v
	}
	var vs struct {
		Versions []Job `json:"Versions"`
	}
	if err := request(ctx, c, http.MethodGet, jobPath(jobID)+"/versions"+q(ns), nil, &vs); err == nil {
		for _, v := range vs.Versions {
			if u64(v["JobModifyIndex"]) == index {
				n := u64(v["Version"])
				return &n
			}
		}
	}
	return nil
}
