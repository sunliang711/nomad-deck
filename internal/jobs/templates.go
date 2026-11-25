package jobs

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

var reTplName = regexp.MustCompile(`^[^\x00-\x1f]{1,128}$`)

// TemplateInput creates or updates a job template.
type TemplateInput struct {
	ClusterID       string          `json:"cluster_id"`
	Name            string          `json:"name"`
	JobID           string          `json:"job_id"`
	Namespace       string          `json:"namespace"`
	EditMode        string          `json:"edit_mode"`
	RendererVersion string          `json:"renderer_version"`
	FormSpec        json.RawMessage `json:"form_spec"`
	HCL             string          `json:"hcl"`
	SourceType      string          `json:"source_type"`
	Description     string          `json:"description"`
}

// TemplateView is a template.
type TemplateView struct {
	ID              string          `json:"id"`
	ClusterID       string          `json:"cluster_id,omitempty"`
	Name            string          `json:"name"`
	JobID           string          `json:"job_id"`
	Namespace       string          `json:"namespace"`
	EditMode        string          `json:"edit_mode"`
	RendererVersion string          `json:"renderer_version"`
	FormSpec        json.RawMessage `json:"form_spec,omitempty"`
	HCL             string          `json:"hcl"`
	HCLSHA256       string          `json:"hcl_sha256"`
	SourceType      string          `json:"source_type"`
	Description     string          `json:"description"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
}

func templateView(t *db.JobTemplate) TemplateView {
	v := TemplateView{ID: t.ID, ClusterID: t.ClusterID, Name: t.Name, JobID: t.JobID, Namespace: t.Namespace, EditMode: t.EditMode,
		RendererVersion: t.RendererVersion, HCL: t.HCLContent, HCLSHA256: t.HCLSHA256, SourceType: t.SourceType,
		Description: t.Description, CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt}
	if t.FormSpecJSON != "" {
		v.FormSpec = json.RawMessage(t.FormSpecJSON)
	}
	return v
}

// ListTemplates lists templates usable on a cluster ("" = all).
func (s *Service) ListTemplates(ctx context.Context, clusterID string) ([]TemplateView, error) {
	ts, err := db.ListTemplates(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	out := []TemplateView{}
	for _, t := range ts {
		out = append(out, templateView(t))
	}
	return out, nil
}

// GetTemplate returns one template.
func (s *Service) GetTemplate(ctx context.Context, id string) (*TemplateView, error) {
	t, err := db.GetTemplate(ctx, s.DB.Reader, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: "模板不存在"}
	}
	if err != nil {
		return nil, err
	}
	v := templateView(t)
	return &v, nil
}

// PutTemplate creates (empty id) or updates a template.
func (s *Service) PutTemplate(ctx context.Context, actor audit.Actor, id string, in TemplateInput) (*TemplateView, error) {
	if !reTplName.MatchString(in.Name) {
		return nil, badRequest("模板名称不合法")
	}
	if in.EditMode != "visual" && in.EditMode != "hcl" {
		return nil, badRequest("edit_mode 需为 visual 或 hcl")
	}
	switch in.SourceType {
	case "":
		in.SourceType = in.EditMode
	case "visual", "hcl", "compose", "imported":
	default:
		return nil, badRequest("source_type 不合法")
	}
	if strings.TrimSpace(in.HCL) == "" || len(in.HCL) > 1<<20 {
		return nil, badRequest("模板 HCL 为空或过大")
	}
	if in.Namespace == "" {
		in.Namespace = "default"
	}
	if in.ClusterID != "" {
		if c, err := db.GetCluster(ctx, s.DB.Reader, in.ClusterID); err != nil || c.Type != "nomad" {
			return nil, badRequest("cluster_id 需为 Nomad 集群")
		}
	}
	now := s.DB.Now()
	t := &db.JobTemplate{ID: id, ClusterID: in.ClusterID, Name: in.Name, JobID: in.JobID, Namespace: in.Namespace, EditMode: in.EditMode,
		RendererVersion: in.RendererVersion, HCLContent: in.HCL, HCLSHA256: sha([]byte(in.HCL)), SourceType: in.SourceType,
		Description: in.Description, CreatedAt: now, UpdatedAt: now}
	if len(in.FormSpec) > 0 && string(in.FormSpec) != "null" {
		t.FormSpecJSON = string(in.FormSpec)
	}
	if id == "" {
		t.ID = db.NewID()
	} else if old, err := db.GetTemplate(ctx, s.DB.Reader, id); err != nil {
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: "模板不存在"}
	} else {
		t.CreatedAt = old.CreatedAt
	}
	if err := db.UpsertTemplate(ctx, s.DB.Writer, t); err != nil {
		if errors.Is(err, db.ErrUnique) {
			return nil, conflict("name_taken", "模板名称已存在")
		}
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_template_put", ResourceType: "job_template",
		ResourceID: t.ID, ResourceName: t.Name, Summary: map[string]any{"create": id == "", "edit_mode": t.EditMode}})
	return s.GetTemplate(ctx, t.ID)
}

// DeleteTemplate removes a template.
func (s *Service) DeleteTemplate(ctx context.Context, actor audit.Actor, id string) error {
	t, err := db.GetTemplate(ctx, s.DB.Reader, id)
	if err != nil {
		return &auth.Error{Status: 404, Code: "not_found", Message: "模板不存在"}
	}
	if err := db.DeleteTemplate(ctx, s.DB.Writer, id); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_template_delete", ResourceType: "job_template",
		ResourceID: id, ResourceName: t.Name})
}

// ExportInput selects jobs to export.
type ExportInput struct {
	Namespace string   `json:"namespace"` // "" or "*" = all
	JobIDs    []string `json:"job_ids"`
}

func safeName(s string) string {
	return regexp.MustCompile(`[^A-Za-z0-9._-]`).ReplaceAllString(s, "_")
}

// Export writes a zip with one file per job: its HCL (Nomad submission or
// verified local archive) as <namespace>/<job>.nomad.hcl, or the Job JSON as
// <namespace>/<job>.nomad.json when no HCL exists.
func (s *Service) Export(ctx context.Context, actor audit.Actor, clusterID string, in ExportInput, w io.Writer) error {
	stubs, err := s.List(ctx, clusterID, ListFilter{Namespace: in.Namespace})
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, id := range in.JobIDs {
		want[id] = true
	}
	zw := zip.NewWriter(w)
	n := 0
	var missing []string
	for _, st := range stubs {
		if len(want) > 0 && !want[st.ID] || st.ParentID != "" {
			continue
		}
		d, err := s.DefinitionOf(ctx, clusterID, st.Namespace, st.ID, nil)
		if err != nil {
			missing = append(missing, st.Namespace+"/"+st.ID+": "+err.Error())
			continue
		}
		base := safeName(st.Namespace) + "/" + safeName(st.ID)
		var name string
		var body []byte
		if d.HCL != "" && d.Editable {
			name, body = base+".nomad.hcl", []byte(d.HCL)
		} else {
			name, body = base+".nomad.json", canonical(map[string]any{"Job": d.Job})
		}
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		if _, err := f.Write(body); err != nil {
			return err
		}
		n++
	}
	if len(missing) > 0 {
		f, _ := zw.Create("EXPORT_ERRORS.txt")
		_, _ = io.WriteString(f, strings.Join(missing, "\n")+"\n")
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad.job_export", ResourceType: "cluster", ResourceID: clusterID,
		Summary: map[string]any{"jobs": n, "namespace": in.Namespace, "errors": len(missing)}})
	if err := zw.Close(); err != nil {
		return fmt.Errorf("export: %w", err)
	}
	return nil
}
