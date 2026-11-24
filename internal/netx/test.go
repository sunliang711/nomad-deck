package netx

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// TestTarget is a URL checked through the proxy.
type TestTarget struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// DefaultTestTargets are the external sources the control plane needs.
func DefaultTestTargets(releaseBase string) []TestTarget {
	if releaseBase == "" {
		releaseBase = "https://releases.hashicorp.com/"
	}
	return []TestTarget{
		{Name: "HashiCorp Releases", URL: releaseBase},
		{Name: "Docker 软件仓库", URL: "https://download.docker.com/linux/"},
		{Name: "GitHub API", URL: "https://api.github.com/"},
		{Name: "GitHub Release 下载", URL: "https://objects.githubusercontent.com/"},
	}
}

// TestResult is the outcome for one target.
type TestResult struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	OK         bool   `json:"ok"`
	StatusCode int    `json:"status_code,omitempty"`
	LatencyMS  int64  `json:"latency_ms"`
	Error      string `json:"error,omitempty"`
}

// TestReport is the full connectivity report.
type TestReport struct {
	Proxy   string       `json:"proxy"`
	Results []TestResult `json:"results"`
	ExitIP  string       `json:"exit_ip,omitempty"`
}

// ExitIPURL returns the caller's public IP as plain text.
var ExitIPURL = "https://checkip.amazonaws.com/"

// TestProxy checks every target through cfg and reports the exit IP.
func TestProxy(ctx context.Context, cfg *ProxyConfig, password string, targets []TestTarget) TestReport {
	client := BuildClient(cfg, password, 15*time.Second)
	rep := TestReport{Proxy: cfg.Address()}
	for _, t := range targets {
		rep.Results = append(rep.Results, probeURL(ctx, client, t))
	}
	if req, err := http.NewRequestWithContext(ctx, http.MethodGet, ExitIPURL, nil); err == nil {
		if resp, err := client.Do(req); err == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
			resp.Body.Close()
			if ip := strings.TrimSpace(string(b)); net.ParseIP(ip) != nil {
				rep.ExitIP = ip
			}
		}
	}
	return rep
}

func probeURL(ctx context.Context, client *http.Client, t TestTarget) TestResult {
	r := TestResult{Name: t.Name, URL: t.URL}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, t.URL, nil)
	if err != nil {
		r.Error = err.Error()
		return r
	}
	resp, err := client.Do(req)
	r.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		r.Error = classify(err)
		return r
	}
	resp.Body.Close()
	r.StatusCode = resp.StatusCode
	// Any HTTP answer from the origin proves the path works; 407 is the proxy refusing us.
	switch {
	case resp.StatusCode == http.StatusProxyAuthRequired:
		r.Error = "代理认证失败（407）"
	case resp.StatusCode >= 500:
		r.Error = "目标返回服务器错误"
	default:
		r.OK = true
	}
	return r
}

// classify turns transport errors into readable reasons.
func classify(err error) string {
	msg := err.Error()
	var tlsErr *tls.CertificateVerificationError
	var netErr net.Error
	switch {
	case strings.Contains(msg, "Proxy Authentication Required") || strings.Contains(msg, "407") ||
		strings.Contains(msg, "username/password authentication failed"):
		return "代理认证失败"
	case strings.Contains(msg, "proxyconnect") && strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "socks connect") && strings.Contains(msg, "connection refused"):
		return "无法连接到代理（连接被拒绝）"
	case errors.As(err, &tlsErr) || strings.Contains(msg, "x509:") || strings.Contains(msg, "tls:"):
		return "TLS 错误：" + msg
	case errors.As(err, &netErr) && netErr.Timeout():
		return "连接超时"
	case strings.Contains(msg, "no such host"):
		return "域名解析失败"
	default:
		return msg
	}
}
