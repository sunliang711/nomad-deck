package db

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Unseal key generation states.
const (
	GenPendingVerification = "pending_verification"
	GenVerificationInDoubt = "verification_in_doubt"
	GenActive              = "active"
	GenRetired             = "retired"
	GenAbandoned           = "abandoned"
)

// VaultCustody is the custody record of a Vault cluster.
type VaultCustody struct {
	ClusterID                   string
	Initialized                 bool
	KeyShares                   int
	KeyThreshold                int
	SealGeneration              int
	BootstrapRootTokenEncrypted string
	AdminTokenEncrypted         string
	AdminTokenExpiresAt         time.Time
	AutoUnsealByDeck            bool
	UnsealSuppressedReason      string
	InitializedAt               time.Time
	LastUnsealedAt              time.Time
	UpdatedAt                   time.Time
}

const custodyCols = `cluster_id, initialized, key_shares, key_threshold, seal_generation, bootstrap_root_token_encrypted,
	admin_token_encrypted, COALESCE(admin_token_expires_at, ''), auto_unseal_by_deck, unseal_suppressed_reason,
	COALESCE(initialized_at, ''), COALESCE(last_unsealed_at, ''), updated_at`

func scanCustody(row interface{ Scan(...any) error }) (*VaultCustody, error) {
	var c VaultCustody
	var init, auto int
	var exp, initAt, unsealAt, updated string
	err := row.Scan(&c.ClusterID, &init, &c.KeyShares, &c.KeyThreshold, &c.SealGeneration, &c.BootstrapRootTokenEncrypted,
		&c.AdminTokenEncrypted, &exp, &auto, &c.UnsealSuppressedReason, &initAt, &unsealAt, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.Initialized, c.AutoUnsealByDeck = init == 1, auto == 1
	c.AdminTokenExpiresAt, c.InitializedAt, c.LastUnsealedAt = ParseTime(exp), ParseTime(initAt), ParseTime(unsealAt)
	c.UpdatedAt = ParseTime(updated)
	return &c, nil
}

// InsertCustody creates the custody record of a Vault cluster.
func InsertCustody(ctx context.Context, q Querier, c *VaultCustody) error {
	_, err := q.ExecContext(ctx, `INSERT INTO vault_secrets_custody (cluster_id, key_shares, key_threshold, auto_unseal_by_deck,
		updated_at) VALUES (?, ?, ?, ?, ?)`, c.ClusterID, c.KeyShares, c.KeyThreshold, boolInt(c.AutoUnsealByDeck), FormatTime(c.UpdatedAt))
	return err
}

// GetCustody loads the custody record.
func GetCustody(ctx context.Context, q Querier, clusterID string) (*VaultCustody, error) {
	return scanCustody(q.QueryRowContext(ctx, `SELECT `+custodyCols+` FROM vault_secrets_custody WHERE cluster_id = ?`, clusterID))
}

// SaveCustody writes every mutable custody field.
func SaveCustody(ctx context.Context, q Querier, c *VaultCustody, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE vault_secrets_custody SET initialized = ?, key_shares = ?, key_threshold = ?,
		seal_generation = ?, bootstrap_root_token_encrypted = ?, admin_token_encrypted = ?, admin_token_expires_at = ?,
		auto_unseal_by_deck = ?, unseal_suppressed_reason = ?, initialized_at = ?, last_unsealed_at = ?, updated_at = ?
		WHERE cluster_id = ?`,
		boolInt(c.Initialized), c.KeyShares, c.KeyThreshold, c.SealGeneration, c.BootstrapRootTokenEncrypted,
		c.AdminTokenEncrypted, nullTime(c.AdminTokenExpiresAt), boolInt(c.AutoUnsealByDeck), c.UnsealSuppressedReason,
		nullTime(c.InitializedAt), nullTime(c.LastUnsealedAt), FormatTime(now), c.ClusterID)
	return err
}

// KeyGeneration is one generation of unseal keys.
type KeyGeneration struct {
	ClusterID              string
	Generation             int
	KeyShares              int
	KeyThreshold           int
	UnsealKeysEncrypted    string
	RekeyVerificationNonce string
	State                  string
	CreatedAt              time.Time
	ActivatedAt            time.Time
	RetiredAt              time.Time
}

const genCols = `cluster_id, generation, key_shares, key_threshold, unseal_keys_encrypted, rekey_verification_nonce, state,
	created_at, COALESCE(activated_at, ''), COALESCE(retired_at, '')`

func scanGen(row interface{ Scan(...any) error }) (*KeyGeneration, error) {
	var g KeyGeneration
	var created, activated, retired string
	err := row.Scan(&g.ClusterID, &g.Generation, &g.KeyShares, &g.KeyThreshold, &g.UnsealKeysEncrypted,
		&g.RekeyVerificationNonce, &g.State, &created, &activated, &retired)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	g.CreatedAt, g.ActivatedAt, g.RetiredAt = ParseTime(created), ParseTime(activated), ParseTime(retired)
	return &g, nil
}

// InsertKeyGeneration stores a new generation.
func InsertKeyGeneration(ctx context.Context, q Querier, g *KeyGeneration) error {
	_, err := q.ExecContext(ctx, `INSERT INTO vault_unseal_key_generations (cluster_id, generation, key_shares, key_threshold,
		unseal_keys_encrypted, rekey_verification_nonce, state, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		g.ClusterID, g.Generation, g.KeyShares, g.KeyThreshold, g.UnsealKeysEncrypted, g.RekeyVerificationNonce, g.State,
		FormatTime(g.CreatedAt), nullTime(g.ActivatedAt))
	return mapUnique(err)
}

// GetKeyGeneration loads one generation.
func GetKeyGeneration(ctx context.Context, q Querier, clusterID string, gen int) (*KeyGeneration, error) {
	return scanGen(q.QueryRowContext(ctx, `SELECT `+genCols+` FROM vault_unseal_key_generations WHERE cluster_id = ? AND generation = ?`,
		clusterID, gen))
}

// ListKeyGenerations lists all generations of a cluster, newest first.
func ListKeyGenerations(ctx context.Context, q Querier, clusterID string) ([]*KeyGeneration, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+genCols+` FROM vault_unseal_key_generations WHERE cluster_id = ? ORDER BY generation DESC`, clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*KeyGeneration
	for rows.Next() {
		g, err := scanGen(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// MaxKeyGeneration returns the highest generation number ever used (0 if none).
func MaxKeyGeneration(ctx context.Context, q Querier, clusterID string) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(generation), 0) FROM vault_unseal_key_generations WHERE cluster_id = ?`, clusterID).Scan(&n)
	return n, err
}

// SetKeyGenerationState updates state and verification nonce.
func SetKeyGenerationState(ctx context.Context, q Querier, clusterID string, gen int, state, nonce string, now time.Time) error {
	var activated, retired any
	switch state {
	case GenActive:
		activated = FormatTime(now)
	case GenRetired:
		retired = FormatTime(now)
	}
	if state == GenActive || state == GenAbandoned || state == GenRetired {
		nonce = ""
	}
	_, err := q.ExecContext(ctx, `UPDATE vault_unseal_key_generations SET state = ?, rekey_verification_nonce = ?,
		activated_at = COALESCE(?, activated_at), retired_at = COALESCE(?, retired_at) WHERE cluster_id = ? AND generation = ?`,
		state, nonce, activated, retired, clusterID, gen)
	return err
}

// ActivateGeneration makes gen the active generation and retires the
// previous active one. Callers run it inside a transaction together with
// the custody pointer update.
func ActivateGeneration(ctx context.Context, q Querier, clusterID string, gen int, now time.Time) error {
	if _, err := q.ExecContext(ctx, `UPDATE vault_unseal_key_generations SET state = ?, retired_at = ?
		WHERE cluster_id = ? AND state = ? AND generation != ?`, GenRetired, FormatTime(now), clusterID, GenActive, gen); err != nil {
		return err
	}
	if err := SetKeyGenerationState(ctx, q, clusterID, gen, GenActive, "", now); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE vault_secrets_custody SET seal_generation = ?, updated_at = ? WHERE cluster_id = ?`,
		gen, FormatTime(now), clusterID)
	return err
}

// Snapshot is a stored encrypted Raft snapshot.
type Snapshot struct {
	ID                   string
	ClusterID            string
	ClusterType          string
	ProductVersion       string
	SealGeneration       *int
	CredentialGeneration string
	FilePath             string
	SizeBytes            int64
	SHA256               string
	TriggerType          string
	TriggeredBy          string
	CreatedAt            time.Time
}

const snapCols = `id, cluster_id, cluster_type, product_version, seal_generation, credential_generation, file_path, size_bytes,
	sha256, trigger_type, triggered_by, created_at`

func scanSnapshot(row interface{ Scan(...any) error }) (*Snapshot, error) {
	var s Snapshot
	var gen sql.NullInt64
	var created string
	err := row.Scan(&s.ID, &s.ClusterID, &s.ClusterType, &s.ProductVersion, &gen, &s.CredentialGeneration, &s.FilePath,
		&s.SizeBytes, &s.SHA256, &s.TriggerType, &s.TriggeredBy, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if gen.Valid {
		g := int(gen.Int64)
		s.SealGeneration = &g
	}
	s.CreatedAt = ParseTime(created)
	return &s, nil
}

// InsertSnapshot records a snapshot.
func InsertSnapshot(ctx context.Context, q Querier, s *Snapshot) error {
	var gen any
	if s.SealGeneration != nil {
		gen = *s.SealGeneration
	}
	_, err := q.ExecContext(ctx, `INSERT INTO cluster_snapshots (id, cluster_id, cluster_type, product_version, seal_generation,
		credential_generation, file_path, size_bytes, sha256, trigger_type, triggered_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.ClusterID, s.ClusterType, s.ProductVersion, gen, s.CredentialGeneration, s.FilePath, s.SizeBytes, s.SHA256,
		s.TriggerType, s.TriggeredBy, FormatTime(s.CreatedAt))
	return err
}

// GetSnapshot loads one snapshot.
func GetSnapshot(ctx context.Context, q Querier, id string) (*Snapshot, error) {
	return scanSnapshot(q.QueryRowContext(ctx, `SELECT `+snapCols+` FROM cluster_snapshots WHERE id = ?`, id))
}

// ListSnapshots lists a cluster's snapshots, newest first.
func ListSnapshots(ctx context.Context, q Querier, clusterID string) ([]*Snapshot, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+snapCols+` FROM cluster_snapshots WHERE cluster_id = ? ORDER BY created_at DESC`, clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Snapshot
	for rows.Next() {
		s, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeleteSnapshot removes a snapshot record.
func DeleteSnapshot(ctx context.Context, q Querier, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM cluster_snapshots WHERE id = ?`, id)
	return err
}

// ListAllSnapshots returns all recorded snapshots across clusters, newest first.
func ListAllSnapshots(ctx context.Context, q Querier) ([]*Snapshot, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+snapCols+` FROM cluster_snapshots ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Snapshot
	for rows.Next() {
		s, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListAllCustody returns all Vault custody records.
func ListAllCustody(ctx context.Context, q Querier) ([]*VaultCustody, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+custodyCols+` FROM vault_secrets_custody`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*VaultCustody
	for rows.Next() {
		c, err := scanCustody(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
