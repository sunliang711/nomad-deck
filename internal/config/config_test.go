package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaultsWhenDefaultPathMissing(t *testing.T) {
	cfg, err := Load(DefaultConfigPath, env(nil), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "0.0.0.0:8555" || cfg.TLS.Mode != TLSModeAuto {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestExplicitMissingFileFails(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.toml"), env(nil), Overrides{}); err == nil {
		t.Fatal("expected error for missing explicit config")
	}
}

func TestPrecedenceFileEnvFlag(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.toml")
	os.WriteFile(p, []byte("listen = \"127.0.0.1:9000\"\ndata_dir = \"/file\"\n[server]\npublic_url = \"https://deck.example.com\"\n"), 0o600)
	cfg, err := Load(p, env(map[string]string{"NOMAD_DECK_LISTEN": "127.0.0.1:9100"}), Overrides{DataDir: "/flag"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:9100" || cfg.DataDir != "/flag" {
		t.Fatalf("precedence wrong: %+v", cfg)
	}
	if o, _ := cfg.PublicOrigin(); o != "https://deck.example.com" {
		t.Fatalf("origin = %s", o)
	}
}

func TestUnknownKeysRejected(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.toml")
	os.WriteFile(p, []byte("lisen = \"x\"\n"), 0o600)
	if _, err := Load(p, env(nil), Overrides{}); err == nil || !strings.Contains(err.Error(), "unknown keys") {
		t.Fatalf("expected unknown key error, got %v", err)
	}
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*Config)
		ok   bool
	}{
		{"proxy needs public url", func(c *Config) { c.TLS.Mode = TLSModeProxy; c.Listen = "127.0.0.1:8555" }, false},
		{"proxy on loopback ok", func(c *Config) {
			c.TLS.Mode = TLSModeProxy
			c.Listen = "127.0.0.1:8555"
			c.Server.PublicURL = "https://deck.example.com"
		}, true},
		{"proxy on wildcard needs trusted", func(c *Config) {
			c.TLS.Mode = TLSModeProxy
			c.Server.PublicURL = "https://deck.example.com"
		}, false},
		{"proxy with trusted ok", func(c *Config) {
			c.TLS.Mode = TLSModeProxy
			c.Server.PublicURL = "https://deck.example.com"
			c.TLS.TrustedProxies = []string{"10.0.0.0/8"}
		}, true},
		{"file needs cert", func(c *Config) { c.TLS.Mode = TLSModeFile }, false},
		{"bad mode", func(c *Config) { c.TLS.Mode = "x" }, false},
		{"http public url rejected", func(c *Config) { c.Server.PublicURL = "http://deck.example.com" }, false},
		{"http localhost allowed", func(c *Config) { c.Server.PublicURL = "http://localhost:8555" }, true},
		{"public url with path rejected", func(c *Config) { c.Server.PublicURL = "https://deck.example.com/ui" }, false},
		{"bad listen", func(c *Config) { c.Listen = "8555" }, false},
	}
	for _, tc := range cases {
		c := Default()
		tc.mut(&c)
		err := c.Validate()
		if (err == nil) != tc.ok {
			t.Errorf("%s: ok=%v err=%v", tc.name, tc.ok, err)
		}
	}
}
