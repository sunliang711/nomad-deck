package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"nomad-deck/internal/db"
)

var reSafeVer = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func sanitizeVer(v string) string {
	s := reSafeVer.ReplaceAllString(strings.TrimSpace(v), "_")
	if s == "" {
		return "unknown"
	}
	return s
}

// BackupDatabase writes a consistent online SQLite backup to
// <dataDir>/backups/pre-upgrade-<from>-<to>-<timestamp>.db with mode 0600.
func BackupDatabase(ctx context.Context, d *db.DB, dataDir, fromVer, toVer string) (string, error) {
	dir := filepath.Join(dataDir, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	ts := d.Now().UTC().Format("20060102T150405Z")
	name := fmt.Sprintf("pre-upgrade-%s-%s-%s.db", sanitizeVer(fromVer), sanitizeVer(toVer), ts)
	dest := filepath.Join(dir, name)
	tmp := dest + ".tmp"
	_ = os.Remove(tmp)
	if strings.ContainsRune(tmp, 0) {
		return "", errors.New("invalid backup path")
	}
	escaped := strings.ReplaceAll(tmp, "'", "''")
	if _, err := d.Writer.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", escaped)); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("在线备份数据库失败：%w", err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dest, nil
}

// PrunePreUpgradeBackups keeps the newest keep pre-upgrade-*.db files.
func PrunePreUpgradeBackups(dataDir string, keep int) int {
	if keep <= 0 {
		keep = defaultBackupRetention
	}
	dir := filepath.Join(dataDir, "backups")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	type item struct {
		name string
		mod  int64
	}
	var files []item
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasPrefix(n, "pre-upgrade-") && strings.HasSuffix(n, ".db") {
			var mod int64
			if fi, err := e.Info(); err == nil {
				mod = fi.ModTime().UnixNano()
			}
			files = append(files, item{name: n, mod: mod})
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].mod != files[j].mod {
			return files[i].mod > files[j].mod
		}
		return files[i].name > files[j].name
	})
	deleted := 0
	for i := keep; i < len(files); i++ {
		if os.Remove(filepath.Join(dir, files[i].name)) == nil {
			deleted++
		}
	}
	return deleted
}

// RestoreDatabaseFile atomically replaces dbPath with backupPath and cleans
// stale WAL/SHM sidecar files.
func RestoreDatabaseFile(backupPath, dbPath string) error {
	fi, err := os.Stat(backupPath)
	if err != nil {
		return fmt.Errorf("无法读取备份数据库 %s：%w", backupPath, err)
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("备份路径不是普通文件：%s", backupPath)
	}
	src, err := os.Open(backupPath)
	if err != nil {
		return err
	}
	defer src.Close()

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return err
	}
	tmp := dbPath + ".restore.tmp"
	dst, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Remove(dbPath + "-wal")
	_ = os.Remove(dbPath + "-shm")
	if err := os.Rename(tmp, dbPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
