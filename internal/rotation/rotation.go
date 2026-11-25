// Package rotation implements resumable two-key master-key rotation across
// database secrets, encrypted Raft snapshot headers and pre-upgrade DB backups.
package rotation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/snapstore"
)

// Service orchestrates master-key rotation.
type Service struct {
	DB      *db.DB
	Keys    *crypto.Keyring
	Audit   *audit.Recorder
	Ops     *ops.Engine
	DataDir string
	Log     *slog.Logger

	running atomic.Bool
	mu      sync.Mutex
}

// Progress tracks items re-encrypted and verified during a rotation run.
type Progress struct {
	DBFields        map[string]int `json:"db_fields"`
	LastDBPos       string         `json:"last_db_pos,omitempty"`
	SnapshotsDone   int            `json:"snapshots_done"`
	SnapshotsTotal  int            `json:"snapshots_total"`
	LastSnapshot    string         `json:"last_snapshot,omitempty"`
	BackupsDone     int            `json:"backups_done"`
	BackupsTotal    int            `json:"backups_total"`
	LastBackup      string         `json:"last_backup,omitempty"`
	VerifiedClean   bool           `json:"verified_clean"`
	ReencryptedRows int            `json:"reencrypted_rows"`
}

// JournalView is the API view of a key_rotation_journal row.
type JournalView struct {
	ID           string     `json:"id"`
	OldKeyID     string     `json:"old_key_id"`
	NewKeyID     string     `json:"new_key_id"`
	State        string     `json:"state"`
	Progress     Progress   `json:"progress"`
	StartedBy    string     `json:"started_by"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	ErrorMessage string     `json:"error_message,omitempty"`
}

// StatusView summarizes loaded master keys and rotation status.
type StatusView struct {
	PrimaryKeyID  string       `json:"primary_key_id"`
	PrimarySource string       `json:"primary_source"`
	NextKeyID     string       `json:"next_key_id,omitempty"`
	NextSource    string       `json:"next_source,omitempty"`
	ActiveKeyID   string       `json:"active_key_id"`
	RotationReady bool         `json:"rotation_ready"`
	Running       bool         `json:"running"`
	Journal       *JournalView `json:"journal,omitempty"`
	NextSteps     string       `json:"next_steps,omitempty"`
}

// IsRunning reports whether a master-key rotation is currently executing.
func (s *Service) IsRunning() bool { return s.running.Load() }

// Status returns the current keyring state and the latest rotation journal.
func (s *Service) Status(ctx context.Context) (*StatusView, error) {
	primary := s.Keys.Primary()
	next := s.Keys.Next()
	st := &StatusView{
		PrimaryKeyID:  primary.ID,
		PrimarySource: primary.Source,
		ActiveKeyID:   s.Keys.Active().ID,
		RotationReady: next != nil,
		Running:       s.IsRunning(),
	}
	if next != nil {
		st.NextKeyID = next.ID
		st.NextSource = next.Source
	}
	j, err := db.GetLatestKeyRotation(ctx, s.DB.Reader)
	if err == nil {
		jv := toJournalView(j)
		st.Journal = &jv
		if j.State == "completed" && next != nil && j.NewKeyID == next.ID {
			st.NextSteps = "全部密文已核验完成，请将新主密钥配置为主密钥（master_key / NOMAD_DECK_MASTER_KEY / master.key）、移除旧密钥并重启控制面服务。"
		}
	} else if !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	if st.NextSteps == "" && next == nil {
		st.NextSteps = "如需轮换主密钥，请在主密钥来源中新增 master_key_next（或 NOMAD_DECK_MASTER_KEY_NEXT / master.key.next）并重启服务后发起轮换。"
	}
	return st, nil
}

func toJournalView(j *db.KeyRotationJournal) JournalView {
	var p Progress
	_ = json.Unmarshal([]byte(j.ProgressJSON), &p)
	if p.DBFields == nil {
		p.DBFields = map[string]int{}
	}
	jv := JournalView{
		ID: j.ID, OldKeyID: j.OldKeyID, NewKeyID: j.NewKeyID, State: j.State,
		Progress: p, StartedBy: j.StartedBy, StartedAt: j.StartedAt, ErrorMessage: j.ErrorMessage,
	}
	if !j.FinishedAt.IsZero() {
		fin := j.FinishedAt
		jv.FinishedAt = &fin
	}
	return jv
}

// Start begins master-key rotation asynchronously and returns the journal view.
func (s *Service) Start(ctx context.Context, actor audit.Actor) (*JournalView, error) {
	j, prog, err := s.prepare(ctx, actor)
	if err != nil {
		return nil, err
	}
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		defer cancel()
		s.execute(rctx, actor, j, prog)
	}()
	jv := toJournalView(j)
	return &jv, nil
}

// RunSync runs master-key rotation synchronously (used in tests).
func (s *Service) RunSync(ctx context.Context, actor audit.Actor) (*JournalView, error) {
	j, prog, err := s.prepare(ctx, actor)
	if err != nil {
		return nil, err
	}
	err = s.execute(ctx, actor, j, prog)
	jv := toJournalView(j)
	return &jv, err
}

func (s *Service) prepare(ctx context.Context, actor audit.Actor) (*db.KeyRotationJournal, *Progress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.Keys.Next() == nil {
		return nil, nil, &auth.Error{Status: 409, Code: "no_next_key", Message: "尚未加载待轮换的新主密钥（master_key_next）"}
	}
	if s.Ops != nil {
		if reason := s.Ops.Barrier(); reason != "" {
			return nil, nil, &auth.Error{Status: 409, Code: "maintenance_active", Message: "控制面处于全局维护状态（" + reason + "），暂不可发起主密钥轮换"}
		}
	}
	if !s.running.CompareAndSwap(false, true) {
		return nil, nil, &auth.Error{Status: 409, Code: "rotation_running", Message: "主密钥轮换正在进行中"}
	}

	oldID := s.Keys.Primary().ID
	newID := s.Keys.Next().ID
	var j *db.KeyRotationJournal
	existing, err := db.GetActiveKeyRotation(ctx, s.DB.Reader, oldID, newID)
	if err == nil {
		j = existing
		j.State = "running"
		j.ErrorMessage = ""
		j.FinishedAt = time.Time{}
		if err := db.UpdateKeyRotation(ctx, s.DB.Writer, j); err != nil {
			s.running.Store(false)
			return nil, nil, err
		}
	} else if errors.Is(err, db.ErrNotFound) {
		j = &db.KeyRotationJournal{
			ID:           db.NewID(),
			OldKeyID:     oldID,
			NewKeyID:     newID,
			State:        "running",
			ProgressJSON: `{"db_fields":{}}`,
			StartedBy:    actor.Name,
			StartedAt:    s.DB.Now(),
		}
		if err := db.InsertKeyRotation(ctx, s.DB.Writer, j); err != nil {
			s.running.Store(false)
			return nil, nil, err
		}
	} else {
		s.running.Store(false)
		return nil, nil, err
	}

	var prog Progress
	_ = json.Unmarshal([]byte(j.ProgressJSON), &prog)
	if prog.DBFields == nil {
		prog.DBFields = map[string]int{}
	}
	return j, &prog, nil
}

func (s *Service) saveJournal(ctx context.Context, j *db.KeyRotationJournal, prog *Progress) {
	b, _ := json.Marshal(prog)
	j.ProgressJSON = string(b)
	_ = db.UpdateKeyRotation(ctx, s.DB.Writer, j)
}

func (s *Service) execute(ctx context.Context, actor audit.Actor, j *db.KeyRotationJournal, prog *Progress) error {
	defer s.running.Store(false)
	newKeyID := s.Keys.Next().ID

	fail := func(err error) error {
		j.State = "failed"
		j.ErrorMessage = err.Error()
		j.FinishedAt = s.DB.Now()
		s.saveJournal(ctx, j, prog)
		_ = s.Audit.Record(ctx, nil, audit.Event{
			Actor: actor, Action: "system.master_key_rotate", ResourceType: "settings", ResourceName: "master_key",
			Summary: map[string]any{"journal_id": j.ID, "old_key_id": j.OldKeyID, "new_key_id": j.NewKeyID}, Err: err,
		})
		return err
	}

	// Phase 1: Re-encrypt all database secret columns on main DB.
	if err := s.rotateDB(ctx, s.DB.Writer, newKeyID, prog, func() { s.saveJournal(ctx, j, prog) }); err != nil {
		return fail(fmt.Errorf("重加密数据库字段失败：%w", err))
	}

	// Phase 2: Rewrap encrypted Raft snapshot headers under per-cluster exclusive snapshot locks.
	snaps, err := db.ListAllSnapshots(ctx, s.DB.Reader)
	if err != nil {
		return fail(err)
	}
	prog.SnapshotsTotal = len(snaps)
	prog.SnapshotsDone = 0
	for _, sn := range snaps {
		if _, err := os.Stat(sn.FilePath); errors.Is(err, os.ErrNotExist) {
			prog.SnapshotsDone++
			continue
		}
		var release func()
		if s.Ops != nil {
			lctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
			r, lerr := s.Ops.Locks.Acquire(lctx, []ops.LockReq{{Key: ops.SnapshotLock(sn.ClusterID), Mode: ops.Exclusive}})
			cancel()
			if lerr != nil {
				return fail(fmt.Errorf("获取快照 %s 锁失败：%w", sn.ID, lerr))
			}
			release = r
		}
		_, rerr := snapstore.Rewrap(s.Keys, sn.FilePath, sn.ID)
		if release != nil {
			release()
		}
		if rerr != nil {
			return fail(fmt.Errorf("重包裹快照 %s 失败：%w", sn.ID, rerr))
		}
		prog.SnapshotsDone++
		prog.LastSnapshot = sn.ID
		s.saveJournal(ctx, j, prog)
	}

	// Phase 3: Re-encrypt pre-upgrade database backups.
	backupFiles, _ := filepath.Glob(filepath.Join(s.DataDir, "backups", "pre-upgrade-*.db"))
	sort.Strings(backupFiles)
	prog.BackupsTotal = len(backupFiles)
	prog.BackupsDone = 0
	for _, bf := range backupFiles {
		if err := s.rotatePreUpgradeDB(ctx, bf, newKeyID); err != nil {
			return fail(fmt.Errorf("重加密升级前备份 %s 失败：%w", filepath.Base(bf), err))
		}
		prog.BackupsDone++
		prog.LastBackup = filepath.Base(bf)
		s.saveJournal(ctx, j, prog)
	}

	// Phase 4: Full verification across DB, snapshots and pre-upgrade DBs.
	j.State = "verifying"
	s.saveJournal(ctx, j, prog)
	isNew := func(id string) bool { return id == newKeyID }

	problems, err := db.CheckKeyIDs(ctx, s.DB.Reader, crypto.KeyIDOf, isNew)
	if err != nil {
		return fail(err)
	}
	if len(problems) > 0 {
		return fail(fmt.Errorf("数据库仍有未完成轮换的密文：%s", db.FormatProblems(problems)))
	}
	for _, sn := range snaps {
		if _, err := os.Stat(sn.FilePath); errors.Is(err, os.ErrNotExist) {
			continue
		}
		kid, err := snapstore.HeaderKeyID(sn.FilePath)
		if err != nil || kid != newKeyID {
			return fail(fmt.Errorf("快照 %s 头密钥校验失败（key_id=%s，err=%v）", sn.ID, kid, err))
		}
	}
	for _, bf := range backupFiles {
		if err := s.verifyPreUpgradeDB(ctx, bf, newKeyID); err != nil {
			return fail(fmt.Errorf("升级前备份 %s 核验失败：%w", filepath.Base(bf), err))
		}
	}

	prog.VerifiedClean = true
	j.State = "completed"
	j.FinishedAt = s.DB.Now()
	s.saveJournal(ctx, j, prog)
	_ = s.Audit.Record(ctx, nil, audit.Event{
		Actor: actor, Action: "system.master_key_rotate", ResourceType: "settings", ResourceName: "master_key",
		Summary: map[string]any{
			"journal_id": j.ID, "old_key_id": j.OldKeyID, "new_key_id": j.NewKeyID,
			"reencrypted_rows": prog.ReencryptedRows, "snapshots": prog.SnapshotsDone, "backups": prog.BackupsDone,
		},
	})
	return nil
}

func (s *Service) openSQLiteRW(path string) (*sql.DB, error) {
	q := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "foreign_keys(1)"} {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", "immediate")
	d, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1)
	return d, nil
}

func (s *Service) rotatePreUpgradeDB(ctx context.Context, path, newKeyID string) error {
	d, err := s.openSQLiteRW(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return s.rotateDB(ctx, d, newKeyID, nil, nil)
}

func (s *Service) verifyPreUpgradeDB(ctx context.Context, path, newKeyID string) error {
	d, err := s.openSQLiteRW(path)
	if err != nil {
		return err
	}
	defer d.Close()
	isNew := func(id string) bool { return id == newKeyID }
	for _, f := range db.EncryptedFields {
		table, col := tableAndColFromFieldName(f.Name)
		if ok, err := tableExists(ctx, d, table); err != nil || !ok {
			continue
		}
		if col != "" {
			if ok, err := columnExists(ctx, d, table, col); err != nil || !ok {
				continue
			}
		}
		rows, err := d.QueryContext(ctx, f.Query)
		if err != nil {
			return err
		}
		for rows.Next() {
			var row, ct string
			if err := rows.Scan(&row, &ct); err != nil {
				rows.Close()
				return err
			}
			id, err := crypto.KeyIDOf(ct)
			if err != nil || !isNew(id) {
				rows.Close()
				return fmt.Errorf("%s[%s] key_id=%s err=%v", f.Name, row, id, err)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

func tableAndColFromFieldName(name string) (string, string) {
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			rest := name[i+1:]
			for j := 0; j < len(rest); j++ {
				if rest[j] == '.' {
					return name[:i], rest[:j]
				}
			}
			return name[:i], rest
		}
	}
	return name, ""
}

func tableExists(ctx context.Context, q db.Querier, table string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n)
	return n > 0, err
}

func columnExists(ctx context.Context, q db.Querier, table, column string) (bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *Service) rotateDB(ctx context.Context, sqlDB *sql.DB, newKeyID string, prog *Progress, onStep func()) error {
	for _, sc := range db.SecretColumns {
		if ok, err := tableExists(ctx, sqlDB, sc.Table); err != nil || !ok {
			if err != nil {
				return err
			}
			continue
		}
		if ok, err := columnExists(ctx, sqlDB, sc.Table, sc.Column); err != nil || !ok {
			if err != nil {
				return err
			}
			continue
		}
		if err := s.rotateSecretColumn(ctx, sqlDB, sc, newKeyID, prog, onStep); err != nil {
			return err
		}
	}
	return nil
}

func pkSelectFor(table string) string {
	switch table {
	case "system_settings":
		return "key, is_secret"
	case "vault_secrets_custody":
		return "cluster_id"
	case "vault_unseal_key_generations":
		return "cluster_id, generation"
	default:
		return "id"
	}
}

func (s *Service) rotateSecretColumn(ctx context.Context, sqlDB *sql.DB, sc db.SecretColumn, newKeyID string, prog *Progress, onStep func()) error {
	query := fmt.Sprintf("SELECT %s, %s FROM %s", pkSelectFor(sc.Table), sc.Column, sc.Table)
	rows, err := sqlDB.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	type candidate struct {
		row map[string]any
		val string
	}
	var cands []candidate
	for rows.Next() {
		row := map[string]any{}
		var val string
		switch sc.Table {
		case "system_settings":
			var k string
			var sec int
			if err := rows.Scan(&k, &sec, &val); err != nil {
				rows.Close()
				return err
			}
			row["key"], row["is_secret"] = k, strconv.Itoa(sec)
		case "vault_secrets_custody":
			var cid string
			if err := rows.Scan(&cid, &val); err != nil {
				rows.Close()
				return err
			}
			row["cluster_id"] = cid
		case "vault_unseal_key_generations":
			var cid string
			var gen int
			if err := rows.Scan(&cid, &gen, &val); err != nil {
				rows.Close()
				return err
			}
			row["cluster_id"], row["generation"] = cid, strconv.Itoa(gen)
		default:
			var id string
			if err := rows.Scan(&id, &val); err != nil {
				rows.Close()
				return err
			}
			row["id"] = id
		}
		row[sc.Column] = val
		if sc.Applies != nil && !sc.Applies(row) {
			continue
		}
		if val == "" {
			continue
		}
		cands = append(cands, candidate{row: row, val: val})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, c := range cands {
		tx, err := sqlDB.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		freshVal, exists, err := readSecretRow(ctx, tx, sc, c.row)
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		if !exists || freshVal == "" {
			_ = tx.Rollback()
			continue
		}
		c.row[sc.Column] = freshVal
		if sc.Applies != nil && !sc.Applies(c.row) {
			_ = tx.Rollback()
			continue
		}
		updated, changed, err := s.reencryptValue(sc, c.row, freshVal, newKeyID)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("%s: %w", sc.Field, err)
		}
		if !changed {
			_ = tx.Rollback()
			continue
		}
		if err := updateSecretRow(ctx, tx, sc, c.row, updated); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if prog != nil {
			prog.DBFields[sc.Field]++
			prog.ReencryptedRows++
			prog.LastDBPos = sc.Field + ":" + rowIDLabel(sc.Table, c.row)
			if onStep != nil {
				onStep()
			}
		}
	}
	return nil
}

func readSecretRow(ctx context.Context, tx *sql.Tx, sc db.SecretColumn, row map[string]any) (string, bool, error) {
	var q string
	var args []any
	switch sc.Table {
	case "system_settings":
		q = `SELECT value FROM system_settings WHERE key = ?`
		args = []any{db.RowString(row, "key")}
	case "vault_secrets_custody":
		q = fmt.Sprintf(`SELECT %s FROM vault_secrets_custody WHERE cluster_id = ?`, sc.Column)
		args = []any{db.RowString(row, "cluster_id")}
	case "vault_unseal_key_generations":
		gen, _ := strconv.Atoi(db.RowString(row, "generation"))
		q = `SELECT unseal_keys_encrypted FROM vault_unseal_key_generations WHERE cluster_id = ? AND generation = ?`
		args = []any{db.RowString(row, "cluster_id"), gen}
	default:
		q = fmt.Sprintf(`SELECT %s FROM %s WHERE id = ?`, sc.Column, sc.Table)
		args = []any{db.RowString(row, "id")}
	}
	var val string
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&val); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return val, true, nil
}

func rowIDLabel(table string, row map[string]any) string {
	switch table {
	case "system_settings":
		return db.RowString(row, "key")
	case "vault_secrets_custody":
		return db.RowString(row, "cluster_id")
	case "vault_unseal_key_generations":
		return db.RowString(row, "cluster_id") + ":" + db.RowString(row, "generation")
	default:
		return db.RowString(row, "id")
	}
}

func updateSecretRow(ctx context.Context, tx *sql.Tx, sc db.SecretColumn, row map[string]any, updated string) error {
	switch sc.Table {
	case "system_settings":
		_, err := tx.ExecContext(ctx, `UPDATE system_settings SET value = ? WHERE key = ?`, updated, db.RowString(row, "key"))
		return err
	case "vault_secrets_custody":
		_, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE vault_secrets_custody SET %s = ? WHERE cluster_id = ?`, sc.Column),
			updated, db.RowString(row, "cluster_id"))
		return err
	case "vault_unseal_key_generations":
		gen, _ := strconv.Atoi(db.RowString(row, "generation"))
		_, err := tx.ExecContext(ctx, `UPDATE vault_unseal_key_generations SET unseal_keys_encrypted = ? WHERE cluster_id = ? AND generation = ?`,
			updated, db.RowString(row, "cluster_id"), gen)
		return err
	default:
		_, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE %s SET %s = ? WHERE id = ?`, sc.Table, sc.Column),
			updated, db.RowString(row, "id"))
		return err
	}
}

func (s *Service) reencryptValue(sc db.SecretColumn, row map[string]any, val, newKeyID string) (string, bool, error) {
	aad := sc.AAD(row)
	if len(sc.JSONPath) == 0 {
		kid, err := crypto.KeyIDOf(val)
		if err != nil {
			return "", false, err
		}
		if kid == newKeyID {
			return val, false, nil
		}
		pt, err := s.Keys.Decrypt(val, aad)
		if err != nil {
			return "", false, err
		}
		ct, err := s.Keys.Encrypt(pt, aad)
		if err != nil {
			return "", false, err
		}
		return ct, true, nil
	}

	doc := map[string]any{}
	if err := json.Unmarshal([]byte(val), &doc); err != nil {
		return "", false, nil
	}
	cur := doc
	for _, k := range sc.JSONPath[:len(sc.JSONPath)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			return "", false, nil
		}
		cur = next
	}
	leaf := sc.JSONPath[len(sc.JSONPath)-1]
	ct, _ := cur[leaf].(string)
	if ct == "" {
		return "", false, nil
	}
	kid, err := crypto.KeyIDOf(ct)
	if err != nil {
		return "", false, err
	}
	if kid == newKeyID {
		return "", false, nil
	}
	pt, err := s.Keys.Decrypt(ct, aad)
	if err != nil {
		return "", false, err
	}
	nct, err := s.Keys.Encrypt(pt, aad)
	if err != nil {
		return "", false, err
	}
	cur[leaf] = nct
	b, err := json.Marshal(doc)
	if err != nil {
		return "", false, err
	}
	return string(b), true, nil
}
