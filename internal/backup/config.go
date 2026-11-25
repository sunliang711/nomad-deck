// Package backup manages scheduled and manual control-plane disaster
// recovery bundles (.ndbundle) and offsite Raft snapshot archives across
// local, SFTP and S3-compatible targets.
package backup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	"strings"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/migration"
	"nomad-deck/internal/sshx"
	"nomad-deck/internal/vaultbackup"
)

// System settings keys for control-plane disaster recovery.
const (
	SettingEnabled          = "backup.enabled"
	SettingPassphrase       = "backup.passphrase"
	SettingTargets          = "backup.targets"
	SettingIncludeHistory   = "backup.include_history"
	SettingOffsiteSnapshots = "backup.offsite_snapshots"
)

// Target types.
const (
	TargetLocal = "local"
	TargetSFTP  = "sftp"
	TargetS3    = "s3"
)

// Default retention limits.
const (
	DefaultRetentionCount         = 14
	DefaultSnapshotRetentionCount = 7
)

// Target describes one backup destination. SecretAccessKey is encrypted at
// rest inside the secret system setting backup.targets.
type Target struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Type                   string `json:"type"` // local | sftp | s3
	Enabled                bool   `json:"enabled"`
	RetentionCount         int    `json:"retention_count"`
	SnapshotRetentionCount int    `json:"snapshot_retention_count"`

	// Local directory target.
	Path string `json:"path,omitempty"`

	// SFTP target (reuses ssh_keys).
	Host               string `json:"host,omitempty"`
	Port               int    `json:"port,omitempty"`
	Username           string `json:"username,omitempty"`
	SSHKeyID           string `json:"ssh_key_id,omitempty"`
	HostKeyFingerprint string `json:"host_key_fingerprint,omitempty"`
	RemoteDir          string `json:"remote_dir,omitempty"`

	// S3-compatible target.
	Endpoint        string `json:"endpoint,omitempty"`
	Region          string `json:"region,omitempty"`
	Bucket          string `json:"bucket,omitempty"`
	Prefix          string `json:"prefix,omitempty"`
	AccessKeyID     string `json:"access_key_id,omitempty"`
	SecretAccessKey string `json:"secret_access_key,omitempty"`
	UseSSL          bool   `json:"use_ssl,omitempty"`
	PathStyle       bool   `json:"path_style,omitempty"`
}

// TargetView is the API representation of a Target without plaintext secrets.
type TargetView struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Type                   string `json:"type"`
	Enabled                bool   `json:"enabled"`
	RetentionCount         int    `json:"retention_count"`
	SnapshotRetentionCount int    `json:"snapshot_retention_count"`
	Path                   string `json:"path,omitempty"`
	Host                   string `json:"host,omitempty"`
	Port                   int    `json:"port,omitempty"`
	Username               string `json:"username,omitempty"`
	SSHKeyID               string `json:"ssh_key_id,omitempty"`
	HostKeyFingerprint     string `json:"host_key_fingerprint,omitempty"`
	RemoteDir              string `json:"remote_dir,omitempty"`
	Endpoint               string `json:"endpoint,omitempty"`
	Region                 string `json:"region,omitempty"`
	Bucket                 string `json:"bucket,omitempty"`
	Prefix                 string `json:"prefix,omitempty"`
	AccessKeyID            string `json:"access_key_id,omitempty"`
	SecretAccessKeySet     bool   `json:"secret_access_key_set"`
	UseSSL                 bool   `json:"use_ssl,omitempty"`
	PathStyle              bool   `json:"path_style,omitempty"`
}

// TargetInput is the API write payload for a backup target.
type TargetInput struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Type                   string  `json:"type"`
	Enabled                bool    `json:"enabled"`
	RetentionCount         int     `json:"retention_count"`
	SnapshotRetentionCount int     `json:"snapshot_retention_count"`
	Path                   string  `json:"path"`
	Host                   string  `json:"host"`
	Port                   int     `json:"port"`
	Username               string  `json:"username"`
	SSHKeyID               string  `json:"ssh_key_id"`
	HostKeyFingerprint     string  `json:"host_key_fingerprint"`
	RemoteDir              string  `json:"remote_dir"`
	Endpoint               string  `json:"endpoint"`
	Region                 string  `json:"region"`
	Bucket                 string  `json:"bucket"`
	Prefix                 string  `json:"prefix"`
	AccessKeyID            string  `json:"access_key_id"`
	SecretAccessKey        *string `json:"secret_access_key"`
	UseSSL                 bool    `json:"use_ssl"`
	PathStyle              bool    `json:"path_style"`
}

// ConfigView is the API representation of backup configuration.
type ConfigView struct {
	Enabled              bool         `json:"enabled"`
	PassphraseSet        bool         `json:"passphrase_set"`
	IncludeHistory       []string     `json:"include_history"`
	Targets              []TargetView `json:"targets"`
	OffsiteTargetCount   int          `json:"offsite_target_count"`
	MissingOffsiteTarget bool         `json:"missing_offsite_target"`
}

// ConfigInput updates backup configuration.
type ConfigInput struct {
	Enabled        bool          `json:"enabled"`
	Passphrase     *string       `json:"passphrase"`
	IncludeHistory []string      `json:"include_history"`
	Targets        []TargetInput `json:"targets"`
}

// storedConfig is the decrypted internal backup configuration.
type storedConfig struct {
	Enabled        bool
	Passphrase     string
	IncludeHistory []string
	Targets        []Target
}

func badRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}

func newTargetID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "tgt_" + hex.EncodeToString(b)
}

func (t Target) view() TargetView {
	return TargetView{
		ID: t.ID, Name: t.Name, Type: t.Type, Enabled: t.Enabled,
		RetentionCount: t.RetentionCount, SnapshotRetentionCount: t.SnapshotRetentionCount,
		Path: t.Path, Host: t.Host, Port: t.Port, Username: t.Username, SSHKeyID: t.SSHKeyID,
		HostKeyFingerprint: t.HostKeyFingerprint, RemoteDir: t.RemoteDir,
		Endpoint: t.Endpoint, Region: t.Region, Bucket: t.Bucket, Prefix: t.Prefix,
		AccessKeyID: t.AccessKeyID, SecretAccessKeySet: t.SecretAccessKey != "",
		UseSSL: t.UseSSL, PathStyle: t.PathStyle,
	}
}

func (t Target) isOffsite() bool {
	return t.Enabled && (t.Type == TargetSFTP || t.Type == TargetS3)
}

func (s *Service) defaultLocalDir() string {
	return filepath.Join(s.DataDir, "backups", "scheduled")
}

func (s *Service) loadConfig(ctx context.Context) (*storedConfig, error) {
	cfg := &storedConfig{IncludeHistory: []string{}, Targets: []Target{}}
	_ = db.GetSettingJSON(ctx, s.DB.Reader, SettingEnabled, &cfg.Enabled)
	_ = db.GetSettingJSON(ctx, s.DB.Reader, SettingIncludeHistory, &cfg.IncludeHistory)
	if cfg.IncludeHistory == nil {
		cfg.IncludeHistory = []string{}
	}
	if ct, _, err := db.GetSetting(ctx, s.DB.Reader, SettingPassphrase); err == nil && ct != "" {
		pt, err := s.Keys.DecryptString(ct, db.SettingAAD(SettingPassphrase))
		if err != nil {
			return nil, fmt.Errorf("decrypt backup passphrase: %w", err)
		}
		cfg.Passphrase = pt
	} else if err != nil && !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	if ct, _, err := db.GetSetting(ctx, s.DB.Reader, SettingTargets); err == nil && ct != "" {
		pt, err := s.Keys.DecryptString(ct, db.SettingAAD(SettingTargets))
		if err != nil {
			return nil, fmt.Errorf("decrypt backup targets: %w", err)
		}
		if err := json.Unmarshal([]byte(pt), &cfg.Targets); err != nil {
			return nil, fmt.Errorf("decode backup targets: %w", err)
		}
	} else if err != nil && !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	if cfg.Targets == nil {
		cfg.Targets = []Target{}
	}
	return cfg, nil
}

func (s *Service) buildConfigView(cfg *storedConfig) ConfigView {
	tv := make([]TargetView, 0, len(cfg.Targets))
	offsite := 0
	for _, t := range cfg.Targets {
		tv = append(tv, t.view())
		if t.isOffsite() {
			offsite++
		}
	}
	return ConfigView{
		Enabled:              cfg.Enabled,
		PassphraseSet:        cfg.Passphrase != "",
		IncludeHistory:       cfg.IncludeHistory,
		Targets:              tv,
		OffsiteTargetCount:   offsite,
		MissingOffsiteTarget: offsite == 0,
	}
}

// GetConfig returns the backup configuration without exposing secrets.
func (s *Service) GetConfig(ctx context.Context) (ConfigView, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return ConfigView{}, err
	}
	return s.buildConfigView(cfg), nil
}

// SaveConfig validates, encrypts and saves backup configuration.
func (s *Service) SaveConfig(ctx context.Context, actor audit.Actor, in ConfigInput) (ConfigView, error) {
	existing, err := s.loadConfig(ctx)
	if err != nil {
		return ConfigView{}, err
	}
	prevByID := map[string]Target{}
	for _, t := range existing.Targets {
		prevByID[t.ID] = t
	}
	passphrase := existing.Passphrase
	passChanged := false
	if in.Passphrase != nil {
		passphrase = *in.Passphrase
		passChanged = true
		if passphrase != "" && len(passphrase) < vaultbackup.MinPassphrase {
			return ConfigView{}, badRequest("备份口令至少 %d 个字符", vaultbackup.MinPassphrase)
		}
	}

	include, err := validateIncludeHistory(in.IncludeHistory)
	if err != nil {
		return ConfigView{}, err
	}

	seenNames := map[string]bool{}
	seenIDs := map[string]bool{}
	targets := make([]Target, 0, len(in.Targets))
	enabledCount := 0
	for _, ti := range in.Targets {
		t, err := s.resolveTargetInput(ctx, ti, prevByID)
		if err != nil {
			return ConfigView{}, err
		}
		if seenNames[t.Name] {
			return ConfigView{}, badRequest("备份目标名称重复：%s", t.Name)
		}
		seenNames[t.Name] = true
		if seenIDs[t.ID] {
			return ConfigView{}, badRequest("备份目标 ID 重复：%s", t.ID)
		}
		seenIDs[t.ID] = true
		if t.Enabled {
			enabledCount++
		}
		targets = append(targets, t)
	}

	if in.Enabled {
		if len(passphrase) < vaultbackup.MinPassphrase {
			return ConfigView{}, badRequest("启用定时灾备前需设置至少 %d 个字符的备份口令", vaultbackup.MinPassphrase)
		}
		if enabledCount == 0 {
			return ConfigView{}, badRequest("启用定时灾备前需至少启用一个备份目标")
		}
	}

	targetsJSON, err := json.Marshal(targets)
	if err != nil {
		return ConfigView{}, err
	}
	encTargets, err := s.Keys.EncryptString(string(targetsJSON), db.SettingAAD(SettingTargets))
	if err != nil {
		return ConfigView{}, err
	}
	encPass := ""
	if passphrase != "" {
		encPass, err = s.Keys.EncryptString(passphrase, db.SettingAAD(SettingPassphrase))
		if err != nil {
			return ConfigView{}, err
		}
	}

	err = s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		now := s.DB.NowString()
		if err := db.PutSettingJSON(ctx, tx, SettingEnabled, in.Enabled, now); err != nil {
			return err
		}
		if err := db.PutSettingJSON(ctx, tx, SettingIncludeHistory, include, now); err != nil {
			return err
		}
		if err := db.PutSetting(ctx, tx, SettingPassphrase, encPass, true, now); err != nil {
			return err
		}
		if err := db.PutSetting(ctx, tx, SettingTargets, encTargets, true, now); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{
			Actor:        actor,
			Action:       "backup.config_update",
			ResourceType: "settings",
			ResourceName: "backup",
			Summary: map[string]any{
				"enabled":            in.Enabled,
				"include_history":    include,
				"target_count":       len(targets),
				"passphrase_changed": passChanged,
			},
		})
	})
	if err != nil {
		return ConfigView{}, err
	}
	return s.GetConfig(ctx)
}

func validateIncludeHistory(in []string) ([]string, error) {
	allowed := map[string]bool{}
	for _, t := range migration.OptionalTables {
		if t != "admins" {
			allowed[t] = true
		}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, t := range in {
		if !allowed[t] {
			return nil, badRequest("不支持的可选历史表：%s", t)
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *Service) resolveTargetInput(ctx context.Context, ti TargetInput, prevByID map[string]Target) (Target, error) {
	name := strings.TrimSpace(ti.Name)
	if name == "" || len(name) > 64 {
		return Target{}, badRequest("备份目标名称需为 1～64 个字符")
	}
	id := strings.TrimSpace(ti.ID)
	if id == "" {
		id = newTargetID()
	}
	ret := ti.RetentionCount
	if ret == 0 {
		ret = DefaultRetentionCount
	}
	if ret < 1 || ret > 365 {
		return Target{}, badRequest("目标 %s 的灾备包保留份数需在 1～365 之间", name)
	}
	snapRet := ti.SnapshotRetentionCount
	if snapRet == 0 {
		snapRet = DefaultSnapshotRetentionCount
	}
	if snapRet < 1 || snapRet > 365 {
		return Target{}, badRequest("目标 %s 的快照保留份数需在 1～365 之间", name)
	}

	t := Target{
		ID: id, Name: name, Type: ti.Type, Enabled: ti.Enabled,
		RetentionCount: ret, SnapshotRetentionCount: snapRet,
	}
	switch ti.Type {
	case TargetLocal:
		p := strings.TrimSpace(ti.Path)
		if p == "" {
			p = s.defaultLocalDir()
		}
		if err := sshx.ValidPath(p); err != nil {
			return Target{}, badRequest("本机备份目录需为不含 .. 的绝对路径：%v", err)
		}
		t.Path = filepath.Clean(p)
	case TargetSFTP:
		host := strings.TrimSpace(ti.Host)
		user := strings.TrimSpace(ti.Username)
		keyID := strings.TrimSpace(ti.SSHKeyID)
		rdir := strings.TrimSpace(ti.RemoteDir)
		port := ti.Port
		if port == 0 {
			port = 22
		}
		if host == "" || strings.ContainsAny(host, " \t\r\n/") {
			return Target{}, badRequest("SFTP 目标 %s 主机地址不合法", name)
		}
		if port < 1 || port > 65535 {
			return Target{}, badRequest("SFTP 目标 %s 端口不合法", name)
		}
		if user == "" {
			return Target{}, badRequest("SFTP 目标 %s 需指定用户名", name)
		}
		if keyID == "" {
			return Target{}, badRequest("SFTP 目标 %s 需指定 SSH 密钥", name)
		}
		if _, err := db.GetSSHKey(ctx, s.DB.Reader, keyID); err != nil {
			if errors.Is(err, db.ErrNotFound) {
				return Target{}, badRequest("SFTP 目标 %s 引用的 SSH 密钥不存在", name)
			}
			return Target{}, err
		}
		if rdir == "" {
			rdir = "/var/backups/nomad-deck"
		}
		if err := sshx.ValidPath(rdir); err != nil {
			return Target{}, badRequest("SFTP 目标 %s 远端目录不合法：%v", name, err)
		}
		t.Host = host
		t.Port = port
		t.Username = user
		t.SSHKeyID = keyID
		t.HostKeyFingerprint = strings.TrimSpace(ti.HostKeyFingerprint)
		t.RemoteDir = path.Clean(rdir)
	case TargetS3:
		ep := strings.TrimSpace(ti.Endpoint)
		bucket := strings.TrimSpace(ti.Bucket)
		ak := strings.TrimSpace(ti.AccessKeyID)
		region := strings.TrimSpace(ti.Region)
		if region == "" {
			region = "us-east-1"
		}
		if ep == "" {
			return Target{}, badRequest("S3 目标 %s 需指定 Endpoint", name)
		}
		if _, _, err := parseS3Endpoint(ep, ti.UseSSL); err != nil {
			return Target{}, badRequest("S3 目标 %s Endpoint 不合法：%v", name, err)
		}
		if bucket == "" || strings.ContainsAny(bucket, " /\\") {
			return Target{}, badRequest("S3 目标 %s Bucket 名称不合法", name)
		}
		if ak == "" {
			return Target{}, badRequest("S3 目标 %s 需指定 Access Key ID", name)
		}
		sk := ""
		if ti.SecretAccessKey != nil {
			sk = *ti.SecretAccessKey
		} else if prev, ok := prevByID[id]; ok {
			sk = prev.SecretAccessKey
		}
		if sk == "" {
			return Target{}, badRequest("S3 目标 %s 需提供 Secret Access Key", name)
		}
		prefix := strings.Trim(path.Clean("/"+strings.TrimSpace(ti.Prefix)), "/")
		if prefix == "." {
			prefix = ""
		}
		t.Endpoint = ep
		t.Region = region
		t.Bucket = bucket
		t.Prefix = prefix
		t.AccessKeyID = ak
		t.SecretAccessKey = sk
		t.UseSSL = ti.UseSSL
		t.PathStyle = ti.PathStyle
		if strings.HasPrefix(strings.ToLower(ep), "https://") {
			t.UseSSL = true
		} else if strings.HasPrefix(strings.ToLower(ep), "http://") {
			t.UseSSL = false
		}
	default:
		return Target{}, badRequest("不支持的备份目标类型：%s", ti.Type)
	}
	return t, nil
}

func parseS3Endpoint(raw string, defaultSSL bool) (host string, useSSL bool, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", defaultSSL, errors.New("endpoint is empty")
	}
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Host == "" {
			return "", defaultSSL, errors.New("invalid URL")
		}
		switch strings.ToLower(u.Scheme) {
		case "https":
			return u.Host, true, nil
		case "http":
			return u.Host, false, nil
		default:
			return "", defaultSSL, fmt.Errorf("unsupported scheme %q", u.Scheme)
		}
	}
	if strings.ContainsAny(s, "/?# ") {
		return "", defaultSSL, errors.New("endpoint must be host[:port] or http(s) URL")
	}
	return s, defaultSSL, nil
}
