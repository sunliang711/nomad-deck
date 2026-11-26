// Package backup manages scheduled and manual control-plane disaster
// recovery bundles (.ndbundle) and offsite Raft snapshot archives via SafeKeep.
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
	"strings"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/migration"
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
	TargetSafeKeep = "safekeep"
)

// Default retention limits.
const (
	DefaultRetentionCount         = 14
	DefaultSnapshotRetentionCount = 7
)

// Target describes one SafeKeep backup destination. SafeKeepAPIKey is
// encrypted at rest inside the secret system setting backup.targets.
type Target struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Type                   string `json:"type"` // safekeep
	Enabled                bool   `json:"enabled"`
	RetentionCount         int    `json:"retention_count"`
	SnapshotRetentionCount int    `json:"snapshot_retention_count"`

	// SafeKeep API target.
	SafeKeepURL         string `json:"safekeep_url,omitempty"`
	SafeKeepAPIKey      string `json:"safekeep_api_key,omitempty"`
	SafeKeepTargets     string `json:"safekeep_targets,omitempty"`
	SafeKeepSubpath     string `json:"safekeep_subpath,omitempty"`
	SafeKeepMode        string `json:"safekeep_mode,omitempty"`
	SafeKeepInsecureTLS bool   `json:"safekeep_insecure_tls,omitempty"`
}

// TargetView is the API representation of a Target without plaintext secrets.
type TargetView struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	Type                   string `json:"type"`
	Enabled                bool   `json:"enabled"`
	RetentionCount         int    `json:"retention_count"`
	SnapshotRetentionCount int    `json:"snapshot_retention_count"`
	SafeKeepURL            string `json:"safekeep_url,omitempty"`
	SafeKeepAPIKeySet      bool   `json:"safekeep_api_key_set"`
	SafeKeepTargets        string `json:"safekeep_targets,omitempty"`
	SafeKeepSubpath        string `json:"safekeep_subpath,omitempty"`
	SafeKeepMode           string `json:"safekeep_mode,omitempty"`
	SafeKeepInsecureTLS    bool   `json:"safekeep_insecure_tls,omitempty"`
}

// TargetInput is the API write payload for a SafeKeep backup target.
type TargetInput struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Type                   string  `json:"type"`
	Enabled                bool    `json:"enabled"`
	RetentionCount         int     `json:"retention_count"`
	SnapshotRetentionCount int     `json:"snapshot_retention_count"`
	SafeKeepURL            string  `json:"safekeep_url"`
	SafeKeepAPIKey         *string `json:"safekeep_api_key"`
	SafeKeepTargets        string  `json:"safekeep_targets"`
	SafeKeepSubpath        string  `json:"safekeep_subpath"`
	SafeKeepMode           string  `json:"safekeep_mode"`
	SafeKeepInsecureTLS    bool    `json:"safekeep_insecure_tls"`
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
		SafeKeepURL: t.SafeKeepURL, SafeKeepAPIKeySet: t.SafeKeepAPIKey != "",
		SafeKeepTargets: t.SafeKeepTargets, SafeKeepSubpath: t.SafeKeepSubpath,
		SafeKeepMode: t.SafeKeepMode, SafeKeepInsecureTLS: t.SafeKeepInsecureTLS,
	}
}

func (t Target) isOffsite() bool {
	return t.Enabled && t.Type == TargetSafeKeep
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
		var rawTargets []Target
		if err := json.Unmarshal([]byte(pt), &rawTargets); err != nil {
			return nil, fmt.Errorf("decode backup targets: %w", err)
		}
		// Keep only SafeKeep targets; drop legacy non-SafeKeep targets cleanly on load.
		for _, t := range rawTargets {
			if t.Type == TargetSafeKeep {
				cfg.Targets = append(cfg.Targets, t)
			}
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
		if enabledCount == 0 {
			return ConfigView{}, badRequest("启用定时灾备前需至少启用一个 SafeKeep 备份目标")
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
		if err := db.PutSetting(ctx, tx, SettingPassphrase, encPass, encPass != "", now); err != nil {
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

func (s *Service) resolveTargetInput(_ context.Context, ti TargetInput, prevByID map[string]Target) (Target, error) {
	name := strings.TrimSpace(ti.Name)
	if name == "" || len(name) > 64 {
		return Target{}, badRequest("备份目标名称需为 1～64 个字符")
	}
	targetType := strings.TrimSpace(ti.Type)
	if targetType == "" {
		targetType = TargetSafeKeep
	}
	if targetType != TargetSafeKeep {
		return Target{}, badRequest("当前仅支持 SafeKeep 灾备目标（不支持 %s）", targetType)
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

	rawURL := strings.TrimSpace(ti.SafeKeepURL)
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Target{}, badRequest("SafeKeep 目标 %s 服务地址需为合法的 http(s) URL", name)
	}
	apiKey := ""
	if ti.SafeKeepAPIKey != nil {
		apiKey = strings.TrimSpace(*ti.SafeKeepAPIKey)
	} else if prev, ok := prevByID[id]; ok {
		apiKey = prev.SafeKeepAPIKey
	}
	if apiKey == "" {
		return Target{}, badRequest("SafeKeep 目标 %s 需提供 API Key", name)
	}
	mode := strings.ToLower(strings.TrimSpace(ti.SafeKeepMode))
	if mode == "" {
		mode = "sync"
	}
	if mode != "sync" && mode != "async" {
		return Target{}, badRequest("SafeKeep 目标 %s 上传模式需为 sync 或 async", name)
	}
	subpath := strings.Trim(path.Clean("/"+strings.TrimSpace(ti.SafeKeepSubpath)), "/")
	if subpath == "." {
		subpath = ""
	}
	return Target{
		ID:                     id,
		Name:                   name,
		Type:                   TargetSafeKeep,
		Enabled:                ti.Enabled,
		RetentionCount:         ret,
		SnapshotRetentionCount: snapRet,
		SafeKeepURL:            strings.TrimRight(rawURL, "/"),
		SafeKeepAPIKey:         apiKey,
		SafeKeepTargets:        strings.TrimSpace(ti.SafeKeepTargets),
		SafeKeepSubpath:        subpath,
		SafeKeepMode:           mode,
		SafeKeepInsecureTLS:    ti.SafeKeepInsecureTLS,
	}, nil
}
