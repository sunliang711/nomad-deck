// Package jobs is the Nomad job center: listing and safe projections of
// jobs, Plan/Apply bound to a one-time plan record, revision history with
// encrypted Job JSON and variables, lifecycle operations (start, stop with
// archive, restart, purge, revert), the scaling protocol with operation IDs
// and reconciliation, definition views with drift detection, templates and
// export.
package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
)

// Service is the job center.
type Service struct {
	DB    *db.DB
	Keys  *crypto.Keyring
	Audit *audit.Recorder
	Ops   *ops.Engine
	Nomad *nomad.Service
	Log   *slog.Logger
	// VaultInspector supplies Nomad-Vault integration refs and live KV lookups
	// for job validation, planning and start preflight checks.
	VaultInspector func(ctx context.Context, clusterID string) ([]VaultIntegrationRef, KVSecretChecker)
	// PlanTTL is how long a plan record stays valid (default 15 minutes).
	PlanTTL time.Duration

	plans *planStore
}

var (
	badRequest = cluster.BadRequest
	conflict   = cluster.Conflict
	errNoJob   = &auth.Error{Status: 404, Code: "not_found", Message: "Job 不存在"}
	reNS       = regexp.MustCompile(`^[A-Za-z0-9*][A-Za-z0-9_-]{0,127}$`)
	reJobID    = regexp.MustCompile(`^[^\x00-\x1f]{1,256}$`)
)

// Caller identifies who calls an operation (plans are bound to it).
type Caller struct {
	Actor     audit.Actor
	SessionID string
	IsAdmin   bool
}

func (s *Service) planTTL() time.Duration {
	if s.PlanTTL > 0 {
		return s.PlanTTL
	}
	return 15 * time.Minute
}

func (s *Service) store() *planStore {
	if s.plans == nil {
		s.plans = newPlanStore()
	}
	return s.plans
}

// Init prepares in-memory state (call once at startup).
func (s *Service) Init() { s.store() }

func validRef(namespace, jobID string) error {
	if !reNS.MatchString(namespace) || namespace == "*" {
		return badRequest("Namespace 不合法")
	}
	if !reJobID.MatchString(jobID) {
		return badRequest("Job ID 不合法")
	}
	return nil
}

func (s *Service) api(ctx context.Context, clusterID string) (*nomad.Client, error) {
	return s.Nomad.API(ctx, clusterID)
}

// nomadErr maps Nomad errors: index conflicts (Nomad answers 500 with an
// "enforcing ... index" message) become 409.
func nomadErr(err error) error {
	var ae *nomad.APIError
	if !errors.As(err, &ae) {
		return err
	}
	msg := strings.ToLower(ae.Message)
	switch {
	case strings.Contains(msg, "enforcing job modify index") || strings.Contains(msg, "conflicting job modify index") ||
		strings.Contains(msg, "enforcing version"):
		return conflict("index_conflict", "Job 已被他人修改（%s），请重新 Plan", ae.Message)
	case ae.Status == 404 || strings.Contains(msg, "not found"):
		return errNoJob
	case ae.Status == 400 || ae.Status == 409:
		return &auth.Error{Status: 400, Code: "nomad_rejected", Message: "Nomad 拒绝了请求：" + ae.Message}
	case ae.Status == 403:
		return &auth.Error{Status: 502, Code: "nomad_permission", Message: "托管的 Management Token 被拒绝：" + ae.Message}
	}
	return &auth.Error{Status: 502, Code: "nomad_error", Message: ae.Error()}
}

func q(namespace string) string { return "?namespace=" + url.QueryEscape(namespace) }

func jobPath(jobID string) string { return "job/" + url.PathEscape(jobID) }

// Job is a Nomad job document kept generic (numbers preserved).
type Job = map[string]any

func decodeJob(b []byte) (Job, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var j Job
	if err := dec.Decode(&j); err != nil {
		return nil, err
	}
	return j, nil
}

func canonical(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// request performs a call and decodes the response keeping numbers exact.
func request(ctx context.Context, c *nomad.Client, method, path string, in any, out any) error {
	var raw json.RawMessage
	if err := c.Request(ctx, method, path, in, &raw); err != nil {
		return err
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(out)
}

func getJob(ctx context.Context, c *nomad.Client, namespace, jobID string) (Job, error) {
	var j Job
	if err := request(ctx, c, http.MethodGet, jobPath(jobID)+q(namespace), nil, &j); err != nil {
		return nil, err
	}
	return j, nil
}

func u64(v any) uint64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		if n < 0 {
			return 0
		}
		return uint64(n)
	case float64:
		return uint64(x)
	case int:
		return uint64(x)
	case uint64:
		return x
	}
	return 0
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func sha(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ---- Listing ----

// JobStub is one row of the job list.
type JobStub struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Namespace      string         `json:"namespace"`
	Type           string         `json:"type"`
	Status         string         `json:"status"`
	Stop           bool           `json:"stop"`
	Periodic       bool           `json:"periodic"`
	Parameterized  bool           `json:"parameterized"`
	ParentID       string         `json:"parent_id,omitempty"`
	NodePool       string         `json:"node_pool"`
	Datacenters    []string       `json:"datacenters"`
	Priority       int            `json:"priority"`
	Allocations    map[string]int `json:"allocations"`
	Children       map[string]int `json:"children,omitempty"`
	JobModifyIndex uint64         `json:"job_modify_index"`
	SubmitTime     int64          `json:"submit_time"`
	Groups         []string       `json:"groups"`
}

// ListFilter filters the job list.
type ListFilter struct {
	Namespace string // "" or "*" = all
	Type      string
	Status    string
	NodePool  string
	Prefix    string
}

// List lists jobs with allocation counts per state.
func (s *Service) List(ctx context.Context, clusterID string, f ListFilter) ([]JobStub, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	ns := f.Namespace
	if ns == "" {
		ns = "*"
	}
	path := "jobs" + q(ns) + "&meta=false"
	if f.Prefix != "" {
		path += "&prefix=" + url.QueryEscape(f.Prefix)
	}
	var raw []map[string]any
	if err := request(ctx, c, http.MethodGet, path, nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	out := []JobStub{}
	for _, r := range raw {
		st := JobStub{ID: str(r["ID"]), Name: str(r["Name"]), Namespace: str(r["Namespace"]), Type: str(r["Type"]),
			Status: str(r["Status"]), ParentID: str(r["ParentID"]), NodePool: str(r["NodePool"]),
			Priority: int(u64(r["Priority"])), JobModifyIndex: u64(r["JobModifyIndex"]), SubmitTime: int64(u64(r["SubmitTime"])),
			Allocations: map[string]int{}, Datacenters: []string{}, Groups: []string{}}
		st.Stop, _ = r["Stop"].(bool)
		st.Periodic, _ = r["Periodic"].(bool)
		st.Parameterized, _ = r["ParameterizedJob"].(bool)
		for _, d := range list(r["Datacenters"]) {
			st.Datacenters = append(st.Datacenters, str(d))
		}
		if sum := obj(r["JobSummary"]); sum != nil {
			for tg, v := range obj(sum["Summary"]) {
				st.Groups = append(st.Groups, tg)
				for k, n := range obj(v) {
					st.Allocations[strings.ToLower(k)] += int(u64(n))
				}
			}
			if ch := obj(sum["Children"]); ch != nil {
				st.Children = map[string]int{}
				for k, n := range ch {
					st.Children[strings.ToLower(k)] = int(u64(n))
				}
			}
		}
		sort.Strings(st.Groups)
		if (f.Type == "" || f.Type == st.Type) && (f.Status == "" || f.Status == st.Status) && (f.NodePool == "" || f.NodePool == st.NodePool) {
			out = append(out, st)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// Detail is a job as returned to a caller: the safe summary always, the
// full definition only for admins.
type Detail struct {
	Summary        *Summary       `json:"summary"`
	Job            Job            `json:"job,omitempty"`
	Version        uint64         `json:"version"`
	JobModifyIndex uint64         `json:"job_modify_index"`
	Status         string         `json:"status"`
	Stop           bool           `json:"stop"`
	Archived       *RevisionView  `json:"archived,omitempty"`
	CountOverride  map[string]int `json:"count_overridden,omitempty"`
}

// Get returns a job. When Nomad no longer has it but a stop archive exists,
// the archive is reported so the job can be started again from it.
func (s *Service) Get(ctx context.Context, clusterID, namespace, jobID string, full bool) (*Detail, error) {
	if err := validRef(namespace, jobID); err != nil {
		return nil, err
	}
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	j, err := getJob(ctx, c, namespace, jobID)
	if err != nil {
		if errors.Is(nomadErr(err), errNoJob) {
			if rev := s.latestArchive(ctx, clusterID, namespace, jobID); rev != nil {
				v := revisionView(rev)
				return &Detail{Status: "purged", Stop: true, Archived: &v}, nil
			}
		}
		return nil, nomadErr(err)
	}
	d := &Detail{Summary: Summarize(j), Version: u64(j["Version"]), JobModifyIndex: u64(j["JobModifyIndex"]), Status: str(j["Status"])}
	d.Stop, _ = j["Stop"].(bool)
	if full {
		d.Job = j
	}
	if d.Stop {
		if rev := s.latestArchive(ctx, clusterID, namespace, jobID); rev != nil {
			v := revisionView(rev)
			d.Archived = &v
		}
	}
	return d, nil
}

func (s *Service) latestArchive(ctx context.Context, clusterID, namespace, jobID string) *db.JobRevision {
	revs, _ := db.ListRevisions(ctx, s.DB.Reader, clusterID, namespace, jobID)
	for _, r := range revs {
		if r.JobJSONEncrypted != "" && (r.SubmitStatus == db.RevConfirmed) {
			return r
		}
	}
	return nil
}

var _ = fmt.Sprintf
