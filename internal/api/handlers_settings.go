package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
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

var reDockerVer = regexp.MustCompile(`^[0-9]+(\.[0-9]+){1,2}(-[A-Za-z0-9._-]+)?$`)

func optHTTPURL(raw json.RawMessage) (any, error) {
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
}

func optProductVersion(raw json.RawMessage) (any, error) {
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, errors.New("需为字符串")
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return v, nil
	}
	if strings.EqualFold(v, "latest") {
		return "latest", nil
	}
	if err := sshx.ValidVersion(v); err != nil {
		return nil, err
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
	"snapshot.retention_count":    {Default: 7, Validate: intRange(1, 365)},
	"cert.alert_days":             {Default: 30, Validate: intRange(1, 365)},
	"upgrade.max_minor_skip":      {Default: 2, Validate: intRange(0, 10)},
	"defaults.nomad_version":      {Default: "", Validate: optProductVersion},
	"defaults.vault_version":      {Default: "", Validate: optProductVersion},
	"defaults.docker_version": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v != "" && !reDockerVer.MatchString(v) {
			return nil, errors.New("Docker 版本号格式不合法")
		}
		return v, nil
	}},
	"nomad.stats_interval_seconds": {Default: 2, Validate: intRange(1, 60)},
	"nomad.exec_idle_minutes":      {Default: 15, Validate: intRange(1, 240)},
	"nomad.exec_max_minutes":       {Default: 240, Validate: intRange(5, 1440)},
	"observability.grafana_url_template": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v == "" {
			return v, nil
		}
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, errors.New("需为 http(s) 地址模板")
		}
		return v, nil
	}},
	"snapshot.dir": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v == "" {
			return v, nil
		}
		if err := sshx.ValidPath(v); err != nil {
			return nil, errors.New("快照目录需为不含 .. 的绝对路径")
		}
		return v, nil
	}},
	"docker.test_image": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if len(v) > 200 || strings.ContainsAny(v, " \t\r\n\x00") {
			return nil, errors.New("测试镜像格式不合法")
		}
		return v, nil
	}},
	"self_update.channel": {Default: "stable", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v != "stable" && v != "prerelease" {
			return nil, errors.New("channel 需为 stable 或 prerelease")
		}
		return v, nil
	}},
	"self_update.backup_retention":   {Default: 3, Validate: intRange(1, 20)},
	netx.SettingUseForReleases:       {Default: false, Validate: boolVal},
	netx.SettingUseForNomad:          {Default: false, Validate: boolVal},
	netx.SettingUseForVault:          {Default: false, Validate: boolVal},
	netx.SettingUseForDockerInstall:  {Default: false, Validate: boolVal},
	netx.SettingUseForDockerPull:     {Default: false, Validate: boolVal},
	netx.SettingUseForSelfUpdate:     {Default: false, Validate: boolVal},
	"release.mirror_url":           {Default: "", Validate: optHTTPURL},
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
	"release.docker_pgp_public_key": {Default: "", Validate: func(raw json.RawMessage) (any, error) {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, errors.New("需为字符串")
		}
		if v != "" {
			if _, err := (&release.Docker{ArmoredKeys: v}).Keyring(); err != nil {
				return nil, errors.New("Docker PGP 公钥无法解析")
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
	missing := map[string]bool{}
	for k, def := range settingDefs {
		raw, _, err := db.GetSetting(ctx, a.DB.Reader, k)
		if err != nil {
			out[k] = def.Default
			missing[k] = true
			continue
		}
		var v any
		if json.Unmarshal([]byte(raw), &v) != nil {
			v = def.Default
		}
		out[k] = v
	}
	for _, k := range []string{netx.SettingUseForNomad, netx.SettingUseForVault, netx.SettingUseForDockerInstall} {
		if missing[k] {
			out[k] = out[netx.SettingUseForReleases]
		}
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
	proxyKeys := []string{
		netx.SettingUseForReleases,
		netx.SettingUseForNomad,
		netx.SettingUseForVault,
		netx.SettingUseForDockerInstall,
		netx.SettingUseForDockerPull,
		netx.SettingUseForSelfUpdate,
	}
	anyProxy := false
	for _, k := range proxyKeys {
		if vals[k] == true {
			anyProxy = true
			break
		}
	}
	if anyProxy {
		cfg, _, err := a.Proxy.Load(r.Context())
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		if cfg == nil || cfg.Host == "" {
			writeError(w, http.StatusBadRequest, "proxy_not_configured", "尚未配置系统代理，请先配置系统代理")
			return
		}
		if vals[netx.SettingUseForDockerPull] == true && cfg.Type == "socks5" {
			writeError(w, http.StatusBadRequest, "invalid_argument", "系统代理为 SOCKS5，Docker 镜像拉取代理需要 HTTP(S) 代理")
			return
		}
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
	if _, ok := vals["cron.timezone"]; ok && a.Cron != nil {
		a.Cron.Reschedule(r.Context())
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
		if !in.Enabled {
			now := a.DB.NowString()
			for _, k := range []string{
				netx.SettingUseForReleases,
				netx.SettingUseForNomad,
				netx.SettingUseForVault,
				netx.SettingUseForDockerInstall,
				netx.SettingUseForDockerPull,
				netx.SettingUseForSelfUpdate,
			} {
				if err := db.PutSettingJSON(r.Context(), tx, k, false, now); err != nil {
					return err
				}
			}
		} else if cfg != nil && cfg.Type == "socks5" {
			if err := db.PutSettingJSON(r.Context(), tx, netx.SettingUseForDockerPull, false, a.DB.NowString()); err != nil {
				return err
			}
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

func (a *API) revealProxyPassword(w http.ResponseWriter, r *http.Request) {
	_, password, err := a.Proxy.Load(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	_ = a.Auth.Audit.Record(r.Context(), nil, audit.Event{
		Actor: a.actor(r), Action: "settings.proxy_password_reveal",
		ResourceType: "settings", ResourceName: "proxy",
	})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"password": password})
}

// ---- Releases ----

func (a *API) syncDockerProxy(w http.ResponseWriter, r *http.Request) {
	if a.Nomad == nil {
		writeJSON(w, http.StatusOK, map[string]any{"task_ids": []string{}, "count": 0})
		return
	}
	taskIDs, err := a.Nomad.SyncDockerSystemProxy(r.Context(), a.actor(r))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task_ids": taskIDs, "count": len(taskIDs)})
}

func (a *API) listReleases(w http.ResponseWriter, r *http.Request) {
	product := chi.URLParam(r, "product")
	settingKey := netx.SettingUseForReleases
	switch product {
	case "nomad":
		settingKey = netx.SettingUseForNomad
	case "vault":
		settingKey = netx.SettingUseForVault
	case "docker":
		settingKey = netx.SettingUseForDockerInstall
	}
	useProxy := a.Proxy.UseByDefault(r.Context(), settingKey)
	if v := r.URL.Query().Get("use_proxy"); v != "" {
		useProxy = v == "true"
	}
	switch product {
	case "cni":
		writeJSON(w, http.StatusOK, map[string]any{"product": product, "versions": a.Releases.CNI(r.Context()).Versions()})
		return
	case "nomad", "vault", "docker":
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
	if product == "docker" {
		a.listDockerReleases(w, r, client, useProxy)
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

// listDockerReleases lists Docker Engine versions from the verified
// repository metadata matching a host (node_id) or an explicit repository
// (distro, release, arch).
func (a *API) listDockerReleases(w http.ResponseWriter, r *http.Request, client *http.Client, useProxy bool) {
	q := r.URL.Query()
	var target release.DockerTarget
	if id := q.Get("node_id"); id != "" {
		n, err := db.GetNode(r.Context(), a.DB.Reader, id)
		if errors.Is(err, db.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "主机不存在")
			return
		}
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		var probe struct {
			Raw map[string]string `json:"raw"`
		}
		_ = json.Unmarshal([]byte(n.ProbeJSON), &probe)
		if len(probe.Raw) == 0 {
			writeError(w, http.StatusConflict, "node_not_probed", "主机尚未完成连通性测试，无法确定 Docker 仓库")
			return
		}
		if target, err = release.DockerTargetFromProbe(probe.Raw, n.Arch); err != nil {
			writeError(w, http.StatusBadRequest, "docker_unsupported", err.Error())
			return
		}
	} else {
		target = release.DockerTarget{Distro: q.Get("distro"), Release: q.Get("release"), Arch: q.Get("arch")}
		target.Format = map[string]string{"ubuntu": "deb", "debian": "deb", "centos": "rpm", "rhel": "rpm", "fedora": "rpm"}[target.Distro]
		if err := target.Validate(); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", "需提供 node_id，或 distro/release/arch："+err.Error())
			return
		}
	}
	ix, err := a.Releases.Docker(r.Context()).Index(r.Context(), client, target, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "release_fetch_failed", "获取 Docker 版本列表失败："+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"product": "docker", "target": target, "versions": ix.EngineVersions(),
		"used_proxy": useProxy})
}

// ---- Master key & rotation ----

func (a *API) getMasterKeyStatus(w http.ResponseWriter, r *http.Request) {
	if a.Rotation == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "主密钥轮换服务未启用")
		return
	}
	st, err := a.Rotation.Status(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"master_key": st})
}

func (a *API) rotateMasterKey(w http.ResponseWriter, r *http.Request) {
	if a.Rotation == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "主密钥轮换服务未启用")
		return
	}
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	jv, err := a.Rotation.Start(r.Context(), a.actor(r))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"rotation": jv})
}

func (a *API) getMasterKeyRotation(w http.ResponseWriter, r *http.Request) {
	if a.Rotation == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "主密钥轮换服务未启用")
		return
	}
	st, err := a.Rotation.Status(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"running":    st.Running,
		"journal":    st.Journal,
		"next_steps": st.NextSteps,
	})
}
