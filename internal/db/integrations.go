package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Integration is a cluster integration (Nomad -> Vault JWT).
type Integration struct {
	ID                string
	Name              string
	Type              string
	SourceClusterID   string
	TargetClusterID   string
	AuthPath          string
	ConfigJSON        string
	NomadConfigSHA256 string
	NomadSideEnabled  bool
	Status            string
	LastDoctorJSON    string
	LastAppliedAt     time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

const integrationCols = `id, name, integration_type, source_cluster_id, target_cluster_id, auth_path, config_json,
	nomad_config_sha256, nomad_side_enabled, status, last_doctor_json, COALESCE(last_applied_at, ''), created_at, updated_at`

func scanIntegration(row interface{ Scan(...any) error }) (*Integration, error) {
	var i Integration
	var enabled int
	var applied, created, updated string
	err := row.Scan(&i.ID, &i.Name, &i.Type, &i.SourceClusterID, &i.TargetClusterID, &i.AuthPath, &i.ConfigJSON,
		&i.NomadConfigSHA256, &enabled, &i.Status, &i.LastDoctorJSON, &applied, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	i.NomadSideEnabled = enabled == 1
	i.LastAppliedAt, i.CreatedAt, i.UpdatedAt = ParseTime(applied), ParseTime(created), ParseTime(updated)
	return &i, nil
}

// InsertIntegration stores a new integration.
func InsertIntegration(ctx context.Context, q Querier, i *Integration) error {
	_, err := q.ExecContext(ctx, `INSERT INTO cluster_integrations (id, name, integration_type, source_cluster_id, target_cluster_id,
		auth_path, config_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		i.ID, i.Name, i.Type, i.SourceClusterID, i.TargetClusterID, i.AuthPath, orJSON(i.ConfigJSON, "{}"), orStr(i.Status, "draft"),
		FormatTime(i.CreatedAt), FormatTime(i.UpdatedAt))
	return mapUnique(err)
}

// GetIntegration loads one integration.
func GetIntegration(ctx context.Context, q Querier, id string) (*Integration, error) {
	return scanIntegration(q.QueryRowContext(ctx, `SELECT `+integrationCols+` FROM cluster_integrations WHERE id = ?`, id))
}

// ListIntegrations lists integrations, optionally those touching a cluster.
func ListIntegrations(ctx context.Context, q Querier, clusterID string) ([]*Integration, error) {
	query := `SELECT ` + integrationCols + ` FROM cluster_integrations`
	var args []any
	if clusterID != "" {
		query += ` WHERE source_cluster_id = ? OR target_cluster_id = ?`
		args = append(args, clusterID, clusterID)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Integration
	for rows.Next() {
		i, err := scanIntegration(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// UpdateIntegrationConfig stores editable fields.
func UpdateIntegrationConfig(ctx context.Context, q Querier, i *Integration, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cluster_integrations SET name = ?, config_json = ?, updated_at = ? WHERE id = ?`,
		i.Name, orJSON(i.ConfigJSON, "{}"), FormatTime(now), i.ID)
	return mapUnique(err)
}

// UpdateIntegrationState stores the apply outcome.
func UpdateIntegrationState(ctx context.Context, q Querier, i *Integration, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cluster_integrations SET status = ?, nomad_config_sha256 = ?, nomad_side_enabled = ?,
		last_applied_at = ?, updated_at = ? WHERE id = ?`,
		i.Status, i.NomadConfigSHA256, boolInt(i.NomadSideEnabled), nullTime(i.LastAppliedAt), FormatTime(now), i.ID)
	return err
}

// SetIntegrationDoctor stores the last Doctor result.
func SetIntegrationDoctor(ctx context.Context, q Querier, id, js string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE cluster_integrations SET last_doctor_json = ?, updated_at = ? WHERE id = ?`, js, FormatTime(now), id)
	return err
}

// DeleteIntegration removes an integration and its roles.
func DeleteIntegration(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM cluster_integrations WHERE id = ?`, id)
	return err
}

// IntegrationRole is a workload role of an integration.
type IntegrationRole struct {
	ID              string
	IntegrationID   string
	RoleName        string
	PolicyName      string
	PolicyMode      string
	SecretPathsJSON string
	CustomPolicyHCL string
	BoundClaimsJSON string
	TokenPeriod     string
	Status          string
	LastAppliedAt   time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const roleCols = `id, integration_id, role_name, policy_name, policy_mode, secret_paths_json, custom_policy_hcl, bound_claims_json,
	token_period, status, COALESCE(last_applied_at, ''), created_at, updated_at`

func scanRole(row interface{ Scan(...any) error }) (*IntegrationRole, error) {
	var r IntegrationRole
	var applied, created, updated string
	err := row.Scan(&r.ID, &r.IntegrationID, &r.RoleName, &r.PolicyName, &r.PolicyMode, &r.SecretPathsJSON, &r.CustomPolicyHCL,
		&r.BoundClaimsJSON, &r.TokenPeriod, &r.Status, &applied, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.LastAppliedAt, r.CreatedAt, r.UpdatedAt = ParseTime(applied), ParseTime(created), ParseTime(updated)
	return &r, nil
}

// UpsertRole inserts or updates a role (by ID).
func UpsertRole(ctx context.Context, q Querier, r *IntegrationRole, now time.Time) error {
	_, err := q.ExecContext(ctx, `INSERT INTO integration_roles (id, integration_id, role_name, policy_name, policy_mode, secret_paths_json,
		custom_policy_hcl, bound_claims_json, token_period, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET role_name = excluded.role_name, policy_name = excluded.policy_name, policy_mode = excluded.policy_mode,
		secret_paths_json = excluded.secret_paths_json, custom_policy_hcl = excluded.custom_policy_hcl,
		bound_claims_json = excluded.bound_claims_json, token_period = excluded.token_period, status = excluded.status,
		updated_at = excluded.updated_at`,
		r.ID, r.IntegrationID, r.RoleName, r.PolicyName, r.PolicyMode, orJSON(r.SecretPathsJSON, "[]"), r.CustomPolicyHCL,
		orJSON(r.BoundClaimsJSON, "{}"), orStr(r.TokenPeriod, "1h"), orStr(r.Status, "draft"), FormatTime(now), FormatTime(now))
	return mapUnique(err)
}

// ListRoles lists the roles of an integration.
func ListRoles(ctx context.Context, q Querier, integrationID string) ([]*IntegrationRole, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+roleCols+` FROM integration_roles WHERE integration_id = ? ORDER BY role_name`, integrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*IntegrationRole
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRole loads one role.
func GetRole(ctx context.Context, q Querier, id string) (*IntegrationRole, error) {
	return scanRole(q.QueryRowContext(ctx, `SELECT `+roleCols+` FROM integration_roles WHERE id = ?`, id))
}

// SetRoleStatus records a role's apply outcome.
func SetRoleStatus(ctx context.Context, q Querier, id, status string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE integration_roles SET status = ?, last_applied_at = CASE WHEN ? = 'applied' THEN ? ELSE last_applied_at END,
		updated_at = ? WHERE id = ?`, status, status, FormatTime(now), FormatTime(now), id)
	return err
}

// DeleteRole removes a role.
func DeleteRole(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM integration_roles WHERE id = ?`, id)
	return err
}
