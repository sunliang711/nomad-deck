package selfupdate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"nomad-deck/internal/db"
)

const mainDBName = "nomad-deck.db"

func openSQLiteNoMigrate(ctx context.Context, path string, readOnly bool) (*sql.DB, error) {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	if readOnly {
		q.Add("_pragma", "query_only(1)")
	} else {
		q.Add("_pragma", "foreign_keys(1)")
		q.Set("_txlock", "immediate")
	}
	d, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1)
	if err := d.PingContext(ctx); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

func readLastResultRaw(ctx context.Context, q db.Querier) (*UpdateResult, error) {
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM system_settings WHERE key = ?`, SettingLastResult).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var res UpdateResult
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// CheckAutoRollback reports whether systemd OnFailure auto-rollback should
// proceed. It opens the database read-only without running migrations.
func CheckAutoRollback(ctx context.Context, dataDir string) (bool, *UpdateResult, error) {
	dbPath := filepath.Join(dataDir, mainDBName)
	d, err := openSQLiteNoMigrate(ctx, dbPath, true)
	if err != nil {
		return false, nil, err
	}
	defer d.Close()

	res, err := readLastResultRaw(ctx, d)
	if err != nil || res == nil {
		return false, res, err
	}
	allowed := (res.State == StatePrepared || res.State == StatePending) && res.RollbackCount == 0 && !res.ManualRollback
	return allowed, res, nil
}

func atomicSymlink(linkPath, target string) error {
	tmp, err := os.CreateTemp(filepath.Dir(linkPath), ".sym-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(tmpPath)
	if err := os.Symlink(target, tmpPath); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, linkPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// RunAutoRollback restores the previous binary symlink and pre-upgrade database
// backup after an upgraded binary fails to become ready.
func RunAutoRollback(ctx context.Context, dataDir, binDir string) error {
	if err := CheckProcessStopped(dataDir); err != nil {
		return err
	}
	ok, res, err := CheckAutoRollback(ctx, dataDir)
	if err != nil {
		return err
	}
	if !ok || res == nil {
		return errors.New("当前不满足自动回退条件")
	}
	if res.PrevBinary == "" {
		return errors.New("升级记录缺少上一版本二进制路径")
	}
	if _, err := os.Stat(res.PrevBinary); err != nil {
		return fmt.Errorf("上一版本二进制不可用：%w", err)
	}
	if res.BackupFile == "" {
		return errors.New("升级记录缺少升级前数据库备份路径")
	}
	if _, err := os.Stat(res.BackupFile); err != nil {
		return fmt.Errorf("升级前数据库备份不可用：%w", err)
	}

	linkPath := filepath.Join(binDir, "nomad-deck")
	if err := atomicSymlink(linkPath, res.PrevBinary); err != nil {
		return fmt.Errorf("切换回上一版本软链失败：%w", err)
	}
	dbPath := filepath.Join(dataDir, mainDBName)
	if err := RestoreDatabaseFile(res.BackupFile, dbPath); err != nil {
		return fmt.Errorf("恢复升级前数据库失败：%w", err)
	}

	d, err := openSQLiteNoMigrate(ctx, dbPath, false)
	if err != nil {
		return fmt.Errorf("打开恢复后的数据库失败：%w", err)
	}
	defer d.Close()

	now := time.Now().UTC()
	nowStr := db.FormatTime(now)
	msg := fmt.Sprintf("新版本 %s 启动失败，已自动回退到 %s", res.ToVersion, res.FromVersion)
	res.State = StateRolledBack
	res.RollbackCount++
	res.ErrorMessage = msg
	res.UpdatedAt = now
	res.FinishedAt = &now
	rj, _ := json.Marshal(res)

	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := db.PutSetting(ctx, tx, SettingLastResult, string(rj), false, nowStr); err != nil {
		_ = tx.Rollback()
		return err
	}
	if res.TaskID != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE operation_tasks SET status = ?, error_message = ?, finished_at = ? WHERE id = ?`,
			db.TaskRolledBack, msg, nowStr, res.TaskID); err != nil {
			_ = tx.Rollback()
			return err
		}
		_, _ = tx.ExecContext(ctx, `UPDATE operation_task_steps SET status = ?, error_message = ?, finished_at = ? WHERE task_id = ? AND status = 'running'`,
			db.TaskFailed, msg, nowStr, res.TaskID)
	}
	var schedJSON string
	if err := tx.QueryRowContext(ctx, `SELECT value FROM system_settings WHERE key = ?`, SettingSchedule).Scan(&schedJSON); err == nil && schedJSON != "" {
		var sc Schedule
		if json.Unmarshal([]byte(schedJSON), &sc) == nil && sc.Status == SchedUpgrading && (res.TaskID == "" || sc.TaskID == res.TaskID) {
			sc.Status = SchedFailed
			sc.Message = msg
			sc.NextCheckAt = nil
			sc.FinishedAt = &now
			if sb, err := json.Marshal(&sc); err == nil {
				_ = db.PutSetting(ctx, tx, SettingSchedule, string(sb), false, nowStr)
			}
		}
	}
	sumJSON, _ := json.Marshal(map[string]any{
		"from_version": res.FromVersion, "to_version": res.ToVersion, "backup_file": filepath.Base(res.BackupFile),
	})
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_logs (id, actor_id, actor_name, action, resource_type, resource_name, request_summary_json, operation_task_id, result, error_message, created_at)
		VALUES (?, 'system', 'system', 'system.self_update_auto_rollback', 'control_plane', 'self', ?, ?, 'success', ?, ?)`,
		db.NewID(), string(sumJSON), res.TaskID, msg, nowStr)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// RunBackupRollback restores a specific pre-upgrade database backup file and
// switches bin/nomad-deck back to bin/nomad-deck.prev when present.
func RunBackupRollback(ctx context.Context, dataDir, binDir, backupFile string) error {
	if err := CheckProcessStopped(dataDir); err != nil {
		return err
	}
	bd, err := openSQLiteNoMigrate(ctx, backupFile, true)
	if err != nil {
		return fmt.Errorf("无法作为 SQLite 打开备份文件：%w", err)
	}
	var tbl string
	err = bd.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`).Scan(&tbl)
	bd.Close()
	if err != nil {
		return fmt.Errorf("备份文件不是有效的数据库：%w", err)
	}

	dbPath := filepath.Join(dataDir, mainDBName)
	if err := RestoreDatabaseFile(backupFile, dbPath); err != nil {
		return err
	}
	if binDir != "" {
		prevLink := filepath.Join(binDir, "nomad-deck.prev")
		if target, err := os.Readlink(prevLink); err == nil {
			if !filepath.IsAbs(target) {
				target = filepath.Join(binDir, target)
			}
			if _, err := os.Stat(target); err == nil {
				_ = atomicSymlink(filepath.Join(binDir, "nomad-deck"), filepath.Clean(target))
			}
		}
	}

	d, err := openSQLiteNoMigrate(ctx, dbPath, false)
	if err != nil {
		return err
	}
	defer d.Close()
	now := time.Now().UTC()
	nowStr := db.FormatTime(now)
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if cur, _ := readLastResultRaw(ctx, tx); cur != nil && (cur.State == StatePrepared || cur.State == StatePending || cur.State == StateAnomaly) {
		cur.State = StateRolledBack
		cur.ErrorMessage = "已通过本机命令恢复升级前备份：" + filepath.Base(backupFile)
		cur.UpdatedAt = now
		cur.FinishedAt = &now
		rj, _ := json.Marshal(cur)
		_ = db.PutSetting(ctx, tx, SettingLastResult, string(rj), false, nowStr)
		if cur.TaskID != "" {
			_, _ = tx.ExecContext(ctx, `UPDATE operation_tasks SET status = ?, error_message = ?, finished_at = ? WHERE id = ?`,
				db.TaskRolledBack, cur.ErrorMessage, nowStr, cur.TaskID)
		}
	}
	backupMsg := "已通过本机命令恢复升级前备份：" + filepath.Base(backupFile)
	_, _ = tx.ExecContext(ctx, `UPDATE operation_task_steps SET status = 'interrupted', error_message = ?, finished_at = ? WHERE status = 'running' AND task_id IN (SELECT id FROM operation_tasks WHERE action = 'system.self_update' AND status IN ('pending', 'running'))`,
		backupMsg, nowStr)
	_, _ = tx.ExecContext(ctx, `UPDATE operation_tasks SET status = ?, error_message = ?, finished_at = ? WHERE action = 'system.self_update' AND status IN ('pending', 'running')`,
		db.TaskRolledBack, backupMsg, nowStr)
	sumJSON, _ := json.Marshal(map[string]any{"backup_file": filepath.Base(backupFile)})
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_logs (id, actor_id, actor_name, action, resource_type, resource_name, request_summary_json, result, created_at)
		VALUES (?, 'local', 'local-cli', 'system.manual_rollback_backup', 'control_plane', 'self', ?, 'success', ?)`,
		db.NewID(), string(sumJSON), nowStr)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}
