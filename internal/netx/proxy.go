// Package netx builds outbound HTTP clients for the control plane, applying
// the single system proxy (HTTP, HTTPS or SOCKS5) when a task opts in.
package netx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

// Setting keys.
const (
	SettingProxyConfig      = "proxy.config"
	SettingProxyPassword    = "proxy.password"
	SettingUseForReleases   = "proxy.use_for_releases"
	SettingUseForSelfUpdate = "proxy.use_for_self_update"
)

// ErrProxyNotConfigured is returned when a task asks for the proxy but none is set.
var ErrProxyNotConfigured = errors.New("system proxy is not configured")

// ProxyConfig is the system proxy (the password is stored separately, encrypted).
type ProxyConfig struct {
	Type     string   `json:"type"` // http | https | socks5
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	Username string   `json:"username"`
	NoProxy  []string `json:"no_proxy"`
}

// Validate checks the configuration.
func (c *ProxyConfig) Validate() error {
	switch c.Type {
	case "http", "https", "socks5":
	default:
		return fmt.Errorf("代理类型必须是 http、https 或 socks5")
	}
	if c.Host == "" || strings.ContainsAny(c.Host, "/@ ") {
		return errors.New("代理主机不合法")
	}
	if c.Port <= 0 || c.Port > 65535 {
		return errors.New("代理端口不合法")
	}
	for _, e := range c.NoProxy {
		trimmed := strings.TrimSpace(e)
		if trimmed == "" || strings.ContainsAny(e, " \t\r\n\\") {
			return fmt.Errorf("no_proxy 条目 %q 不合法", e)
		}
		if strings.Contains(trimmed, "/") {
			if _, err := netip.ParsePrefix(trimmed); err != nil {
				return fmt.Errorf("no_proxy CIDR %q 不合法", e)
			}
		}
	}
	return nil
}

// URL returns the proxy URL including credentials.
func (c *ProxyConfig) URL(password string) *url.URL {
	u := &url.URL{Scheme: c.Type, Host: net.JoinHostPort(c.Host, strconv.Itoa(c.Port))}
	if c.Username != "" {
		u.User = url.UserPassword(c.Username, password)
	}
	return u
}

// Address returns the proxy address without credentials (for logs and audit).
func (c *ProxyConfig) Address() string {
	return c.Type + "://" + net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

// Manager loads and stores the proxy settings and builds clients.
type Manager struct {
	DB   *db.DB
	Keys *crypto.Keyring
}

const passwordAAD = "system_settings:" + SettingProxyPassword

// Load returns the configured proxy (nil when not configured) and its password.
func (m *Manager) Load(ctx context.Context) (*ProxyConfig, string, error) {
	var cfg ProxyConfig
	if err := db.GetSettingJSON(ctx, m.DB.Reader, SettingProxyConfig, &cfg); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil, "", nil
		}
		return nil, "", err
	}
	if cfg.Type == "" {
		return nil, "", nil
	}
	pw, _, err := db.GetSetting(ctx, m.DB.Reader, SettingProxyPassword)
	if errors.Is(err, db.ErrNotFound) || pw == "" {
		return &cfg, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	plain, err := m.Keys.DecryptString(pw, passwordAAD)
	if err != nil {
		return nil, "", fmt.Errorf("decrypt proxy password: %w", err)
	}
	return &cfg, plain, nil
}

// Configured reports whether a system proxy is configured.
func (m *Manager) Configured(ctx context.Context) (bool, error) {
	cfg, _, err := m.Load(ctx)
	if err != nil {
		return false, err
	}
	return cfg != nil, nil
}

// PasswordSet reports whether a proxy password is stored.
func (m *Manager) PasswordSet(ctx context.Context) bool {
	v, _, err := db.GetSetting(ctx, m.DB.Reader, SettingProxyPassword)
	return err == nil && v != ""
}

// Save stores the proxy. A nil password keeps the stored one; an empty
// string clears it. A nil cfg removes the proxy entirely.
func (m *Manager) Save(ctx context.Context, tx *sql.Tx, cfg *ProxyConfig, password *string) error {
	now := m.DB.NowString()
	if cfg == nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM system_settings WHERE key IN (?, ?)`, SettingProxyConfig, SettingProxyPassword); err != nil {
			return err
		}
		return nil
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := db.PutSettingJSON(ctx, tx, SettingProxyConfig, cfg, now); err != nil {
		return err
	}
	if password != nil {
		val := ""
		if *password != "" {
			enc, err := m.Keys.EncryptString(*password, passwordAAD)
			if err != nil {
				return err
			}
			val = enc
		}
		return db.PutSetting(ctx, tx, SettingProxyPassword, val, val != "", now)
	}
	return nil
}

// UseByDefault returns the default checkbox state for a setting key.
func (m *Manager) UseByDefault(ctx context.Context, key string) bool {
	var v bool
	if err := db.GetSettingJSON(ctx, m.DB.Reader, key, &v); err != nil {
		return false
	}
	return v
}

// Client returns an HTTP client that uses the system proxy when useProxy is
// true. It fails when the proxy is requested but not configured; it never
// silently falls back to a direct connection.
func (m *Manager) Client(ctx context.Context, useProxy bool, timeout time.Duration) (*http.Client, string, error) {
	if !useProxy {
		return BuildClient(nil, "", timeout), "", nil
	}
	cfg, pw, err := m.Load(ctx)
	if err != nil {
		return nil, "", err
	}
	if cfg == nil {
		return nil, "", ErrProxyNotConfigured
	}
	return BuildClient(cfg, pw, timeout), cfg.Address(), nil
}

// BuildClient returns an HTTP client using cfg (nil = direct).
func BuildClient(cfg *ProxyConfig, password string, timeout time.Duration) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil // never read proxy settings from the environment
	if cfg != nil {
		pu := cfg.URL(password)
		noProxy := cfg.NoProxy
		tr.Proxy = func(r *http.Request) (*url.URL, error) {
			if bypass(r.URL.Hostname(), noProxy) {
				return nil, nil
			}
			return pu, nil
		}
	}
	return &http.Client{Transport: tr, Timeout: timeout}
}

// bypass reports whether host matches a no_proxy entry: exact host,
// ".suffix"/"suffix" domain match, IP or CIDR.
func bypass(host string, entries []string) bool {
	host = strings.ToLower(host)
	addr, addrErr := netip.ParseAddr(host)
	for _, e := range entries {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if e == "*" {
			return true
		}
		if strings.Contains(e, "/") {
			if p, err := netip.ParsePrefix(e); err == nil && addrErr == nil && p.Contains(addr) {
				return true
			}
			continue
		}
		e = strings.TrimPrefix(e, ".")
		if host == e || strings.HasSuffix(host, "."+e) {
			return true
		}
	}
	return false
}

// MarshalNoProxy is a helper for API views.
func MarshalNoProxy(v []string) string { b, _ := json.Marshal(v); return string(b) }
