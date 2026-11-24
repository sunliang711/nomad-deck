// Package nomad drives Nomad clusters: the HTTP API client, rendering of
// the managed node layout and its config generations, deployment over SSH
// with a pre-generated ACL bootstrap secret, lifecycle operations behind a
// Raft quorum gate, governance, Docker Engine management and Doctor.
package nomad

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/pki"
)

// Client talks to one Nomad agent.
type Client struct {
	Addr  string // e.g. https://10.0.0.11:4646
	Token string
	HTTP  *http.Client
}

// ClientCert is the control plane's client certificate, presented when the
// cluster requires HTTPS client certificates.
type ClientCert struct {
	CertPEM string
	KeyPEM  string
}

// NewClient builds a client trusting caBundle (empty for plain HTTP).
func NewClient(addr, caBundle, token string, cert *ClientCert, timeout time.Duration) (*Client, error) {
	tr := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 10 * time.Second, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 30 * time.Second, ForceAttemptHTTP2: true}
	if strings.HasPrefix(addr, "https://") {
		pool, err := pki.Pool(caBundle)
		if err != nil {
			return nil, err
		}
		cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		if cert != nil && cert.CertPEM != "" {
			kp, err := tls.X509KeyPair([]byte(cert.CertPEM), []byte(cert.KeyPEM))
			if err != nil {
				return nil, fmt.Errorf("control plane client certificate: %w", err)
			}
			cfg.Certificates = []tls.Certificate{kp}
		}
		tr.TLSClientConfig = cfg
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{Addr: strings.TrimRight(addr, "/"), Token: token, HTTP: &http.Client{Transport: tr, Timeout: timeout}}, nil
}

// WithToken returns a copy using another token.
func (c *Client) WithToken(token string) *Client {
	cp := *c
	cp.Token = token
	return &cp
}

// APIError is an error response from Nomad (plain text body).
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("nomad: HTTP %d", e.Status)
	}
	return fmt.Sprintf("nomad: HTTP %d: %s", e.Status, e.Message)
}

// StatusOf returns the HTTP status of an APIError (0 otherwise).
func StatusOf(err error) int {
	var e *APIError
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

// MessageOf returns the message of an APIError ("" otherwise).
func MessageOf(err error) string {
	var e *APIError
	if errors.As(err, &e) {
		return e.Message
	}
	return ""
}

func (c *Client) send(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.Addr+"/v1/"+path, body)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("X-Nomad-Token", c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, &APIError{Status: resp.StatusCode, Message: strings.TrimSpace(string(b))}
	}
	return resp, nil
}

// Request performs a JSON request; out may be nil.
func (c *Client) Request(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	resp, err := c.send(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out)
}

// ---- Agent and status ----

// AgentSelf is the subset of /v1/agent/self the control plane reads.
type AgentSelf struct {
	Version string
	Name    string
	Server  bool
	Client  bool
	Region  string
	DC      string
}

// Self reads the local agent's identity and version (needs agent:read).
func (c *Client) Self(ctx context.Context) (*AgentSelf, error) {
	var r struct {
		Config struct {
			Version struct {
				Version    string `json:"Version"`
				Prerelease string `json:"VersionPrerelease"`
				Metadata   string `json:"VersionMetadata"`
			} `json:"Version"`
			Region     string `json:"Region"`
			Datacenter string `json:"Datacenter"`
			NodeName   string `json:"NodeName"`
			Server     *struct {
				Enabled bool `json:"Enabled"`
			} `json:"Server"`
			Client *struct {
				Enabled bool `json:"Enabled"`
			} `json:"Client"`
		} `json:"config"`
		Member struct {
			Name string `json:"Name"`
		} `json:"member"`
	}
	if err := c.Request(ctx, http.MethodGet, "agent/self", nil, &r); err != nil {
		return nil, err
	}
	v := r.Config.Version.Version
	if r.Config.Version.Prerelease != "" {
		v += "-" + r.Config.Version.Prerelease
	}
	if r.Config.Version.Metadata != "" {
		v += "+" + r.Config.Version.Metadata
	}
	s := &AgentSelf{Version: v, Name: r.Config.NodeName, Region: r.Config.Region, DC: r.Config.Datacenter}
	if s.Name == "" {
		s.Name = r.Member.Name
	}
	s.Server = r.Config.Server != nil && r.Config.Server.Enabled
	s.Client = r.Config.Client != nil && r.Config.Client.Enabled
	return s, nil
}

// AgentHealth is /v1/agent/health. A nil side means the agent does not run
// that role.
type AgentHealth struct {
	Client *HealthPart `json:"client"`
	Server *HealthPart `json:"server"`
}

// HealthPart is one side of the agent health.
type HealthPart struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Health reads the agent health. Nomad answers 500 with the same body when
// a side is unhealthy, so both outcomes decode.
func (c *Client) Health(ctx context.Context) (*AgentHealth, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Addr+"/v1/agent/health", nil)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("X-Nomad-Token", c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var h AgentHealth
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, &APIError{Status: resp.StatusCode, Message: strings.TrimSpace(string(b))}
	}
	return &h, nil
}

// Leader returns the RPC address of the Raft leader ("" without a leader).
func (c *Client) Leader(ctx context.Context) (string, error) {
	var s string
	if err := c.Request(ctx, http.MethodGet, "status/leader", nil, &s); err != nil {
		return "", err
	}
	return s, nil
}

// Peers returns the RPC addresses of the Raft peers.
func (c *Client) Peers(ctx context.Context) ([]string, error) {
	var s []string
	err := c.Request(ctx, http.MethodGet, "status/peers", nil, &s)
	return s, err
}

// ---- Operator ----

// RaftServer is one Raft member.
type RaftServer struct {
	ID      string `json:"ID"`
	Node    string `json:"Node"`
	Address string `json:"Address"`
	Leader  bool   `json:"Leader"`
	Voter   bool   `json:"Voter"`
}

// RaftConfiguration lists Raft members.
func (c *Client) RaftConfiguration(ctx context.Context) ([]RaftServer, error) {
	var r struct {
		Servers []RaftServer `json:"Servers"`
	}
	if err := c.Request(ctx, http.MethodGet, "operator/raft/configuration", nil, &r); err != nil {
		return nil, err
	}
	return r.Servers, nil
}

// RemovePeer removes a Raft member by Raft ID.
func (c *Client) RemovePeer(ctx context.Context, id string) error {
	return c.Request(ctx, http.MethodDelete, "operator/raft/peer?id="+url.QueryEscape(id), nil, nil)
}

// ServerHealth is one server in the autopilot health report.
type ServerHealth struct {
	ID          string `json:"ID"`
	Name        string `json:"Name"`
	Address     string `json:"Address"`
	SerfStatus  string `json:"SerfStatus"`
	Version     string `json:"Version"`
	Leader      bool   `json:"Leader"`
	LastContact string `json:"-"`
	LastIndex   uint64 `json:"LastIndex"`
	Healthy     bool   `json:"Healthy"`
	Voter       bool   `json:"Voter"`
}

// AutopilotHealth is /v1/operator/autopilot/health.
type AutopilotHealth struct {
	Healthy          bool           `json:"Healthy"`
	FailureTolerance int            `json:"FailureTolerance"`
	Servers          []ServerHealth `json:"Servers"`
}

// Autopilot reads the autopilot health report. LastContact is rendered as
// a duration string by the server; it is kept as text.
func (c *Client) Autopilot(ctx context.Context) (*AutopilotHealth, error) {
	var raw struct {
		Healthy          bool `json:"Healthy"`
		FailureTolerance int  `json:"FailureTolerance"`
		Servers          []struct {
			ServerHealth
			LastContact json.RawMessage `json:"LastContact"`
		} `json:"Servers"`
	}
	if err := c.Request(ctx, http.MethodGet, "operator/autopilot/health", nil, &raw); err != nil {
		return nil, err
	}
	h := &AutopilotHealth{Healthy: raw.Healthy, FailureTolerance: raw.FailureTolerance}
	for _, s := range raw.Servers {
		sv := s.ServerHealth
		var str string
		if json.Unmarshal(s.LastContact, &str) == nil {
			sv.LastContact = str
		} else {
			var ns int64
			if json.Unmarshal(s.LastContact, &ns) == nil {
				sv.LastContact = time.Duration(ns).String()
			}
		}
		h.Servers = append(h.Servers, sv)
	}
	return h, nil
}

// SnapshotSave streams a Raft snapshot into w.
func (c *Client) SnapshotSave(ctx context.Context, w io.Writer) (int64, error) {
	resp, err := c.send(ctx, http.MethodGet, "operator/snapshot", nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return io.Copy(w, resp.Body)
}

// SnapshotRestore restores a Raft snapshot.
func (c *Client) SnapshotRestore(ctx context.Context, r io.Reader) error {
	resp, err := c.send(ctx, http.MethodPut, "operator/snapshot", r)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ---- ACL bootstrap ----

// ACLToken is an ACL token as returned by Nomad.
type ACLToken struct {
	AccessorID string     `json:"AccessorID"`
	SecretID   string     `json:"SecretID,omitempty"`
	Name       string     `json:"Name"`
	Type       string     `json:"Type"`
	Policies   []string   `json:"Policies"`
	Roles      []RoleLink `json:"Roles,omitempty"`
	Global     bool       `json:"Global"`
	CreateTime time.Time  `json:"CreateTime"`
	// ExpirationTime is nil for tokens that do not expire.
	ExpirationTime *time.Time `json:"ExpirationTime,omitempty"`
	ExpirationTTL  string     `json:"ExpirationTTL,omitempty"`
}

// RoleLink references an ACL role from a token.
type RoleLink struct {
	ID   string `json:"ID,omitempty"`
	Name string `json:"Name,omitempty"`
}

// ErrBootstrapDone is returned when the ACL system was already bootstrapped.
type ErrBootstrapDone struct{ ResetIndex uint64 }

func (e *ErrBootstrapDone) Error() string {
	return fmt.Sprintf("ACL bootstrap already done (reset index %d)", e.ResetIndex)
}

var reResetIndex = regexp.MustCompile(`reset index:?\s*(\d+)`)

// Bootstrap bootstraps the ACL system with an operator-supplied secret.
func (c *Client) Bootstrap(ctx context.Context, secret string) (*ACLToken, error) {
	var t ACLToken
	err := c.Request(ctx, http.MethodPut, "acl/bootstrap", map[string]string{"BootstrapSecret": secret}, &t)
	if err != nil {
		if m := reResetIndex.FindStringSubmatch(MessageOf(err)); m != nil {
			idx, _ := strconv.ParseUint(m[1], 10, 64)
			return nil, &ErrBootstrapDone{ResetIndex: idx}
		}
		return nil, err
	}
	return &t, nil
}

// TokenSelf looks up the client's own token.
func (c *Client) TokenSelf(ctx context.Context) (*ACLToken, error) {
	var t ACLToken
	if err := c.Request(ctx, http.MethodGet, "acl/token/self", nil, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// ---- Nodes ----

// NodeStub is one client node in the node list.
type NodeStub struct {
	ID                    string  `json:"ID"`
	Name                  string  `json:"Name"`
	Address               string  `json:"Address"`
	Datacenter            string  `json:"Datacenter"`
	NodePool              string  `json:"NodePool"`
	Status                string  `json:"Status"`
	SchedulingEligibility string  `json:"SchedulingEligibility"`
	Drain                 bool    `json:"Drain"`
	Version               string  `json:"Version"`
	LastDrain             *Drain  `json:"LastDrain,omitempty"`
	Drivers               Drivers `json:"Drivers,omitempty"`
}

// Drain is the outcome of the last drain of a node.
type Drain struct {
	Status string `json:"Status"`
}

// Drivers maps driver names to their fingerprinted health.
type Drivers map[string]struct {
	Detected bool `json:"Detected"`
	Healthy  bool `json:"Healthy"`
}

// Nodes lists the client nodes.
func (c *Client) Nodes(ctx context.Context) ([]NodeStub, error) {
	var out []NodeStub
	err := c.Request(ctx, http.MethodGet, "nodes?resources=false&os=false", nil, &out)
	return out, err
}

// NodeDetail is the subset of a node the control plane reads.
type NodeDetail struct {
	ID                    string    `json:"ID"`
	Name                  string    `json:"Name"`
	Status                string    `json:"Status"`
	SchedulingEligibility string    `json:"SchedulingEligibility"`
	DrainStrategy         *struct{} `json:"DrainStrategy"`
	LastDrain             *Drain    `json:"LastDrain"`
	Drivers               Drivers   `json:"Drivers"`
}

// Node reads one node.
func (c *Client) Node(ctx context.Context, id string) (*NodeDetail, error) {
	var n NodeDetail
	if err := c.Request(ctx, http.MethodGet, "node/"+url.PathEscape(id), nil, &n); err != nil {
		return nil, err
	}
	return &n, nil
}

// SetEligibility marks a node eligible or ineligible for scheduling.
func (c *Client) SetEligibility(ctx context.Context, id string, eligible bool) error {
	v := "ineligible"
	if eligible {
		v = "eligible"
	}
	return c.Request(ctx, http.MethodPost, "node/"+url.PathEscape(id)+"/eligibility", map[string]string{"Eligibility": v}, nil)
}

// DrainNode starts a drain with a deadline (0 = no deadline); a nil spec
// with cancel=true stops a drain and keeps the node ineligible unless
// markEligible is set.
func (c *Client) DrainNode(ctx context.Context, id string, deadline time.Duration, ignoreSystem bool, meta map[string]string) error {
	body := map[string]any{"DrainSpec": map[string]any{"Deadline": int64(deadline), "IgnoreSystemJobs": ignoreSystem},
		"Meta": meta}
	return c.Request(ctx, http.MethodPost, "node/"+url.PathEscape(id)+"/drain", body, nil)
}

// CancelDrain stops a drain and optionally makes the node eligible again.
func (c *Client) CancelDrain(ctx context.Context, id string, markEligible bool) error {
	body := map[string]any{"DrainSpec": nil, "MarkEligible": markEligible}
	return c.Request(ctx, http.MethodPost, "node/"+url.PathEscape(id)+"/drain", body, nil)
}

// PurgeNode removes a node from the client list.
func (c *Client) PurgeNode(ctx context.Context, id string) error {
	return c.Request(ctx, http.MethodPost, "node/"+url.PathEscape(id)+"/purge", nil, nil)
}

// ---- Gossip keyring ----

// KeyringList returns the installed gossip keys and how many servers hold each.
func (c *Client) KeyringList(ctx context.Context) (map[string]int, int, error) {
	var r struct {
		Keys     map[string]int `json:"Keys"`
		NumNodes int            `json:"NumNodes"`
	}
	if err := c.Request(ctx, http.MethodGet, "agent/keyring/list", nil, &r); err != nil {
		return nil, 0, err
	}
	return r.Keys, r.NumNodes, nil
}

// KeyringOp installs, activates or removes a gossip key on all servers.
func (c *Client) KeyringOp(ctx context.Context, op, key string) error {
	switch op {
	case "install", "use", "remove":
	default:
		return fmt.Errorf("unknown keyring op %q", op)
	}
	return c.Request(ctx, http.MethodPut, "agent/keyring/"+op, map[string]string{"Key": key}, nil)
}
