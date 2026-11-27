package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// RevisionView is a revision without encrypted content.
type RevisionView struct {
	ID                   string          `json:"id"`
	RevisionNo           int             `json:"revision_no"`
	Source               string          `json:"source"`
	EditMode             string          `json:"edit_mode"`
	HasHCL               bool            `json:"has_hcl"`
	HasVariables         bool            `json:"has_variables"`
	OperationID          string          `json:"operation_id,omitempty"`
	BaseJobModifyIndex   uint64          `json:"base_job_modify_index"`
	ResultJobModifyIndex uint64          `json:"result_job_modify_index"`
	RemoteJobVersion     *uint64         `json:"remote_job_version"`
	EvalID               string          `json:"eval_id,omitempty"`
	SubmitStatus         string          `json:"submit_status"`
	PlanSummary          string          `json:"plan_summary,omitempty"`
	CountOverridden      json.RawMessage `json:"count_overridden,omitempty"`
	SubmittedBy          string          `json:"submitted_by"`
	CreatedAt            time.Time       `json:"created_at"`
}

func revisionView(r *db.JobRevision) RevisionView {
	v := RevisionView{ID: r.ID, RevisionNo: r.RevisionNo, Source: r.Source, EditMode: r.EditMode, HasHCL: r.HCLContent != "",
		HasVariables: r.VariablesEncrypted != "", OperationID: r.OperationID, BaseJobModifyIndex: r.BaseJobModifyIndex,
		ResultJobModifyIndex: r.ResultJobModifyIndex, RemoteJobVersion: r.RemoteJobVersion, EvalID: r.EvalID,
		SubmitStatus: r.SubmitStatus, PlanSummary: r.PlanSummary, SubmittedBy: r.SubmittedBy, CreatedAt: r.CreatedAt}
	if r.CountOverriddenJSON != "" {
		v.CountOverridden = json.RawMessage(r.CountOverriddenJSON)
	}
	return v
}

// Revisions lists a job's revisions (metadata only).
func (s *Service) Revisions(ctx context.Context, clusterID, namespace, jobID string) ([]RevisionView, error) {
	if err := validRef(namespace, jobID); err != nil {
		return nil, err
	}
	revs, err := db.ListRevisions(ctx, s.DB.Reader, clusterID, namespace, jobID)
	if err != nil {
		return nil, err
	}
	out := []RevisionView{}
	for _, r := range revs {
		out = append(out, revisionView(r))
	}
	return out, nil
}

// RevisionVariables reveals the variable values of a revision (admin,
// audited).
func (s *Service) RevisionVariables(ctx context.Context, actor audit.Actor, clusterID, revisionID string) (map[string]string, error) {
	r, err := db.GetRevision(ctx, s.DB.Reader, revisionID)
	if err != nil || r.ClusterID != clusterID {
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: "版本记录不存在"}
	}
	vars := map[string]string{}
	if r.VariablesEncrypted != "" {
		b, err := s.Keys.Decrypt(r.VariablesEncrypted, db.JobVariablesAAD(r.ID))
		if err != nil {
			return nil, err
		}
		_ = json.Unmarshal(b, &vars)
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_variables_reveal", ResourceType: "nomad_job",
		ResourceID: clusterID + "/" + r.Namespace + "/" + r.JobID, ResourceName: r.JobID,
		Summary: map[string]any{"revision": r.RevisionNo, "variables": len(vars)}})
	return vars, nil
}

// serverFields are filled in by Nomad and ignored when comparing a local
// archive with a Nomad version.
var serverFields = map[string]bool{"CreateIndex": true, "ModifyIndex": true, "JobModifyIndex": true, "SubmitTime": true,
	"Version": true, "Status": true, "StatusDescription": true, "Stable": true, "Stop": true}

// matchesSubmitted reports whether a Nomad job version carries everything
// the locally archived Job JSON says (Nomad may add defaults and injected
// fields such as identities; an empty local value accepts any remote one).
func matchesSubmitted(local, remote any) bool {
	switch l := local.(type) {
	case map[string]any:
		r, ok := remote.(map[string]any)
		if !ok {
			return isEmpty(l)
		}
		for k, lv := range l {
			if serverFields[k] {
				continue
			}
			if !matchesSubmitted(lv, r[k]) {
				return false
			}
		}
		return true
	case []any:
		r, ok := remote.([]any)
		if !ok {
			return len(l) == 0
		}
		if len(l) != len(r) {
			return false
		}
		for i := range l {
			if !matchesSubmitted(l[i], r[i]) {
				return false
			}
		}
		return true
	case nil:
		return true
	case json.Number:
		if isEmpty(l) {
			return true
		}
		return fmt.Sprint(l) == fmt.Sprint(remote)
	default:
		if isEmpty(l) {
			return true
		}
		return reflect.DeepEqual(l, remote)
	}
}

func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case bool:
		return !x
	case json.Number:
		return x.String() == "0"
	case map[string]any:
		return len(x) == 0
	case []any:
		return len(x) == 0
	}
	return false
}

// Definition is a job version's definition with the origin of its HCL.
type Definition struct {
	Version     uint64          `json:"version"`
	Job         Job             `json:"job,omitempty"`
	HCL         string          `json:"hcl,omitempty"`
	HCLSource   string          `json:"hcl_source"` // nomad_submission | local_archive | none
	NomadHasJob bool            `json:"nomad_has_version"`
	Editable    bool            `json:"editable"`
	Warning     string          `json:"warning,omitempty"`
	RevisionID  string          `json:"revision_id,omitempty"`
	EditMode    string          `json:"edit_mode,omitempty"`
	FormSpec    json.RawMessage `json:"form_spec,omitempty"`
	HasVars     bool            `json:"has_variables"`
}

func versions(ctx context.Context, c *nomad.Client, ns, jobID string, diffs bool) ([]Job, []any, error) {
	var vs struct {
		Versions []Job `json:"Versions"`
		Diffs    []any `json:"Diffs"`
	}
	path := jobPath(jobID) + "/versions" + q(ns)
	if diffs {
		path += "&diffs=true"
	}
	if err := request(ctx, c, http.MethodGet, path, nil, &vs); err != nil {
		return nil, nil, err
	}
	return vs.Versions, vs.Diffs, nil
}

// DefinitionOf returns the definition of a version (nil = current) with its
// HCL looked up in Nomad's submissions first, then in the local archive
// (verified against Nomad's copy of that version when Nomad still has it).
func (s *Service) DefinitionOf(ctx context.Context, clusterID, namespace, jobID string, version *uint64) (*Definition, error) {
	if err := validRef(namespace, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	vs, _, err := versions(ctx, c, namespace, jobID, false)
	if err != nil && !isNotFound(err) {
		return nil, nomadErr(err)
	}
	d := &Definition{HCLSource: "none"}
	var remote Job
	if version == nil {
		if len(vs) == 0 {
			if a := s.latestArchive(ctx, clusterID, namespace, jobID); a != nil && a.RemoteJobVersion != nil {
				version = a.RemoteJobVersion
			} else {
				return nil, errNoJob
			}
		} else {
			v := u64(vs[0]["Version"])
			version = &v
		}
	}
	d.Version = *version
	for _, v := range vs {
		if u64(v["Version"]) == *version {
			remote = v
		}
	}
	d.NomadHasJob = remote != nil
	d.Job = remote
	var sub struct {
		Source string `json:"Source"`
		Format string `json:"Format"`
	}
	if remote != nil {
		if err := c.Request(ctx, http.MethodGet, fmt.Sprintf("%s/submission%s&version=%d", jobPath(jobID), q(namespace), *version), nil, &sub); err == nil && sub.Source != "" {
			d.HCL, d.HCLSource, d.Editable = sub.Source, "nomad_submission", true
		}
	}
	rev := s.revisionForVersion(ctx, clusterID, namespace, jobID, *version)
	if rev != nil {
		d.RevisionID, d.EditMode, d.HasVars = rev.ID, rev.EditMode, rev.VariablesEncrypted != ""
		if rev.FormSpecJSON != "" {
			d.FormSpec = json.RawMessage(rev.FormSpecJSON)
		}
	}
	if d.HCLSource == "none" && rev != nil && rev.HCLContent != "" {
		d.HCL, d.HCLSource = rev.HCLContent, "local_archive"
		local, err := s.revisionJob(rev)
		switch {
		case err != nil:
			d.Warning = "本地归档无法解密：" + err.Error()
		case remote == nil:
			d.Job, d.Editable = local, true
			d.Warning = "Nomad 中已无该版本，以下为本地归档"
		case matchesSubmitted(local, remote):
			d.Editable = true
		default:
			d.Warning = "本地归档与 Nomad 中该版本的定义不一致，只读展示，不能据此编辑"
		}
	}
	if d.Job == nil && rev != nil {
		if local, err := s.revisionJob(rev); err == nil {
			d.Job = local
		}
	}
	if d.HCLSource == "none" && d.Job != nil {
		d.Editable = true // JSON editing mode
		if d.Warning == "" {
			d.Warning = "该版本没有原始 HCL（外部以 JSON 注册或源码已被回收），只能以 JSON 编辑"
		}
	}
	return d, nil
}

func isNotFound(err error) bool {
	return nomad.StatusOf(err) == 404 || strings.Contains(strings.ToLower(nomad.MessageOf(err)), "not found")
}

func (s *Service) revisionForVersion(ctx context.Context, clusterID, ns, jobID string, version uint64) *db.JobRevision {
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, clusterID, ns, jobID)
	for _, r := range revs {
		if r.SubmitStatus == db.RevConfirmed && r.RemoteJobVersion != nil && *r.RemoteJobVersion == version && r.Source != "stop_archive" {
			return r
		}
	}
	for _, r := range revs {
		if r.SubmitStatus == db.RevConfirmed && r.RemoteJobVersion != nil && *r.RemoteJobVersion == version {
			return r
		}
	}
	return nil
}

func (s *Service) revisionJob(r *db.JobRevision) (Job, error) {
	b, err := s.Keys.Decrypt(r.JobJSONEncrypted, db.JobJSONAAD(r.ID))
	if err != nil {
		return nil, err
	}
	return decodeJob(b)
}

// EditSource is what the workbench opens for an existing job.
type EditSource struct {
	Drifted         bool              `json:"drifted"`
	Reason          string            `json:"reason,omitempty"`
	Version         uint64            `json:"version"`
	JobModifyIndex  uint64            `json:"job_modify_index"`
	EditMode        string            `json:"edit_mode"`
	FormSpec        json.RawMessage   `json:"form_spec,omitempty"`
	RendererVersion string            `json:"renderer_version,omitempty"`
	HCL             string            `json:"hcl,omitempty"`
	Variables       map[string]string `json:"variables,omitempty"`
	CountOverridden map[string]int    `json:"count_overridden,omitempty"`
	Job             Job               `json:"job,omitempty"`
	RevisionID      string            `json:"revision_id,omitempty"`
}

// EditSourceOf returns the authoritative source of a live job: the latest
// confirmed local revision when it matches the live version and index;
// otherwise the job drifted (changed by the CLI or another tool) and the
// live definition is returned instead, never the stale local spec.
func (s *Service) EditSourceOf(ctx context.Context, actor audit.Actor, clusterID, namespace, jobID string) (*EditSource, error) {
	if err := validRef(namespace, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	j, err := getJob(ctx, c, namespace, jobID)
	if err != nil {
		return nil, nomadErr(err)
	}
	es := &EditSource{Version: u64(j["Version"]), JobModifyIndex: u64(j["JobModifyIndex"])}
	var latest *db.JobRevision
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, clusterID, namespace, jobID)
	for _, r := range revs {
		if r.SubmitStatus == db.RevConfirmed && r.Source != "stop_archive" {
			latest = r
			break
		}
	}
	if latest != nil && latest.RemoteJobVersion != nil && *latest.RemoteJobVersion == es.Version &&
		latest.ResultJobModifyIndex == es.JobModifyIndex {
		es.EditMode, es.RendererVersion, es.HCL, es.RevisionID = latest.EditMode, latest.RendererVersion, latest.HCLContent, latest.ID
		if latest.FormSpecJSON != "" {
			es.FormSpec = json.RawMessage(latest.FormSpecJSON)
		}
		if latest.VariablesEncrypted != "" {
			if b, err := s.Keys.Decrypt(latest.VariablesEncrypted, db.JobVariablesAAD(latest.ID)); err == nil {
				_ = json.Unmarshal(b, &es.Variables)
			}
		}
		if latest.CountOverriddenJSON != "" {
			_ = json.Unmarshal([]byte(latest.CountOverriddenJSON), &es.CountOverridden)
		}
		if es.EditMode == "json" {
			es.Job = j
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_edit_source", ResourceType: "nomad_job",
			ResourceID: clusterID + "/" + namespace + "/" + jobID, ResourceName: jobID,
			Summary: map[string]any{"revision": latest.RevisionNo, "variables": len(es.Variables)}})
		return es, nil
	}
	es.Drifted = true
	if latest == nil {
		es.Reason = "该 Job 不是经 NomadDeck 提交的，或本地没有其版本记录"
	} else {
		es.Reason = fmt.Sprintf("现网版本 %d 不是 NomadDeck 最近一次提交的版本（本地记录 %d 号），Job 曾被外部修改", es.Version, latest.RevisionNo)
	}
	es.Job = j
	var sub struct {
		Source string `json:"Source"`
	}
	if err := c.Request(ctx, http.MethodGet, fmt.Sprintf("%s/submission%s&version=%d", jobPath(jobID), q(namespace), es.Version), nil, &sub); err == nil && sub.Source != "" {
		es.HCL, es.EditMode = sub.Source, "hcl"
	} else {
		es.EditMode = "json"
	}
	return es, nil
}

func isVaultNotEnabledErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Vault") && strings.Contains(msg, "not enabled")
}

// ValidateInput parses (HCL) or decodes (JSON) an input and validates it
// with Nomad without planning.
func (s *Service) ValidateInput(ctx context.Context, clusterID string, in PlanInput) (Job, string, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, "", err
	}
	j, err := s.resolveJob(ctx, c, clusterID, &in)
	if err != nil {
		return nil, "", err
	}
	if str(j["Namespace"]) == "" {
		j["Namespace"] = orDefault(in.Namespace, "default")
	}
	warns, err := Validate(ctx, c, j)
	if err != nil && isVaultNotEnabledErr(err) {
		return j, "", nil
	}
	return j, warns, err
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// VersionsView lists a job's versions: admins get the full documents and
// Nomad's field diffs, viewers the safe summaries and summary differences.
type VersionsView struct {
	Versions []VersionItem `json:"versions"`
}

// VersionItem is one version.
type VersionItem struct {
	Version        uint64        `json:"version"`
	JobModifyIndex uint64        `json:"job_modify_index"`
	SubmitTime     int64         `json:"submit_time"`
	Stable         bool          `json:"stable"`
	Summary        *Summary      `json:"summary"`
	SummaryDiff    []FieldChange `json:"summary_diff"`
	Job            Job           `json:"job,omitempty"`
	Diff           any           `json:"diff,omitempty"`
	RevisionNo     int           `json:"revision_no,omitempty"`
	Source         string        `json:"source,omitempty"`
}

// Versions returns the versions of a job.
func (s *Service) Versions(ctx context.Context, clusterID, namespace, jobID string, full bool) (*VersionsView, error) {
	if err := validRef(namespace, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	vs, diffs, err := versions(ctx, c, namespace, jobID, true)
	if err != nil {
		return nil, nomadErr(err)
	}
	out := &VersionsView{Versions: []VersionItem{}}
	for i, v := range vs {
		it := VersionItem{Version: u64(v["Version"]), JobModifyIndex: u64(v["JobModifyIndex"]), SubmitTime: int64(u64(v["SubmitTime"])),
			Summary: Summarize(v)}
		it.Stable, _ = v["Stable"].(bool)
		if i+1 < len(vs) {
			it.SummaryDiff = DiffSummaries(Summarize(vs[i+1]), it.Summary)
		} else {
			it.SummaryDiff = []FieldChange{}
		}
		if full {
			it.Job = v
			if i < len(diffs) {
				it.Diff = diffs[i]
			}
		}
		if r := s.revisionForVersion(ctx, clusterID, namespace, jobID, it.Version); r != nil {
			it.RevisionNo, it.Source = r.RevisionNo, r.Source
		}
		out.Versions = append(out.Versions, it)
	}
	return out, nil
}
