package migration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/vaultbackup"
	"nomad-deck/internal/version"
)

// Service exports and imports bundles.
type Service struct {
	DB      *db.DB
	Keys    *crypto.Keyring
	Audit   *audit.Recorder
	Ops     *ops.Engine
	DataDir string
	Log     *slog.Logger
	// Idle waits until no scheduled job runs (the cron scheduler).
	Idle func(ctx context.Context) error
	// ExtraBusy reports whether another non-ops process (such as master-key rotation) is active.
	ExtraBusy func() bool
	// AfterImport runs after a committed import: revoke sessions, drop
	// cached clients and connections.
	AfterImport []func()
	// AfterActivate runs after Activate commits.
	AfterActivate []func()

	mu       sync.Mutex
	previews map[string]*preview
}

// ExportOptions selects a bundle's content.
type ExportOptions struct {
	Kind       string
	Include    []string // optional tables
	Passphrase string
	CreatedBy  string
	Offsite    []OffsiteSnapshot
}

func badRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}

func conflict(code, format string, args ...any) error {
	return &auth.Error{Status: 409, Code: code, Message: fmt.Sprintf(format, args...)}
}

// tablesFor resolves the exported tables in dependency order.
func tablesFor(include []string) ([]string, error) {
	want := map[string]bool{}
	for _, t := range CoreTables {
		want[t] = true
	}
	for _, t := range include {
		if !contains(OptionalTables, t) {
			return nil, badRequest("不支持导出的表：%s（可选 %s）", t, strings.Join(OptionalTables, "、"))
		}
		want[t] = true
		for _, c := range companions[t] {
			want[c] = true
		}
	}
	var out []string
	for _, t := range insertOrder {
		if want[t] {
			out = append(out, t)
		}
	}
	return out, nil
}

// Export writes a bundle of a consistent database snapshot to w.
func (s *Service) Export(ctx context.Context, opt ExportOptions, w io.Writer) (*Manifest, error) {
	if len(opt.Passphrase) < vaultbackup.MinPassphrase {
		return nil, badRequest("迁移口令至少 %d 个字符", vaultbackup.MinPassphrase)
	}
	if opt.Kind == "" {
		opt.Kind = KindMigration
	}
	tables, err := tablesFor(opt.Include)
	if err != nil {
		return nil, err
	}
	schema, err := s.DB.SchemaVersion(ctx)
	if err != nil {
		return nil, err
	}
	// One read transaction gives every table the same point in time.
	tx, err := s.DB.Reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	m := &Manifest{Format: FormatVersion, Kind: opt.Kind, SchemaVersion: schema, AppVersion: version.Version,
		CreatedAt: s.DB.Now().UTC(), CreatedBy: opt.CreatedBy, Tables: tables, Rows: map[string]int{}, OffsiteSnapshots: opt.Offsite}
	type logRef struct{ rel, abs string }
	var logs []logRef
	for _, t := range tables {
		var n int
		q := `SELECT COUNT(*) FROM ` + t
		if t == "system_settings" {
			q += ` WHERE ` + localSettingFilter
		}
		if err := tx.QueryRowContext(ctx, q).Scan(&n); err != nil {
			return nil, err
		}
		m.Rows[t] = n
		if t == "operation_task_steps" {
			rows, err := tx.QueryContext(ctx, `SELECT log_path FROM operation_task_steps WHERE log_path != ''`)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var p string
				if rows.Scan(&p) == nil {
					if rel, ok := s.relLog(p); ok {
						logs = append(logs, logRef{rel: rel, abs: filepath.Join(s.DataDir, rel)})
					}
				}
			}
			rows.Close()
		}
	}
	var present []logRef
	for _, l := range logs {
		if st, err := os.Stat(l.abs); err == nil && st.Mode().IsRegular() {
			present = append(present, l)
		}
	}
	m.LogFiles = len(present)
	err = write(w, opt.Kind, opt.Passphrase, func(b *bundleWriter) error {
		mj, _ := json.MarshalIndent(m, "", "  ")
		if err := b.file("manifest.json", mj); err != nil {
			return err
		}
		for _, t := range tables {
			if err := s.exportTable(ctx, tx, b, t); err != nil {
				return fmt.Errorf("导出表 %s：%w", t, err)
			}
		}
		for _, l := range present {
			f, err := os.Open(l.abs)
			if err != nil {
				return err
			}
			st, err := f.Stat()
			if err == nil {
				err = b.stream("logs/"+filepath.ToSlash(l.rel), st.Size(), f)
			}
			f.Close()
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return m, nil
}

// localSettingFilter excludes instance-local settings in SQL.
const localSettingFilter = `key != 'control_plane.activated' AND key NOT LIKE 'self\_update.%' ESCAPE '\' AND key NOT LIKE 'server.%' AND key NOT LIKE 'master\_key.%' ESCAPE '\'`

// relLog returns a step log path relative to the data directory.
func (s *Service) relLog(p string) (string, bool) {
	rel := p
	if filepath.IsAbs(p) {
		r, err := filepath.Rel(s.DataDir, p)
		if err != nil {
			return "", false
		}
		rel = r
	}
	rel = filepath.Clean(rel)
	if rel == "." || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return rel, true
}

func (s *Service) exportTable(ctx context.Context, tx *sql.Tx, b *bundleWriter, table string) error {
	rows, err := tx.QueryContext(ctx, `SELECT * FROM `+table)
	if err != nil {
		return err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return err
	}
	tw := &tableWriter{b: b, table: table}
	secrets := db.SecretsOf(table)
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			row[c] = encodeValue(vals[i])
		}
		if table == "system_settings" && localSetting(db.RowString(row, "key")) {
			continue
		}
		if table == "operation_task_steps" {
			if rel, ok := s.relLog(db.RowString(row, "log_path")); ok {
				row["log_path"] = filepath.ToSlash(rel)
			}
		}
		if err := s.revealSecrets(row, secrets); err != nil {
			return err
		}
		if err := tw.row(row); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return tw.flush()
}

// revealSecrets replaces ciphertext with {"$secret": plaintext}.
func (s *Service) revealSecrets(row map[string]any, secrets []db.SecretColumn) error {
	for _, sc := range secrets {
		if sc.Applies != nil && !sc.Applies(row) {
			continue
		}
		if len(sc.JSONPath) == 0 {
			ct := db.RowString(row, sc.Column)
			if ct == "" {
				continue
			}
			pt, err := s.Keys.Decrypt(ct, sc.AAD(row))
			if err != nil {
				return fmt.Errorf("%s 解密失败：%w", sc.Field, err)
			}
			row[sc.Column] = map[string]any{secretMarker: string(pt)}
			continue
		}
		doc := map[string]any{}
		raw := db.RowString(row, sc.Column)
		if raw == "" || json.Unmarshal([]byte(raw), &doc) != nil {
			continue
		}
		parent, leaf := walk(doc, sc.JSONPath, false)
		if parent == nil {
			continue
		}
		ct, _ := parent[leaf].(string)
		if ct == "" {
			continue
		}
		pt, err := s.Keys.Decrypt(ct, sc.AAD(row))
		if err != nil {
			return fmt.Errorf("%s 解密失败：%w", sc.Field, err)
		}
		parent[leaf] = map[string]any{secretMarker: string(pt)}
		b, _ := json.Marshal(doc)
		row[sc.Column] = string(b)
	}
	return nil
}

// sealSecrets re-encrypts {"$secret": ...} values with this instance's key.
func (s *Service) sealSecrets(row map[string]any, secrets []db.SecretColumn) error {
	for _, sc := range secrets {
		if len(sc.JSONPath) == 0 {
			m, ok := row[sc.Column].(map[string]any)
			if !ok {
				continue
			}
			pt, ok := m[secretMarker].(string)
			if !ok {
				return fmt.Errorf("%s 格式错误", sc.Field)
			}
			ct, err := s.Keys.Encrypt([]byte(pt), sc.AAD(row))
			if err != nil {
				return err
			}
			row[sc.Column] = ct
			continue
		}
		raw := db.RowString(row, sc.Column)
		doc := map[string]any{}
		if raw == "" || json.Unmarshal([]byte(raw), &doc) != nil {
			continue
		}
		parent, leaf := walk(doc, sc.JSONPath, false)
		if parent == nil {
			continue
		}
		m, ok := parent[leaf].(map[string]any)
		if !ok {
			continue
		}
		pt, _ := m[secretMarker].(string)
		ct, err := s.Keys.Encrypt([]byte(pt), sc.AAD(row))
		if err != nil {
			return err
		}
		parent[leaf] = ct
		b, _ := json.Marshal(doc)
		row[sc.Column] = string(b)
	}
	for k, v := range row {
		if m, ok := v.(map[string]any); ok {
			if _, isSecret := m[secretMarker]; isSecret {
				return fmt.Errorf("列 %s 含有未登记的密文", k)
			}
		}
	}
	return nil
}

// walk returns the map holding the path's last key.
func walk(doc map[string]any, p []string, create bool) (map[string]any, string) {
	cur := doc
	for _, k := range p[:len(p)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			if !create {
				return nil, ""
			}
			next = map[string]any{}
			cur[k] = next
		}
		cur = next
	}
	return cur, p[len(p)-1]
}

var errStop = errors.New("stop")

// ReadManifest decrypts a bundle far enough to return its manifest.
func ReadManifest(src io.ReadCloser, passphrase string) (*Manifest, error) {
	var got *Manifest
	_, err := read(src, passphrase, Visitor{Manifest: func(m *Manifest) error { got = m; return errStop }})
	if errors.Is(err, errStop) {
		return got, nil
	}
	return got, err
}

func nowUTC() time.Time { return time.Now().UTC() }
