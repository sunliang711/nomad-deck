package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/release"
)

// settingDef describes one editable, non-secret system setting.
type settingDef struct {
	Default        any
	Validate       func(raw json.RawMessage) (any, error)
	RestartToApply bool
}

func intRange(min, max int) func(json.RawMessage) (any, error) {
	return func(raw json.RawMessage) (any, error) {
		var v int
		if err := json.Unmarshal(raw, &v); err != nil || v < min || v > max {
			return nil, fmt.Errorf("取值范围为 %d～%d 的整数", min, max)
		}
		return v, nil
	}
}

func boolVal(raw json.RawMessage) (any, error) {
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, errors.New("需为布尔值")
	}
	return v, nil
}

var settingDefs = map[string]settingDef{
	"ssh.timeout_sec":             {Default: 15, Validate: intRange(3, 120)},
	"ssh.max_concurrency":         {Default: 10, Validate: intRange(1, 100), RestartToApply: true},
	"release.transfer_rate_limit": {Default: 0, Validate: intRange(0, 1<<30)},
	"auth.session_ttl_hours":      {Default: 12, Validate: intRange(1, 168)},
	"auth.session_idle_minutes":   {Default: 60, Validate: intRange(5, 1440)},
	"audit.retention_days":        {Default: 90, Validate: intRange(7, 3650)},
	"ops.retention_days":          {Default: 60, Validate: intRange(7, 3650)},
	netx.SettingUseForReleases:    {Default: false, Validate: boolVal},
	netx.SettingUseForSelfUpdate:  {Default: false, Validate: boolVal},
	"release.mirror_url": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v == "" {
			return v, nil
		}
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, errors.New("需为 http(s) 地址")
		}
		return strings.TrimRight(v, "/"), nil
	}},
	"release.pgp_public_key": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v != "" {
			if _, err := (&release.HashiCorp{ArmoredKey: v}).Keyring(); err != nil {
				return nil, errors.New("PGP 公钥无法解析")
			}
		}
		return v, nil
	}},
	"release.cni_checksums": {Default: release.CNIChecksums{}, Validate: func(raw json.RawMessage) (any, error) {
		var v release.CNIChecksums
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("格式应为 {版本: {架构: sha256}}")
		}
		if err := release.ValidateCNIChecksums(v); err != nil {
			return nil, err
		}
		return v, nil
	}},
	"cron.timezone": {Default: "UTC", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if _, err := time.LoadLocation(v); err != nil {
			return nil, errors.New("无法识别的时区")
		}
		return v, nil
	}},
}

func (a *API) settingValues(ctx context.Context) map[string]any {
	out := map[string]any{}
	for k, def := range settingDefs {
		raw, _, err := db.GetSetting(ctx, a.DB.Reader, k)
		if err != nil {
			out[k] = def.Default
			continue
		}
		var v any
		if json.Unmarshal([]byte(raw), &v) != nil {
			v = def.Default
		}
		out[k] = v
	}
	return out
}

func (a *API) getSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"settings": a.settingValues(r.Context())})
}

func (a *API) putSettings(w http.ResponseWriter, r *http.Request) {
	var req map[string]json.RawMessage
	if !decodeJSON(w, r, &req) {
		return
	}
	vals := map[string]any{}
	restart := false
	for k, raw := range req {
		def, ok := settingDefs[k]
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_argument", "不支持修改的设置项："+k)
			return
		}
		v, err := def.Validate(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", k+"："+err.Error())
			return
		}
		vals[k] = v
		restart = restart || def.RestartToApply
	}
	err := a.DB.WithTx(r.Context(), func(tx *sql.Tx) error {
		now := a.DB.NowString()
		for k, v := range vals {
			if err := db.PutSettingJSON(r.Context(), tx, k, v, now); err != nil {
				return err
			}
		}
		return a.Auth.Audit.Record(r.Context(), tx, audit.Event{Actor: a.actor(r), Action: "settings.update",
			ResourceType: "settings", Summary: vals})
	})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": a.settingValues(r.Context()), "restart_required": restart})
}

// ---- System proxy ----

type proxyView struct {
	Configured  bool     `json:"configured"`
	Type        string   `json:"type,omitempty"`
	Host        string   `json:"host,omitempty"`
	Port        int      `json:"port,omitempty"`
	Username    string   `json:"username,omitempty"`
	NoProxy     []string `json:"no_proxy"`
	PasswordSet bool     `json:"password_set"`
}

func (a *API) getProxy(w http.ResponseWriter, r *http.Request) {
	cfg, _, err := a.Proxy.Load(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	v := proxyView{NoProxy: []string{}}
	if cfg != nil {
		v = proxyView{Configured: true, Type: cfg.Type, Host: cfg.Host, Port: cfg.Port, Username: cfg.Username,
			NoProxy: cfg.NoProxy, PasswordSet: a.Proxy.PasswordSet(r.Context())}
		if v.NoProxy == nil {
			v.NoProxy = []string{}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"proxy": v})
}

type proxyInput struct {
	Enabled  bool     `json:"enabled"`
	Type     string   `json:"type"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Username string   `json:"username"`
	Password *string  `json:"password"` // null/omitted keeps the stored password
	NoProxy  []string `json:"no_proxy"`
}

func (in proxyInput) config() *netx.ProxyConfig {
	return &netx.ProxyConfig{Type: in.Type, Host: strings.TrimSpace(in.Host), Port: in.Port, Username: in.Username, NoProxy: in.NoProxy}
}

func (a *API) putProxy(w http.ResponseWriter, r *http.Request) {
	var in proxyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	var cfg *netx.ProxyConfig
	if in.Enabled {
		cfg = in.config()
		if err := cfg.Validate(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
	}
	err := a.DB.WithTx(r.Context(), func(tx *sql.Tx) error {
		if err := a.Proxy.Save(r.Context(), tx, cfg, in.Password); err != nil {
			return err
		}
		summary := map[string]any{"enabled": in.Enabled}
		if cfg != nil {
			summary["address"] = cfg.Address()
			summary["username"] = cfg.Username
			summary["no_proxy"] = cfg.NoProxy
			summary["password_changed"] = in.Password != nil
		}
		return a.Auth.Audit.Record(r.Context(), tx, audit.Event{Actor: a.actor(r), Action: "settings.proxy_update",
			ResourceType: "settings", ResourceName: "proxy", Summary: summary})
	})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	a.getProxy(w, r)
}

func (a *API) testProxy(w http.ResponseWriter, r *http.Request) {
	var in proxyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	cfg := in.config()
	if err := cfg.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_argument", err.Error())
		return
	}
	password := ""
	if in.Password != nil {
		password = *in.Password
	} else if _, stored, err := a.Proxy.Load(r.Context()); err == nil {
		password = stored
	}
	var mirror string
	if raw, _, err := db.GetSetting(r.Context(), a.DB.Reader, "release.mirror_url"); err == nil {
		_ = json.Unmarshal([]byte(raw), &mirror)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	rep := netx.TestProxy(ctx, cfg, password, netx.DefaultTestTargets(mirror))
	_ = a.Auth.Audit.Record(r.Context(), nil, audit.Event{Actor: a.actor(r), Action: "settings.proxy_test",
		ResourceType: "settings", ResourceName: "proxy", Summary: map[string]any{"address": cfg.Address(), "exit_ip": rep.ExitIP}})
	writeJSON(w, http.StatusOK, map[string]any{"report": rep})
}

// ---- Releases ----

func (a *API) listReleases(w http.ResponseWriter, r *http.Request) {
	product := chi.URLParam(r, "product")
	useProxy := a.Proxy.UseByDefault(r.Context(), netx.SettingUseForReleases)
	if v := r.URL.Query().Get("use_proxy"); v != "" {
		useProxy = v == "true"
	}
	switch product {
	case "cni":
		writeJSON(w, http.StatusOK, map[string]any{"product": product, "versions": a.Releases.CNI(r.Context()).Versions()})
		return
	case "nomad", "vault":
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的产品")
		return
	}
	client, _, err := a.Proxy.Client(r.Context(), useProxy, 30*time.Second)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		writeError(w, http.StatusBadRequest, "proxy_not_configured", "尚未配置系统代理")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	versions, err := a.Releases.HashiCorp(r.Context()).Versions(r.Context(), client, product)
	if err != nil {
		writeError(w, http.StatusBadGateway, "release_fetch_failed", "获取版本列表失败："+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"product": product, "versions": versions, "min_version": release.MinVersions[product],
		"used_proxy": useProxy})
}
