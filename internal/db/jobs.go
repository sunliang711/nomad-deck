package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Revision submit states.
const (
	RevSubmitted   = "submitted"
	RevInDoubt     = "in_doubt"
	RevConfirmed   = "confirmed"
	RevFailed      = "failed"
	RevNeedsReview = "needs_review"
)

// JobRevision is one change of a Nomad job made through NomadDeck.
type JobRevision struct {
	ID                   string
	ClusterID            string
	Namespace            string
	JobID                string
	RevisionNo           int
	Source               string
	EditMode             string
	RendererVersion      string
	FormSpecJSON         string // "" when absent
	HCLContent           string // "" when absent
	HCLSHA256            string
	VariablesEncrypted   string
	JobJSONEncrypted     string
	OperationID          string
	BaseJobModifyIndex   uint64
	ResultJobModifyIndex uint64
	RemoteJobVersion     *uint64
	EvalID               string
	SubmitStatus         string
	PlanSummary          string
	CountOverriddenJSON  string
	SubmittedBy          string
	CreatedAt            time.Time
}

// AAD helpers for job revisions.
func JobVariablesAAD(id string) string { return "job_revisions.variables_encrypted:" + id }
func JobJSONAAD(id string) string      { return "job_revisions.job_json_encrypted:" + id }

func init() {
	EncryptedFields = append(EncryptedFields,
		EncryptedField{Name: "job_revisions.variables_encrypted", Query: `SELECT id, variables_encrypted FROM job_revisions WHERE variables_encrypted != ''`},
		EncryptedField{Name: "job_revisions.job_json_encrypted", Query: `SELECT id, job_json_encrypted FROM job_revisions WHERE job_json_encrypted != ''`},
	)
}

const revCols = `id, cluster_id, namespace, job_id, revision_no, source, edit_mode, renderer_version, COALESCE(form_spec_json, ''),
	COALESCE(hcl_content, ''), hcl_sha256, variables_encrypted, job_json_encrypted, operation_id, base_job_modify_index,
	result_job_modify_index, remote_job_version, eval_id, submit_status, plan_summary, COALESCE(count_overridden_json, ''),
	submitted_by, created_at`

func scanRevision(row interface{ Scan(...any) error }) (*JobRevision, error) {
	var r JobRevision
	var ver sql.NullInt64
	var base, result int64
	var created string
	err := row.Scan(&r.ID, &r.ClusterID, &r.Namespace, &r.JobID, &r.RevisionNo, &r.Source, &r.EditMode, &r.RendererVersion,
		&r.FormSpecJSON, &r.HCLContent, &r.HCLSHA256, &r.VariablesEncrypted, &r.JobJSONEncrypted, &r.OperationID, &base, &result,
		&ver, &r.EvalID, &r.SubmitStatus, &r.PlanSummary, &r.CountOverriddenJSON, &r.SubmittedBy, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.BaseJobModifyIndex, r.ResultJobModifyIndex = uint64(base), uint64(result)
	if ver.Valid {
		v := uint64(ver.Int64)
		r.RemoteJobVersion = &v
	}
	r.CreatedAt = ParseTime(created)
	return &r, nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullU64(v *uint64) any {
	if v == nil {
		return nil
	}
	return int64(*v)
}

// InsertRevision stores a revision with the next revision number of its
// job (the number is assigned inside the statement).
func InsertRevision(ctx context.Context, q Querier, r *JobRevision) error {
	err := q.QueryRowContext(ctx, `INSERT INTO job_revisions (id, cluster_id, namespace, job_id, revision_no, source, edit_mode,
		renderer_version, form_spec_json, hcl_content, hcl_sha256, variables_encrypted, job_json_encrypted, operation_id,
		base_job_modify_index, result_job_modify_index, remote_job_version, eval_id, submit_status, plan_summary,
		count_overridden_json, submitted_by, created_at)
		VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(revision_no), 0) + 1 FROM job_revisions WHERE cluster_id = ? AND namespace = ? AND job_id = ?),
		?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING revision_no`,
		r.ID, r.ClusterID, r.Namespace, r.JobID, r.ClusterID, r.Namespace, r.JobID, r.Source, r.EditMode, r.RendererVersion,
		nullStr(r.FormSpecJSON), nullStr(r.HCLContent), r.HCLSHA256, r.VariablesEncrypted, r.JobJSONEncrypted, r.OperationID,
		int64(r.BaseJobModifyIndex), int64(r.ResultJobModifyIndex), nullU64(r.RemoteJobVersion), r.EvalID, r.SubmitStatus,
		r.PlanSummary, nullStr(r.CountOverriddenJSON), r.SubmittedBy, FormatTime(r.CreatedAt)).Scan(&r.RevisionNo)
	return err
}

// ConfirmRevision records the Nomad response of a submission.
func ConfirmRevision(ctx context.Context, q Querier, id string, resultIndex uint64, version *uint64, evalID, status string) error {
	_, err := q.ExecContext(ctx, `UPDATE job_revisions SET result_job_modify_index = ?, remote_job_version = ?, eval_id = ?,
		submit_status = ? WHERE id = ?`, int64(resultIndex), nullU64(version), evalID, status, id)
	return err
}

// SetRevisionStatus changes the submit status only.
func SetRevisionStatus(ctx context.Context, q Querier, id, status string) error {
	_, err := q.ExecContext(ctx, `UPDATE job_revisions SET submit_status = ? WHERE id = ?`, status, id)
	return err
}

// UpdateRevisionSource rewrites the stored spec/HCL of a revision (count
// synchronisation after scaling).
func UpdateRevisionSource(ctx context.Context, q Querier, id, formSpec, hcl, hclSHA, countOverridden string) error {
	_, err := q.ExecContext(ctx, `UPDATE job_revisions SET form_spec_json = ?, hcl_content = ?, hcl_sha256 = ?,
		count_overridden_json = ? WHERE id = ?`, nullStr(formSpec), nullStr(hcl), hclSHA, nullStr(countOverridden), id)
	return err
}

// GetRevision loads one revision.
func GetRevision(ctx context.Context, q Querier, id string) (*JobRevision, error) {
	return scanRevision(q.QueryRowContext(ctx, `SELECT `+revCols+` FROM job_revisions WHERE id = ?`, id))
}

// ListRevisions lists the revisions of a job, newest first.
func ListRevisions(ctx context.Context, q Querier, clusterID, namespace, jobID string) ([]*JobRevision, error) {
	return queryRevisions(ctx, q, `WHERE cluster_id = ? AND namespace = ? AND job_id = ? ORDER BY revision_no DESC`, clusterID, namespace, jobID)
}

// ListRevisionsByStatus lists revisions in a submit state.
func ListRevisionsByStatus(ctx context.Context, q Querier, clusterID, status string) ([]*JobRevision, error) {
	return queryRevisions(ctx, q, `WHERE cluster_id = ? AND submit_status = ? ORDER BY created_at`, clusterID, status)
}

func queryRevisions(ctx context.Context, q Querier, where string, args ...any) ([]*JobRevision, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+revCols+` FROM job_revisions `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*JobRevision
	for rows.Next() {
		r, err := scanRevision(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// JobTemplate is a reusable job definition.
type JobTemplate struct {
	ID              string
	ClusterID       string // "" for templates usable on every cluster
	Name            string
	JobID           string
	Namespace       string
	EditMode        string
	RendererVersion string
	FormSpecJSON    string
	HCLContent      string
	HCLSHA256       string
	SourceType      string
	Description     string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const tplCols = `id, COALESCE(cluster_id, ''), name, job_id, namespace, edit_mode, renderer_version, COALESCE(form_spec_json, ''),
	hcl_content, hcl_sha256, source_type, description, created_at, updated_at`

func scanTemplate(row interface{ Scan(...any) error }) (*JobTemplate, error) {
	var t JobTemplate
	var created, updated string
	err := row.Scan(&t.ID, &t.ClusterID, &t.Name, &t.JobID, &t.Namespace, &t.EditMode, &t.RendererVersion, &t.FormSpecJSON,
		&t.HCLContent, &t.HCLSHA256, &t.SourceType, &t.Description, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt, t.UpdatedAt = ParseTime(created), ParseTime(updated)
	return &t, nil
}

// UpsertTemplate inserts or updates a template by ID.
func UpsertTemplate(ctx context.Context, q Querier, t *JobTemplate) error {
	_, err := q.ExecContext(ctx, `INSERT INTO job_templates (id, cluster_id, name, job_id, namespace, edit_mode, renderer_version,
		form_spec_json, hcl_content, hcl_sha256, source_type, description, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET cluster_id = excluded.cluster_id, name = excluded.name, job_id = excluded.job_id,
		namespace = excluded.namespace, edit_mode = excluded.edit_mode, renderer_version = excluded.renderer_version,
		form_spec_json = excluded.form_spec_json, hcl_content = excluded.hcl_content, hcl_sha256 = excluded.hcl_sha256,
		source_type = excluded.source_type, description = excluded.description, updated_at = excluded.updated_at`,
		t.ID, nullStr(t.ClusterID), t.Name, t.JobID, orStr(t.Namespace, "default"), t.EditMode, t.RendererVersion,
		nullStr(t.FormSpecJSON), t.HCLContent, t.HCLSHA256, t.SourceType, t.Description, FormatTime(t.CreatedAt), FormatTime(t.UpdatedAt))
	return mapUnique(err)
}

// GetTemplate loads one template.
func GetTemplate(ctx context.Context, q Querier, id string) (*JobTemplate, error) {
	return scanTemplate(q.QueryRowContext(ctx, `SELECT `+tplCols+` FROM job_templates WHERE id = ?`, id))
}

// ListTemplates lists templates usable on a cluster ("" = all).
func ListTemplates(ctx context.Context, q Querier, clusterID string) ([]*JobTemplate, error) {
	query := `SELECT ` + tplCols + ` FROM job_templates`
	var args []any
	if clusterID != "" {
		query += ` WHERE cluster_id IS NULL OR cluster_id = ?`
		args = append(args, clusterID)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*JobTemplate
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteTemplate removes a template.
func DeleteTemplate(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM job_templates WHERE id = ?`, id)
	return err
}
