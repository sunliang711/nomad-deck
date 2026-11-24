package server

import (
	"net"
	"net/url"
	"os"
	"sort"
	"strings"

	"nomad-deck/internal/config"
)

// localHosts returns the hostname, localhost and every local interface IP.
func localHosts() []string {
	set := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	if h, err := os.Hostname(); err == nil && h != "" {
		set[strings.ToLower(h)] = true
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLinkLocalUnicast() {
				set[ipn.IP.String()] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// CertHosts returns the SANs for the self-signed certificate.
func CertHosts(cfg *config.Config) []string {
	hosts := localHosts()
	if cfg.Server.PublicURL != "" {
		if u, err := url.Parse(cfg.Server.PublicURL); err == nil && u.Hostname() != "" {
			hosts = append(hosts, strings.ToLower(u.Hostname()))
		}
	}
	return dedupe(hosts)
}

// AllowedOrigins returns the origins accepted for state-changing requests.
// With server.public_url set only that origin is accepted; otherwise the
// listen port combined with the hostname, localhost and local IPs.
func AllowedOrigins(cfg *config.Config) (map[string]bool, error) {
	out := map[string]bool{}
	if cfg.Server.PublicURL != "" {
		o, err := cfg.PublicOrigin()
		if err != nil {
			return nil, err
		}
		out[o] = true
		return out, nil
	}
	_, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return nil, err
	}
	scheme := "https"
	if cfg.TLS.Mode == config.TLSModeProxy {
		scheme = "http"
	}
	for _, h := range localHosts() {
		host := h
		if strings.Contains(h, ":") {
			host = "[" + h + "]"
		}
		out[scheme+"://"+host+":"+port] = true
		if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
			out[scheme+"://"+host] = true
		}
	}
	return out, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
