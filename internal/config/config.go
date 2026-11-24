// Package config loads the NomadDeck startup configuration from a TOML file,
// environment variables and command line overrides (in increasing priority).
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/BurntSushi/toml"
)

// Default locations used by a systemd deployment.
const (
	DefaultConfigPath = "/opt/nomad-deck-control/etc/nomad-deck.toml"
	DefaultDataDir    = "/opt/nomad-deck-control/data"
	DefaultListen     = "0.0.0.0:8555"
)

// TLS modes.
const (
	TLSModeAuto  = "auto"
	TLSModeFile  = "file"
	TLSModeProxy = "proxy"
)

// Config is the complete startup configuration.
type Config struct {
	DataDir string       `toml:"data_dir"`
	Listen  string       `toml:"listen"`
	Server  ServerConfig `toml:"server"`
	TLS     TLSConfig    `toml:"tls"`
	Log     LogConfig    `toml:"log"`
}

// ServerConfig holds externally visible server settings.
type ServerConfig struct {
	// PublicURL is the origin browsers use to reach the management UI.
	PublicURL string `toml:"public_url"`
}

// TLSConfig selects how HTTPS is terminated.
type TLSConfig struct {
	Mode           string   `toml:"mode"`
	CertFile       string   `toml:"cert_file"`
	KeyFile        string   `toml:"key_file"`
	TrustedProxies []string `toml:"trusted_proxies"`
}

// LogConfig controls structured logging.
type LogConfig struct {
	Level  string `toml:"level"`
	Format string `toml:"format"`
}

// Overrides are command line values; empty fields are ignored.
type Overrides struct {
	DataDir string
	Listen  string
}

// Default returns the built-in configuration.
func Default() Config {
	return Config{
		DataDir: DefaultDataDir,
		Listen:  DefaultListen,
		TLS:     TLSConfig{Mode: TLSModeAuto},
		Log:     LogConfig{Level: "info", Format: "text"},
	}
}

// Load builds the configuration. path may be empty; when it equals
// DefaultConfigPath and the file does not exist, defaults are used.
func Load(path string, getenv func(string) string, ov Overrides) (Config, error) {
	cfg := Default()
	if path != "" {
		if _, err := os.Stat(path); err == nil {
			md, err := toml.DecodeFile(path, &cfg)
			if err != nil {
				return Config{}, fmt.Errorf("parse config %s: %w", path, err)
			}
			if undecoded := md.Undecoded(); len(undecoded) > 0 {
				return Config{}, fmt.Errorf("config %s: unknown keys %v", path, undecoded)
			}
		} else if !errors.Is(err, os.ErrNotExist) || path != DefaultConfigPath {
			return Config{}, fmt.Errorf("read config %s: %w", path, err)
		}
	}
	applyEnv(&cfg, getenv)
	if ov.DataDir != "" {
		cfg.DataDir = ov.DataDir
	}
	if ov.Listen != "" {
		cfg.Listen = ov.Listen
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(cfg *Config, getenv func(string) string) {
	if getenv == nil {
		return
	}
	set := func(dst *string, key string) {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			*dst = v
		}
	}
	set(&cfg.DataDir, "NOMAD_DECK_DATA_DIR")
	set(&cfg.Listen, "NOMAD_DECK_LISTEN")
	set(&cfg.Server.PublicURL, "NOMAD_DECK_PUBLIC_URL")
	set(&cfg.TLS.Mode, "NOMAD_DECK_TLS_MODE")
	set(&cfg.TLS.CertFile, "NOMAD_DECK_TLS_CERT_FILE")
	set(&cfg.TLS.KeyFile, "NOMAD_DECK_TLS_KEY_FILE")
	set(&cfg.Log.Level, "NOMAD_DECK_LOG_LEVEL")
}

// Validate checks internal consistency.
func (c *Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("data_dir must not be empty")
	}
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil || port == "" {
		return fmt.Errorf("invalid listen address %q", c.Listen)
	}
	switch c.TLS.Mode {
	case TLSModeAuto:
		if (c.TLS.CertFile == "") != (c.TLS.KeyFile == "") {
			return errors.New("tls.cert_file and tls.key_file must be set together")
		}
	case TLSModeFile:
		if c.TLS.CertFile == "" || c.TLS.KeyFile == "" {
			return errors.New("tls.mode=file requires tls.cert_file and tls.key_file")
		}
	case TLSModeProxy:
		if c.Server.PublicURL == "" {
			return errors.New("tls.mode=proxy requires server.public_url")
		}
		if !isLoopbackHost(host) && len(c.TLS.TrustedProxies) == 0 {
			return errors.New("tls.mode=proxy requires a loopback listen address or tls.trusted_proxies")
		}
	default:
		return fmt.Errorf("invalid tls.mode %q (want auto, file or proxy)", c.TLS.Mode)
	}
	for _, p := range c.TLS.TrustedProxies {
		if _, err := ParsePrefix(p); err != nil {
			return fmt.Errorf("invalid tls.trusted_proxies entry %q", p)
		}
	}
	if c.Server.PublicURL != "" {
		if _, err := c.PublicOrigin(); err != nil {
			return err
		}
	}
	return nil
}

// PublicOrigin returns the normalized scheme://host[:port] of server.public_url.
func (c *Config) PublicOrigin() (string, error) {
	u, err := url.Parse(c.Server.PublicURL)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid server.public_url %q", c.Server.PublicURL)
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("server.public_url must not contain a path, query or fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		// Secure cookies only work over plain HTTP for localhost.
		if h := u.Hostname(); h != "localhost" && !isLoopbackHost(h) {
			return "", errors.New("server.public_url must use https unless it points to localhost")
		}
	default:
		return "", fmt.Errorf("server.public_url must use https, got %q", u.Scheme)
	}
	return strings.ToLower(u.Scheme + "://" + u.Host), nil
}

// ParsePrefix accepts either a CIDR or a single IP address.
func ParsePrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		return netip.ParsePrefix(s)
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	return netip.PrefixFrom(a, a.BitLen()), nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	a, err := netip.ParseAddr(h)
	return err == nil && a.IsLoopback()
}
