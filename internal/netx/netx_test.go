package netx

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestBypass(t *testing.T) {
	entries := []string{"internal.example", ".corp", "10.0.0.0/8", "192.168.1.5"}
	cases := map[string]bool{
		"internal.example": true, "a.internal.example": true, "x.corp": true, "10.2.3.4": true, "192.168.1.5": true,
		"example.com": false, "notinternal.example": false, "11.0.0.1": false,
	}
	for host, want := range cases {
		if got := bypass(host, entries); got != want {
			t.Errorf("%s: %v want %v", host, got, want)
		}
	}
}

func TestClientUsesProxyWithCredentials(t *testing.T) {
	var gotAuth, gotURL string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Proxy-Authorization")
		gotURL = r.URL.String()
		io.WriteString(w, "via-proxy")
	}))
	defer proxy.Close()
	u, _ := url.Parse(proxy.URL)
	port, _ := strconv.Atoi(u.Port())
	cfg := &ProxyConfig{Type: "http", Host: u.Hostname(), Port: port, Username: "bob", NoProxy: []string{"skip.example"}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	c := BuildClient(cfg, "s3cret", 5*time.Second)
	resp, err := c.Get("http://upstream.example/path")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "via-proxy" || gotURL != "http://upstream.example/path" {
		t.Fatalf("request did not go through proxy: %q %q", b, gotURL)
	}
	if gotAuth != "Basic "+base64.StdEncoding.EncodeToString([]byte("bob:s3cret")) {
		t.Fatalf("proxy auth header: %q", gotAuth)
	}
	if cfg.Address() != "http://"+u.Host {
		t.Fatalf("address must not contain credentials: %s", cfg.Address())
	}
}

func TestDirectClientIgnoresEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	defer srv.Close()
	resp, err := BuildClient(nil, "", 5*time.Second).Get(srv.URL)
	if err != nil {
		t.Fatalf("direct client must not use environment proxies: %v", err)
	}
	resp.Body.Close()
}

func TestValidate(t *testing.T) {
	bad := []ProxyConfig{{Type: "ftp", Host: "h", Port: 1}, {Type: "http", Host: "", Port: 1}, {Type: "socks5", Host: "h", Port: 0}}
	for _, c := range bad {
		if c.Validate() == nil {
			t.Errorf("%+v should be invalid", c)
		}
	}
}
