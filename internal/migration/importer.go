package migration

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

// Import strategies.
const (
	StrategyReplace = "replace"
	StrategyMerge   = "merge"
)

// PreviewTTL bounds how long a preview token stays valid.
const PreviewTTL = 30 * time.Minute

// MaxBundleSize caps an uploaded bundle.
const MaxBundleSize = 8 << 30

// MaintenanceAwaiting marks clusters imported by a merge until activation.
const MaintenanceAwaiting = "awaiting_activation"

// TableImpact describes what an import does to one table.
type TableImpact struct {
	Table    string `json:"table"`
	InBundle int    `json:"in_bundle"`
	Replaced int    `json:"replaced,omitempty"` // target rows removed (replace)
	Note     string `json:"note,omitempty"`
}

// RetainedImpact lists rows of tables kept from the target that an import
// removes because their reference disappears.
type RetainedImpact struct {
	Table  string `json:"table"`
	Rows   int    `json:"rows"`
	Reason string `json:"reason"`
}

// Account is a login account available after the import.
type Account struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

// Report is the dry-run result of an import.
type Report struct {
	PreviewToken  string           `json:"preview_token"`
	ExpiresAt     time.Time        `json:"expires_at"`
	Strategy      string           `json:"strategy"`
	BundleSHA256  string           `json:"bundle_sha256"`
	Manifest      *Manifest        `json:"manifest"`
	Tables        []TableImpact    `json:"tables"`
	Retained      []RetainedImpact `json:"retained_cleanup"`
	LoginAccounts []Account        `json:"login_accounts"`
	Reused        []string         `json:"reused,omitempty"`
	Renamed       []string         `json:"renamed,omitempty"`
	Warnings      []string         `json:"warnings"`
}

type preview struct {
	token      string
	path       string
	sha        string
	strategy   string
	digest     string
	passphrase string
	adminID    string
	sessionID  string
	expires    time.Time
	report     *Report
	timer      *time.Timer
}

// scan holds what a preview learns from the bundle.
type scan struct {
	rows       map[string]int
	ids        map[string]map[string]bool // table -> primary ids
	admins     []map[string]any
	sshKeys    []map[string]any
	nodes      []map[string]any
	clusters   []map[string]any
	members    []map[string]any
	nameRows   map[string][]string // uniqueNames table -> names
	customCron int
}

// CleanupTempImports removes leftover uploaded bundle files from previous runs.
func (s *Service) CleanupTempImports() {
	if s.DataDir == "" {
		return
	}
	dir := filepath.Join(s.DataDir, "tmp", "imports")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func (s *Service) gcPreviews() {
	now := time.Now()
	for k, p := range s.previews {
		if now.After(p.expires) {
			if p.timer != nil {
				p.timer.Stop()
			}
			_ = os.Remove(p.path)
			p.passphrase = ""
			delete(s.previews, k)
		}
	}
}

func (s *Service) expirePreview(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.previews[token]
	if p == nil {
		return
	}
	_ = os.Remove(p.path)
	p.passphrase = ""
	delete(s.previews, token)
}

// Preview stores an uploaded bundle, decrypts and analyses it, and returns
// a report with a one-time preview token bound to the bundle hash, the
// strategy, the target database state and the requesting session.
func (s *Service) Preview(ctx context.Context, sessionID, adminID string, src io.Reader, passphrase, strategy string) (*Report, error) {
	if strategy != StrategyReplace && strategy != StrategyMerge {
		return nil, badRequest("strategy 需为 replace 或 merge")
	}
	dir := filepath.Join(s.DataDir, "tmp", "imports")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, "upload-*.ndbundle")
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(f.Name())
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(src, MaxBundleSize+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, badRequest("上传失败：%v", err)
	}
	if n > MaxBundleSize {
		return nil, badRequest("迁移包超过大小上限")
	}
	sum := hex.EncodeToString(h.Sum(nil))
	sc, m, err := s.scanBundle(ctx, f.Name(), passphrase)
	if err != nil {
		return nil, err
	}
	rep, err := s.analyse(ctx, sc, m, strategy)
	if err != nil {
		return nil, err
	}
	digest, err := s.stateDigest(ctx)
	if err != nil {
		return nil, err
	}
	tok := make([]byte, 24)
	_, _ = rand.Read(tok)
	rep.PreviewToken, rep.ExpiresAt, rep.Strategy, rep.BundleSHA256 = hex.EncodeToString(tok), time.Now().Add(PreviewTTL).UTC(), strategy, sum
	s.mu.Lock()
	if s.previews == nil {
		s.previews = map[string]*preview{}
	}
	s.gcPreviews()
	tokStr := rep.PreviewToken
	pv := &preview{token: tokStr, path: f.Name(), sha: sum, strategy: strategy, digest: digest,
		passphrase: passphrase, adminID: adminID, sessionID: sessionID, expires: rep.ExpiresAt, report: rep}
	pv.timer = time.AfterFunc(PreviewTTL, func() { s.expirePreview(tokStr) })
	s.previews[tokStr] = pv
	s.mu.Unlock()
	keep = true
	return rep, nil
}

func (s *Service) scanBundle(ctx context.Context, path, passphrase string) (*scan, *Manifest, error) {
	schema, err := s.DB.SchemaVersion(ctx)
	if err != nil {
		return nil, nil, err
	}
	sc := &scan{rows: map[string]int{}, ids: map[string]map[string]bool{}, nameRows: map[string][]string{}}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	m, err := read(f, passphrase, Visitor{
		Manifest: func(m *Manifest) error {
			if m.SchemaVersion != schema {
				return badRequest("迁移包的数据库结构版本（%d）与本实例（%d）不一致，请先将两端升级到同一版本", m.SchemaVersion, schema)
			}
			for _, t := range CoreTables {
				if !contains(m.Tables, t) {
					return badRequest("迁移包缺少核心表 %s", t)
				}
			}
			for _, t := range m.Tables {
				if !contains(insertOrder, t) {
					return badRequest("迁移包含有不支持的表 %s", t)
				}
			}
			return nil
		},
		Row: func(table string, row map[string]any) error {
			sc.rows[table]++
			if id := db.RowString(row, "id"); id != "" {
				if sc.ids[table] == nil {
					sc.ids[table] = map[string]bool{}
				}
				sc.ids[table][id] = true
			}
			switch table {
			case "admins":
				sc.admins = append(sc.admins, map[string]any{"username": row["username"], "role": row["role"], "is_disabled": row["is_disabled"]})
			case "ssh_keys":
				sc.sshKeys = append(sc.sshKeys, map[string]any{"id": row["id"], "fingerprint": row["fingerprint"]})
			case "nodes":
				sc.nodes = append(sc.nodes, map[string]any{"id": row["id"], "name": row["name"], "machine_id": row["machine_id"],
					"host": row["host"], "ssh_port": row["ssh_port"]})
			case "clusters":
				sc.clusters = append(sc.clusters, map[string]any{"id": row["id"], "name": row["name"]})
			case "cluster_nodes":
				sc.members = append(sc.members, map[string]any{"node_id": row["node_id"], "cluster_type": row["cluster_type"]})
			case "cron_jobs":
				if db.RowString(row, "is_builtin") != "1" {
					sc.customCron++
				}
			}
			if uniqueNames[table] {
				sc.nameRows[table] = append(sc.nameRows[table], db.RowString(row, "name"))
			}
			return nil
		},
	})
	if err != nil {
		var ae *auth.Error
		if errors.As(err, &ae) {
			return nil, nil, err
		}
		if errors.Is(err, ErrPassphrase) || strings.Contains(err.Error(), "authentication") {
			return nil, nil, badRequest("迁移口令错误或迁移包已损坏")
		}
		return nil, nil, badRequest("%v", err)
	}
	return sc, m, nil
}

func (s *Service) count(ctx context.Context, q string, args ...any) int {
	var n int
	_ = s.DB.Reader.QueryRowContext(ctx, q, args...).Scan(&n)
	return n
}

// notIn builds "col NOT IN (...)" over a set (an empty set matches all).
func notIn(col string, set map[string]bool) (string, []any) {
	if len(set) == 0 {
		return "1 = 1", nil
	}
	args := make([]any, 0, len(set))
	for id := range set {
		args = append(args, id)
	}
	return col + " NOT IN (" + strings.TrimSuffix(strings.Repeat("?,", len(args)), ",") + ")", args
}

func (s *Service) analyse(ctx context.Context, sc *scan, m *Manifest, strategy string) (*Report, error) {
	rep := &Report{Manifest: m, Warnings: []string{}, Retained: []RetainedImpact{}, LoginAccounts: []Account{}}
	if strategy == StrategyReplace {
		for _, t := range m.Tables {
			ti := TableImpact{Table: t, InBundle: sc.rows[t], Replaced: s.count(ctx, `SELECT COUNT(*) FROM `+t)}
			if t == "system_settings" {
				ti.Replaced = s.count(ctx, `SELECT COUNT(*) FROM system_settings WHERE `+localSettingFilter)
				ti.Note = "实例本地设置（激活状态、自更新、对外地址）保持不变；备份设置导入后处于停用状态"
			}
			rep.Tables = append(rep.Tables, ti)
		}
		if !contains(m.Tables, "cron_job_runs") {
			w, args := notIn("cron_job_id", sc.ids["cron_jobs"])
			if n := s.count(ctx, `SELECT COUNT(*) FROM cron_job_runs WHERE `+w, args...); n > 0 {
				rep.Retained = append(rep.Retained, RetainedImpact{Table: "cron_job_runs", Rows: n, Reason: "所属定时任务被替换"})
			}
		}
		if !contains(m.Tables, "job_revisions") {
			w, args := notIn("cluster_id", sc.ids["clusters"])
			if n := s.count(ctx, `SELECT COUNT(*) FROM job_revisions WHERE `+w, args...); n > 0 {
				rep.Retained = append(rep.Retained, RetainedImpact{Table: "job_revisions", Rows: n, Reason: "所属集群不在迁移包中"})
			}
		}
		if !contains(m.Tables, "operation_tasks") {
			rep.Warnings = append(rep.Warnings, "迁移包不含运维任务历史：本机运维任务记录保留，其中指向已不存在资源的记录在界面上标注为资源已不存在")
		}
		w, args := notIn("cluster_id", sc.ids["clusters"])
		if n := s.count(ctx, `SELECT COUNT(*) FROM cluster_snapshots WHERE `+w, args...); n > 0 {
			rep.Retained = append(rep.Retained, RetainedImpact{Table: "cluster_snapshots", Rows: n, Reason: "所属集群不在迁移包中"})
		}
		if n := s.count(ctx, `SELECT COUNT(*) FROM admin_sessions`); n > 0 {
			rep.Retained = append(rep.Retained, RetainedImpact{Table: "admin_sessions", Rows: n, Reason: "导入后全部会话失效"})
		}
		if contains(m.Tables, "admins") {
			for _, a := range sc.admins {
				if db.RowString(a, "is_disabled") != "1" {
					rep.LoginAccounts = append(rep.LoginAccounts, Account{Username: db.RowString(a, "username"), Role: db.RowString(a, "role")})
				}
			}
			rep.Warnings = append(rep.Warnings, "迁移包含有账号：导入后使用源环境的账号与密码登录")
		} else {
			rep.LoginAccounts = s.targetAccounts(ctx)
		}
		rep.Warnings = append(rep.Warnings, "导入后控制面进入暂停待命态：定时任务与自动解封暂停，确认旧控制面已下线后点击「激活控制面」恢复")
	} else {
		for _, t := range m.Tables {
			ti := TableImpact{Table: t, InBundle: sc.rows[t]}
			if !contains(mergeOrder, t) {
				ti.Note = "合并模式不导入该表"
			}
			rep.Tables = append(rep.Tables, ti)
		}
		var conflicts []string
		for _, c := range sc.clusters {
			if s.count(ctx, `SELECT COUNT(*) FROM clusters WHERE name = ?`, db.RowString(c, "name")) > 0 {
				conflicts = append(conflicts, fmt.Sprintf("集群名称“%s”已存在", db.RowString(c, "name")))
			}
		}
		reused := map[string]string{} // bundle node id -> target node id
		for _, n := range sc.nodes {
			if id := s.matchNode(ctx, n); id != "" {
				reused[db.RowString(n, "id")] = id
				rep.Reused = append(rep.Reused, fmt.Sprintf("主机“%s”复用本机已登记的同一主机", db.RowString(n, "name")))
			}
		}
		for _, mbr := range sc.members {
			if tid, ok := reused[db.RowString(mbr, "node_id")]; ok {
				if s.count(ctx, `SELECT COUNT(*) FROM cluster_nodes WHERE node_id = ? AND cluster_type = ?`, tid, db.RowString(mbr, "cluster_type")) > 0 {
					conflicts = append(conflicts, fmt.Sprintf("复用的主机已属于本机的另一个 %s 集群", db.RowString(mbr, "cluster_type")))
				}
			}
		}
		for _, k := range sc.sshKeys {
			if s.count(ctx, `SELECT COUNT(*) FROM ssh_keys WHERE fingerprint = ?`, db.RowString(k, "fingerprint")) > 0 {
				rep.Reused = append(rep.Reused, "SSH 密钥 "+db.RowString(k, "fingerprint")+" 复用本机已有密钥")
			}
		}
		for t, names := range sc.nameRows {
			for _, nm := range names {
				if s.count(ctx, `SELECT COUNT(*) FROM `+t+` WHERE name = ?`, nm) > 0 {
					rep.Renamed = append(rep.Renamed, fmt.Sprintf("%s：“%s”与本机重名，导入时自动改名", t, nm))
				}
			}
		}
		sort.Strings(rep.Renamed)
		if len(conflicts) > 0 {
			return nil, &auth.Error{Status: 409, Code: "merge_conflict", Message: "合并导入存在冲突：" + strings.Join(conflicts, "；")}
		}
		rep.LoginAccounts = s.targetAccounts(ctx)
		rep.Warnings = append(rep.Warnings, "导入的集群处于暂停待命态（维护模式），激活控制面后恢复；本机原有集群不受影响")
		if sc.customCron > 0 {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("将导入 %d 个自定义定时任务，内置任务沿用本机配置", sc.customCron))
		}
	}
	admins := 0
	for _, a := range rep.LoginAccounts {
		if a.Role == "admin" {
			admins++
		}
	}
	if admins == 0 {
		return nil, conflict("no_admin_after_import", "导入后不存在任何启用状态的 admin 账号，已拒绝该导入")
	}
	return rep, nil
}

func (s *Service) targetAccounts(ctx context.Context) []Account {
	out := []Account{}
	rows, err := s.DB.Reader.QueryContext(ctx, `SELECT username, role FROM admins WHERE is_disabled = 0 ORDER BY username`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var a Account
		if rows.Scan(&a.Username, &a.Role) == nil {
			out = append(out, a)
		}
	}
	return out
}

// matchNode finds the target node that is the same host (machine-id, or
// address and SSH port).
func (s *Service) matchNode(ctx context.Context, n map[string]any) string {
	var id string
	if mid := db.RowString(n, "machine_id"); mid != "" {
		if s.DB.Reader.QueryRowContext(ctx, `SELECT id FROM nodes WHERE machine_id = ?`, mid).Scan(&id) == nil {
			return id
		}
	}
	_ = s.DB.Reader.QueryRowContext(ctx, `SELECT id FROM nodes WHERE host = ? AND ssh_port = ?`,
		db.RowString(n, "host"), db.RowString(n, "ssh_port")).Scan(&id)
	return id
}

// stateDigest fingerprints the target database so an apply notices changes
// made after the preview. Audit logs, sessions and cron run history are
// excluded: they change constantly and are handled by the import itself.
func (s *Service) stateDigest(ctx context.Context) (string, error) {
	h := sha256.New()
	for _, t := range insertOrder {
		if t == "audit_logs" || t == "cron_job_runs" {
			continue
		}
		var n, maxRow int64
		if err := s.DB.Reader.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM `+t).Scan(&n, &maxRow); err != nil {
			return "", err
		}
		upd := ""
		if hasColumn(ctx, s.DB.Reader, t, "updated_at") {
			_ = s.DB.Reader.QueryRowContext(ctx, `SELECT COALESCE(MAX(updated_at), '') FROM `+t).Scan(&upd)
		}
		fmt.Fprintf(h, "%s:%d:%d:%s\n", t, n, maxRow, upd)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hasColumn(ctx context.Context, q db.Querier, table, col string) bool {
	rows, err := q.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil && n == col {
			return true
		}
	}
	return false
}

// takePreview consumes a preview token for the session that created it.
func (s *Service) takePreview(token, sessionID, adminID string) (*preview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.previews[token]
	delete(s.previews, token)
	if p != nil && p.timer != nil {
		p.timer.Stop()
	}
	switch {
	case p == nil:
		return nil, conflict("preview_invalid", "预检凭证无效或已使用，请重新上传迁移包预检")
	case time.Now().After(p.expires):
		_ = os.Remove(p.path)
		p.passphrase = ""
		return nil, conflict("preview_expired", "预检凭证已过期，请重新预检")
	case p.sessionID != sessionID || p.adminID != adminID:
		_ = os.Remove(p.path)
		p.passphrase = ""
		return nil, conflict("preview_invalid", "预检凭证不属于当前会话")
	}
	return p, nil
}

// ImportResult summarizes an applied import.
type ImportResult struct {
	Strategy string         `json:"strategy"`
	Rows     map[string]int `json:"rows"`
	LogFiles int            `json:"log_files"`
	Clusters int            `json:"clusters"`
}

// Apply executes a previewed import under the global maintenance barrier.
func (s *Service) Apply(ctx context.Context, actor audit.Actor, sessionID, adminID, token string) (*ImportResult, error) {
	p, err := s.takePreview(token, sessionID, adminID)
	if err != nil {
		return nil, err
	}
	defer os.Remove(p.path)
	if sum, err := fileSHA(p.path); err != nil || sum != p.sha {
		return nil, conflict("preview_stale", "迁移包文件在预检后发生变化，请重新预检")
	}
	releaseBarrier, ok := s.Ops.TryAcquireBarrier("迁移导入")
	if !ok {
		return nil, conflict("maintenance_active", "控制面已处于全局维护状态")
	}
	defer releaseBarrier()
	if s.ExtraBusy != nil && s.ExtraBusy() {
		return nil, conflict("rotation_running", "正在执行主密钥轮换，请等待其结束后再导入")
	}
	if n := s.Ops.Active(); n > 0 {
		return nil, conflict("tasks_running", "仍有 %d 个运维任务在执行，请等待其结束后再导入", n)
	}
	if s.Idle != nil {
		ictx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := s.Idle(ictx)
		cancel()
		if err != nil {
			return nil, conflict("cron_running", "仍有定时任务在执行，请稍后再试")
		}
	}
	if digest, err := s.stateDigest(ctx); err != nil || digest != p.digest {
		return nil, conflict("preview_stale", "预检之后目标数据库已发生变化，请重新预检")
	}
	res, err := s.apply(ctx, p)
	if err != nil {
		var ae *auth.Error
		if !errors.As(err, &ae) {
			err = &auth.Error{Status: 500, Code: "import_failed", Message: "导入失败，数据库未做任何修改：" + audit.RedactString(err.Error())}
		}
		_ = s.Audit.Record(context.Background(), nil, audit.Event{Actor: actor, Action: "migration.import", ResourceType: "control_plane",
			Summary: map[string]any{"strategy": p.strategy, "bundle_sha256": p.sha}, Err: err})
		return nil, err
	}
	for _, f := range s.AfterImport {
		f()
	}
	_ = s.Audit.Record(context.Background(), nil, audit.Event{Actor: actor, Action: "migration.import", ResourceType: "control_plane",
		Summary: map[string]any{"strategy": p.strategy, "bundle_sha256": p.sha, "rows": res.Rows, "log_files": res.LogFiles,
			"source_created_at": p.report.Manifest.CreatedAt}})
	return res, nil
}

func fileSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// tableMeta caches column and key information of a table.
type tableMeta struct {
	pk  []string
	fks map[string]string // column -> referenced table
}

func loadMeta(ctx context.Context, conn *sql.Conn, table string) (*tableMeta, error) {
	m := &tableMeta{fks: map[string]string{}}
	rows, err := conn.QueryContext(ctx, `SELECT name, pk FROM pragma_table_info(?) ORDER BY pk`, table)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var name string
		var pk int
		if err := rows.Scan(&name, &pk); err != nil {
			rows.Close()
			return nil, err
		}
		if pk > 0 {
			m.pk = append(m.pk, name)
		}
	}
	rows.Close()
	rows, err = conn.QueryContext(ctx, `SELECT "table", "from" FROM pragma_foreign_key_list(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref, from string
		if err := rows.Scan(&ref, &from); err != nil {
			return nil, err
		}
		m.fks[from] = ref
	}
	return m, rows.Err()
}

func insertRow(ctx context.Context, tx *sql.Tx, table string, row map[string]any) error {
	cols := make([]string, 0, len(row))
	for c := range row {
		cols = append(cols, c)
	}
	sort.Strings(cols)
	args := make([]any, len(cols))
	quoted := make([]string, len(cols))
	for i, c := range cols {
		v, err := decodeValue(row[c])
		if err != nil {
			return fmt.Errorf("%s.%s：%w", table, c, err)
		}
		args[i] = v
		quoted[i] = `"` + strings.ReplaceAll(c, `"`, `""`) + `"`
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO `+table+` (`+strings.Join(quoted, ", ")+`) VALUES (`+
		strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", ")+`)`, args...)
	return err
}

// apply runs the import in one transaction with foreign key enforcement
// off (so deletions do not cascade into kept tables) and a full foreign
// key check before commit.
func (s *Service) apply(ctx context.Context, p *preview) (res *ImportResult, err error) {
	conn, err := s.DB.Writer.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return nil, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), `PRAGMA foreign_keys = ON`) }()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	var written []string
	defer func() {
		if err != nil {
			_ = tx.Rollback()
			for _, f := range written {
				_ = os.Remove(f)
			}
		}
	}()
	res = &ImportResult{Strategy: p.strategy, Rows: map[string]int{}}
	f, err := os.Open(p.path)
	if err != nil {
		return nil, err
	}
	var im importer
	if p.strategy == StrategyReplace {
		im = &replacer{s: s, tx: tx}
	} else {
		mg := &merger{s: s, tx: tx, conn: conn, ids: map[string]map[string]string{}, metas: map[string]*tableMeta{}}
		im = mg
	}
	_, err = read(f, p.passphrase, Visitor{
		Manifest: func(m *Manifest) error { return im.begin(ctx, m) },
		Row: func(table string, row map[string]any) error {
			ok, err := im.row(ctx, table, row)
			if err != nil {
				return fmt.Errorf("表 %s：%w", table, err)
			}
			if ok {
				res.Rows[table]++
			}
			return nil
		},
		LogFile: func(rel string, size int64, r io.Reader) error {
			if p.strategy != StrategyReplace {
				return nil
			}
			dst, err := s.logTarget(rel)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
				return err
			}
			out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return err
			}
			written = append(written, dst)
			_, err = io.CopyN(out, r, size)
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			res.LogFiles++
			return err
		},
	})
	if err != nil {
		return nil, err
	}
	if err = im.finish(ctx); err != nil {
		return nil, err
	}
	if err = foreignKeyCheck(ctx, tx); err != nil {
		return nil, err
	}
	res.Clusters = res.Rows["clusters"]
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return res, nil
}

// logTarget maps a bundle log path into this data directory.
func (s *Service) logTarget(rel string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(rel))
	if !strings.HasPrefix(clean, "ops"+string(filepath.Separator)) || strings.Contains(clean, "..") {
		return "", fmt.Errorf("迁移包中的步骤日志路径不合法：%s", rel)
	}
	return filepath.Join(s.DataDir, clean), nil
}

func foreignKeyCheck(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var problems []string
	for rows.Next() {
		var table, parent string
		var rowid sql.NullInt64
		var fkid int
		if err := rows.Scan(&table, &rowid, &parent, &fkid); err != nil {
			return err
		}
		if len(problems) < 10 {
			problems = append(problems, fmt.Sprintf("%s 第 %d 行引用的 %s 不存在", table, rowid.Int64, parent))
		}
	}
	if len(problems) > 0 {
		return &auth.Error{Status: 409, Code: "foreign_key_violation", Message: "外键检查未通过，导入已整体回滚：" + strings.Join(problems, "；")}
	}
	return rows.Err()
}

type importer interface {
	begin(ctx context.Context, m *Manifest) error
	row(ctx context.Context, table string, row map[string]any) (bool, error)
	finish(ctx context.Context) error
}

// replacer clears the bundle's tables and restores them as they were.
type replacer struct {
	s      *Service
	tx     *sql.Tx
	tables []string
}

func (r *replacer) begin(ctx context.Context, m *Manifest) error {
	r.tables = m.Tables
	for i := len(insertOrder) - 1; i >= 0; i-- {
		t := insertOrder[i]
		if !contains(m.Tables, t) {
			continue
		}
		q := `DELETE FROM ` + t
		if t == "system_settings" {
			q += ` WHERE ` + localSettingFilter
		}
		if _, err := r.tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

func (r *replacer) row(ctx context.Context, table string, row map[string]any) (bool, error) {
	if table == "system_settings" && localSetting(db.RowString(row, "key")) {
		return false, nil
	}
	if table == "operation_task_steps" {
		if lp := db.RowString(row, "log_path"); lp != "" {
			if _, err := r.s.logTarget(lp); err != nil {
				return false, err
			}
			row["log_path"] = filepath.Clean(filepath.FromSlash(lp))
		}
	}
	if err := r.s.sealSecrets(row, db.SecretsOf(table)); err != nil {
		return false, err
	}
	return true, insertRow(ctx, r.tx, table, row)
}

func (r *replacer) finish(ctx context.Context) error {
	stmts := []string{
		`DELETE FROM cron_job_runs WHERE cron_job_id NOT IN (SELECT id FROM cron_jobs)`,
		`DELETE FROM job_revisions WHERE cluster_id NOT IN (SELECT id FROM clusters)`,
		`DELETE FROM operation_task_steps WHERE task_id NOT IN (SELECT id FROM operation_tasks)`,
		`DELETE FROM cluster_snapshots WHERE cluster_id NOT IN (SELECT id FROM clusters)`,
		`DELETE FROM admin_sessions`,
	}
	for _, q := range stmts {
		if _, err := r.tx.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	// Snapshot records whose files are not on this host are dropped.
	rows, err := r.tx.QueryContext(ctx, `SELECT id, file_path FROM cluster_snapshots`)
	if err != nil {
		return err
	}
	var missing []string
	for rows.Next() {
		var id, p string
		if rows.Scan(&id, &p) == nil {
			if _, err := os.Stat(p); err != nil {
				missing = append(missing, id)
			}
		}
	}
	rows.Close()
	for _, id := range missing {
		if _, err := r.tx.ExecContext(ctx, `DELETE FROM cluster_snapshots WHERE id = ?`, id); err != nil {
			return err
		}
	}
	now := r.s.DB.NowString()
	if err := db.PutSettingJSON(ctx, r.tx, "control_plane.activated", false, now); err != nil {
		return err
	}
	if _, err := r.tx.ExecContext(ctx, `UPDATE system_settings SET value = 'false', updated_at = ? WHERE key = 'backup.enabled'`, now); err != nil {
		return err
	}
	return nil
}

// merger adds the bundle's core configuration next to the existing one,
// with new identifiers and rewritten references.
type merger struct {
	s     *Service
	tx    *sql.Tx
	conn  *sql.Conn
	ids   map[string]map[string]string // table -> old id -> target id
	metas map[string]*tableMeta
}

func (m *merger) begin(ctx context.Context, _ *Manifest) error { return nil }

func (m *merger) mapID(table, old, target string) {
	if m.ids[table] == nil {
		m.ids[table] = map[string]string{}
	}
	m.ids[table][old] = target
}

func (m *merger) meta(ctx context.Context, table string) (*tableMeta, error) {
	if tm := m.metas[table]; tm != nil {
		return tm, nil
	}
	tm, err := loadMeta(ctx, m.conn, table)
	if err == nil {
		m.metas[table] = tm
	}
	return tm, err
}

func (m *merger) uniqueName(ctx context.Context, table, name string) string {
	cand := name
	for i := 1; ; i++ {
		var n int
		_ = m.tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE name = ?`, cand).Scan(&n)
		if n == 0 {
			return cand
		}
		if i == 1 {
			cand = name + "-导入"
		} else {
			cand = fmt.Sprintf("%s-导入-%d", name, i)
		}
	}
}

func (m *merger) row(ctx context.Context, table string, row map[string]any) (bool, error) {
	if !contains(mergeOrder, table) {
		return false, nil
	}
	tm, err := m.meta(ctx, table)
	if err != nil {
		return false, err
	}
	oldID := db.RowString(row, "id")
	// Reuse rows that already exist on the target.
	switch table {
	case "ssh_keys":
		var id string
		if m.tx.QueryRowContext(ctx, `SELECT id FROM ssh_keys WHERE fingerprint = ?`, db.RowString(row, "fingerprint")).Scan(&id) == nil {
			m.mapID(table, oldID, id)
			return false, nil
		}
		row["is_default"] = int64(0)
	case "nodes":
		if id := m.s.matchNode(ctx, row); id != "" {
			m.mapID(table, oldID, id)
			return false, nil
		}
	case "cron_jobs":
		if db.RowString(row, "is_builtin") == "1" {
			return false, nil
		}
	}
	// Rewrite SQL foreign keys.
	for col, ref := range tm.fks {
		v := db.RowString(row, col)
		if v == "" {
			continue
		}
		if !contains(mergeOrder, ref) {
			continue
		}
		nv, ok := m.ids[ref][v]
		if !ok {
			return false, fmt.Errorf("%s 引用的 %s（%s）不在迁移包中", col, ref, v)
		}
		row[col] = nv
	}
	// Rewrite references embedded in JSON columns.
	for col, keys := range jsonRefs[table] {
		doc := map[string]any{}
		if json.Unmarshal([]byte(db.RowString(row, col)), &doc) != nil {
			continue
		}
		for key, ref := range keys {
			if v, _ := doc[key].(string); v != "" {
				nv, ok := m.ids[ref][v]
				if !ok {
					return false, fmt.Errorf("%s.%s 引用的 %s（%s）不在迁移包中", col, key, ref, v)
				}
				doc[key] = nv
			}
		}
		b, _ := json.Marshal(doc)
		row[col] = string(b)
	}
	// New identity for rows keyed by their own id.
	if len(tm.pk) == 1 && tm.pk[0] == "id" {
		nid := db.NewID()
		m.mapID(table, oldID, nid)
		row["id"] = nid
	}
	if uniqueNames[table] {
		row["name"] = m.uniqueName(ctx, table, db.RowString(row, "name"))
	}
	switch table {
	case "clusters":
		if db.RowString(row, "maintenance_mode") != "1" {
			row["maintenance_mode"], row["maintenance_reason"] = int64(1), MaintenanceAwaiting
		}
	case "nodes":
		row["status"] = "unknown"
	case "cron_jobs":
		row["job_key"] = "custom-" + strings.ToLower(db.RowString(row, "id"))
		row["next_run_at"], row["last_run_at"], row["last_status"] = nil, nil, ""
	}
	if err := m.s.sealSecrets(row, db.SecretsOf(table)); err != nil {
		return false, err
	}
	return true, insertRow(ctx, m.tx, table, row)
}

func (m *merger) finish(ctx context.Context) error {
	_, err := m.tx.ExecContext(ctx, `DELETE FROM admin_sessions`)
	return err
}

// Activate resumes automatic scheduling after a migration: it sets the
// instance's activation flag and releases clusters a merge left waiting.
func (s *Service) Activate(ctx context.Context, actor audit.Actor) (int, error) {
	var n int64
	err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		if err := db.PutSettingJSON(ctx, tx, "control_plane.activated", true, s.DB.NowString()); err != nil {
			return err
		}
		r, err := tx.ExecContext(ctx, `UPDATE clusters SET maintenance_mode = 0, maintenance_reason = '', updated_at = ?
			WHERE maintenance_mode = 1 AND maintenance_reason = ?`, s.DB.NowString(), MaintenanceAwaiting)
		if err != nil {
			return err
		}
		n, _ = r.RowsAffected()
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "migration.activate", ResourceType: "control_plane",
			Summary: map[string]any{"released_clusters": n}})
	})
	if err == nil {
		for _, f := range s.AfterActivate {
			f()
		}
	}
	return int(n), err
}
