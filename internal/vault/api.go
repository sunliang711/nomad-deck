// Package vault drives Vault clusters: the HTTP API client, rendering of the
// managed node layout, deployment over SSH, Shamir initialization with
// two-phase Raft joins, custody of unseal keys and tokens, Rekey,
// lifecycle operations behind a Raft quorum gate, snapshots and Doctor.
package vault

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/pki"
)

// Client talks to one Vault node.
type Client struct {
	Addr  string // e.g. https://10.0.0.11:8200
	Token string
	HTTP  *http.Client
}

// NewClient builds a client trusting caBundle (empty for plain HTTP).
func NewClient(addr, caBundle, token string, timeout time.Duration) (*Client, error) {
	tr := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 10 * time.Second, MaxIdleConnsPerHost: 4,
		IdleConnTimeout: 30 * time.Second, ForceAttemptHTTP2: true}
	if strings.HasPrefix(addr, "https://") {
		pool, err := pki.Pool(caBundle)
		if err != nil {
			return nil, err
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
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

// APIError is an error response from Vault.
type APIError struct {
	Status int
	Errors []string
}

func (e *APIError) Error() string {
	if len(e.Errors) == 0 {
		return fmt.Sprintf("vault: HTTP %d", e.Status)
	}
	return fmt.Sprintf("vault: HTTP %d: %s", e.Status, strings.Join(e.Errors, "; "))
}

// HasMessage reports whether any error message contains s (case-insensitive).
func (e *APIError) HasMessage(s string) bool {
	for _, m := range e.Errors {
		if strings.Contains(strings.ToLower(m), strings.ToLower(s)) {
			return true
		}
	}
	return false
}

// StatusOf returns the HTTP status of an APIError (0 otherwise).
func StatusOf(err error) int {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// IsInvalidKey reports whether Vault explicitly rejected an unseal or
// verification key as invalid (as opposed to transport or server errors).
func IsInvalidKey(err error) bool {
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != http.StatusBadRequest {
		return false
	}
	return ae.HasMessage("invalid key") || ae.HasMessage("failed to decrypt keys")
}

// Request performs an API call against /v1/<path>. body may be nil, an
// io.Reader (sent raw) or any JSON-encodable value; out may be nil.
func (c *Client) Request(ctx context.Context, method, path string, body, out any) error {
	resp, err := c.send(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return readAPIError(resp)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func (c *Client) send(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case io.Reader:
		rdr = b
		contentType = "application/octet-stream"
	default:
		data, err := json.Marshal(b)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(data)
		contentType = "application/json"
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Addr+"/v1/"+strings.TrimPrefix(path, "/"), rdr)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.Token != "" {
		req.Header.Set("X-Vault-Token", c.Token)
	}
	req.Header.Set("X-Vault-Request", "true")
	return c.HTTP.Do(req)
}

func readAPIError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var e struct {
		Errors []string `json:"errors"`
	}
	_ = json.Unmarshal(data, &e)
	if len(e.Errors) == 0 && len(bytes.TrimSpace(data)) > 0 && !json.Valid(data) {
		e.Errors = []string{strings.TrimSpace(string(data))}
	}
	return &APIError{Status: resp.StatusCode, Errors: e.Errors}
}

// ---- Seal, health, init ----

// SealStatus is /sys/seal-status (also returned by unseal).
type SealStatus struct {
	Type        string `json:"type"`
	Initialized bool   `json:"initialized"`
	Sealed      bool   `json:"sealed"`
	T           int    `json:"t"`
	N           int    `json:"n"`
	Progress    int    `json:"progress"`
	Nonce       string `json:"nonce"`
	Version     string `json:"version"`
	ClusterName string `json:"cluster_name"`
	ClusterID   string `json:"cluster_id"`
	StorageType string `json:"storage_type"`
}

// SealStatus returns the seal status (unauthenticated).
func (c *Client) SealStatus(ctx context.Context) (*SealStatus, error) {
	var s SealStatus
	return &s, c.Request(ctx, http.MethodGet, "sys/seal-status", nil, &s)
}

// Health is /sys/health.
type Health struct {
	Initialized   bool   `json:"initialized"`
	Sealed        bool   `json:"sealed"`
	Standby       bool   `json:"standby"`
	Version       string `json:"version"`
	Enterprise    bool   `json:"enterprise"`
	ClusterName   string `json:"cluster_name"`
	ClusterID     string `json:"cluster_id"`
	ServerTimeUTC int64  `json:"server_time_utc"`
	HTTPStatus    int    `json:"-"`
}

// Health returns node health regardless of state (the HTTP status is kept).
func (c *Client) Health(ctx context.Context) (*Health, error) {
	resp, err := c.send(ctx, http.MethodGet, "sys/health?standbyok=true&perfstandbyok=true", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var h Health
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, fmt.Errorf("vault health: HTTP %d", resp.StatusCode)
	}
	h.HTTPStatus = resp.StatusCode
	return &h, nil
}

// IsEnterprise reports whether a version string denotes Vault Enterprise.
func IsEnterprise(version string) bool {
	return strings.Contains(version, "+ent") || strings.Contains(version, "+prem") || strings.Contains(version, "+hsm")
}

// InitResponse is returned by /sys/init.
type InitResponse struct {
	Keys       []string `json:"keys"`
	KeysBase64 []string `json:"keys_base64"`
	RootToken  string   `json:"root_token"`
}

// Init initializes a fresh cluster with Shamir shares.
func (c *Client) Init(ctx context.Context, shares, threshold int) (*InitResponse, error) {
	var r InitResponse
	err := c.Request(ctx, http.MethodPut, "sys/init", map[string]any{"secret_shares": shares, "secret_threshold": threshold}, &r)
	return &r, err
}

// Unseal submits one unseal key.
func (c *Client) Unseal(ctx context.Context, key string) (*SealStatus, error) {
	var s SealStatus
	return &s, c.Request(ctx, http.MethodPut, "sys/unseal", map[string]any{"key": key}, &s)
}

// UnsealReset discards submitted unseal progress.
func (c *Client) UnsealReset(ctx context.Context) error {
	return c.Request(ctx, http.MethodPut, "sys/unseal", map[string]any{"reset": true}, nil)
}

// Seal seals the node (requires sudo on sys/seal).
func (c *Client) Seal(ctx context.Context) error {
	return c.Request(ctx, http.MethodPut, "sys/seal", nil, nil)
}

// StepDown makes the active node give up leadership.
func (c *Client) StepDown(ctx context.Context) error {
	return c.Request(ctx, http.MethodPut, "sys/step-down", nil, nil)
}

// ---- Raft ----

// RaftJoin asks a node to join the cluster led by leaderAddr.
func (c *Client) RaftJoin(ctx context.Context, leaderAddr, leaderCA string) error {
	return c.Request(ctx, http.MethodPost, "sys/storage/raft/join",
		map[string]any{"leader_api_addr": leaderAddr, "leader_ca_cert": leaderCA, "retry": true}, nil)
}

// RaftServer is one member of the Raft configuration.
type RaftServer struct {
	NodeID  string `json:"node_id"`
	Address string `json:"address"`
	Leader  bool   `json:"leader"`
	Voter   bool   `json:"voter"`
}

// RaftConfiguration lists Raft members.
func (c *Client) RaftConfiguration(ctx context.Context) ([]RaftServer, error) {
	var r struct {
		Data struct {
			Config struct {
				Servers []RaftServer `json:"servers"`
			} `json:"config"`
		} `json:"data"`
	}
	err := c.Request(ctx, http.MethodGet, "sys/storage/raft/configuration", nil, &r)
	return r.Data.Config.Servers, err
}

// AutopilotServer is one server in the autopilot state.
type AutopilotServer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Address     string `json:"address"`
	NodeStatus  string `json:"node_status"`
	LastContact string `json:"last_contact"`
	LastTerm    uint64 `json:"last_term"`
	LastIndex   uint64 `json:"last_index"`
	Healthy     bool   `json:"healthy"`
	Status      string `json:"status"` // leader, voter, non-voter
	Version     string `json:"version"`
}

// AutopilotState is /sys/storage/raft/autopilot/state.
type AutopilotState struct {
	Healthy          bool                       `json:"healthy"`
	FailureTolerance int                        `json:"failure_tolerance"`
	Leader           string                     `json:"leader"`
	Voters           []string                   `json:"voters"`
	Servers          map[string]AutopilotServer `json:"servers"`
}

// AutopilotState returns autopilot's view of cluster health.
func (c *Client) AutopilotState(ctx context.Context) (*AutopilotState, error) {
	var raw json.RawMessage
	if err := c.Request(ctx, http.MethodGet, "sys/storage/raft/autopilot/state", nil, &raw); err != nil {
		return nil, err
	}
	var wrapped struct {
		Data *AutopilotState `json:"data"`
	}
	if json.Unmarshal(raw, &wrapped) == nil && wrapped.Data != nil && wrapped.Data.Servers != nil {
		return wrapped.Data, nil
	}
	var s AutopilotState
	return &s, json.Unmarshal(raw, &s)
}

// RemovePeer removes a server from the Raft configuration.
func (c *Client) RemovePeer(ctx context.Context, serverID string) error {
	return c.Request(ctx, http.MethodPost, "sys/storage/raft/remove-peer", map[string]any{"server_id": serverID}, nil)
}

// SnapshotSave streams a Raft snapshot into w.
func (c *Client) SnapshotSave(ctx context.Context, w io.Writer) (int64, error) {
	resp, err := c.send(ctx, http.MethodGet, "sys/storage/raft/snapshot", nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, readAPIError(resp)
	}
	return io.Copy(w, resp.Body)
}

// SnapshotRestore restores a snapshot; force allows a snapshot taken with
// different unseal keys.
func (c *Client) SnapshotRestore(ctx context.Context, r io.Reader, force bool) error {
	path := "sys/storage/raft/snapshot"
	if force {
		path = "sys/storage/raft/snapshot-force"
	}
	return c.Request(ctx, http.MethodPost, path, r, nil)
}

// ---- Rekey ----

// RekeyStatus is the state of a rekey (and of its verification).
type RekeyStatus struct {
	Nonce                string   `json:"nonce"`
	Started              bool     `json:"started"`
	T                    int      `json:"t"`
	N                    int      `json:"n"`
	Progress             int      `json:"progress"`
	Required             int      `json:"required"`
	VerificationRequired bool     `json:"verification_required"`
	VerificationNonce    string   `json:"verification_nonce"`
	Complete             bool     `json:"complete"`
	Keys                 []string `json:"keys"`
	KeysBase64           []string `json:"keys_base64"`
}

// RekeyInit starts a rekey that requires verification of the new keys.
func (c *Client) RekeyInit(ctx context.Context, shares, threshold int) (*RekeyStatus, error) {
	var s RekeyStatus
	err := c.Request(ctx, http.MethodPut, "sys/rekey/init",
		map[string]any{"secret_shares": shares, "secret_threshold": threshold, "require_verification": true}, &s)
	return &s, err
}

// RekeyStatus returns the current rekey state.
func (c *Client) RekeyStatus(ctx context.Context) (*RekeyStatus, error) {
	var s RekeyStatus
	return &s, c.Request(ctx, http.MethodGet, "sys/rekey/init", nil, &s)
}

// RekeyCancel cancels a rekey in progress.
func (c *Client) RekeyCancel(ctx context.Context) error {
	return c.Request(ctx, http.MethodDelete, "sys/rekey/init", nil, nil)
}

// RekeyUpdate submits one current key.
func (c *Client) RekeyUpdate(ctx context.Context, key, nonce string) (*RekeyStatus, error) {
	var s RekeyStatus
	return &s, c.Request(ctx, http.MethodPut, "sys/rekey/update", map[string]any{"key": key, "nonce": nonce}, &s)
}

// RekeyVerifyStatus returns the state of the new-key verification.
func (c *Client) RekeyVerifyStatus(ctx context.Context) (*RekeyStatus, error) {
	var s RekeyStatus
	return &s, c.Request(ctx, http.MethodGet, "sys/rekey/verify", nil, &s)
}

// RekeyVerifyUpdate submits one new key for verification.
func (c *Client) RekeyVerifyUpdate(ctx context.Context, key, nonce string) (*RekeyStatus, error) {
	var s RekeyStatus
	return &s, c.Request(ctx, http.MethodPut, "sys/rekey/verify", map[string]any{"key": key, "nonce": nonce}, &s)
}

// ---- Generate root ----

// GenerateRootStatus is the state of a generate-root attempt.
type GenerateRootStatus struct {
	Nonce        string `json:"nonce"`
	Started      bool   `json:"started"`
	Progress     int    `json:"progress"`
	Required     int    `json:"required"`
	Complete     bool   `json:"complete"`
	EncodedToken string `json:"encoded_token"`
	EncodedRoot  string `json:"encoded_root_token"`
	OTP          string `json:"otp"`
	OTPLength    int    `json:"otp_length"`
}

// GenerateRootInit starts an attempt; Vault generates the OTP.
func (c *Client) GenerateRootInit(ctx context.Context) (*GenerateRootStatus, error) {
	var s GenerateRootStatus
	return &s, c.Request(ctx, http.MethodPut, "sys/generate-root/attempt", map[string]any{}, &s)
}

// GenerateRootCancel cancels an attempt.
func (c *Client) GenerateRootCancel(ctx context.Context) error {
	return c.Request(ctx, http.MethodDelete, "sys/generate-root/attempt", nil, nil)
}

// GenerateRootUpdate submits one unseal key.
func (c *Client) GenerateRootUpdate(ctx context.Context, key, nonce string) (*GenerateRootStatus, error) {
	var s GenerateRootStatus
	return &s, c.Request(ctx, http.MethodPut, "sys/generate-root/update", map[string]any{"key": key, "nonce": nonce}, &s)
}

// DecodeRootToken XORs the encoded token with the OTP.
func DecodeRootToken(encoded, otp string) (string, error) {
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil {
		return "", fmt.Errorf("decode root token: %w", err)
	}
	if len(raw) != len(otp) {
		return "", errors.New("decode root token: length mismatch with OTP")
	}
	out := make([]byte, len(raw))
	for i := range raw {
		out[i] = raw[i] ^ otp[i]
	}
	return string(out), nil
}

// ---- Tokens ----

// TokenInfo is token metadata from lookup-self.
type TokenInfo struct {
	Accessor   string   `json:"accessor"`
	Policies   []string `json:"policies"`
	TTL        int64    `json:"ttl"`
	Period     int64    `json:"period"`
	Orphan     bool     `json:"orphan"`
	ExpireTime string   `json:"expire_time"`
}

// CreateOrphanToken creates a periodic orphan token.
func (c *Client) CreateOrphanToken(ctx context.Context, policies []string, period, displayName string) (string, time.Duration, error) {
	var r struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int64  `json:"lease_duration"`
		} `json:"auth"`
	}
	err := c.Request(ctx, http.MethodPost, "auth/token/create-orphan", map[string]any{
		"policies": policies, "period": period, "display_name": displayName, "no_default_policy": false, "renewable": true}, &r)
	if err != nil {
		return "", 0, err
	}
	if r.Auth.ClientToken == "" {
		return "", 0, errors.New("vault returned no token")
	}
	return r.Auth.ClientToken, time.Duration(r.Auth.LeaseDuration) * time.Second, nil
}

// LookupSelf returns the calling token's metadata.
func (c *Client) LookupSelf(ctx context.Context) (*TokenInfo, error) {
	var r struct {
		Data TokenInfo `json:"data"`
	}
	err := c.Request(ctx, http.MethodGet, "auth/token/lookup-self", nil, &r)
	return &r.Data, err
}

// RenewSelf renews the calling token and returns its new TTL.
func (c *Client) RenewSelf(ctx context.Context) (time.Duration, error) {
	var r struct {
		Auth struct {
			LeaseDuration int64 `json:"lease_duration"`
		} `json:"auth"`
	}
	err := c.Request(ctx, http.MethodPost, "auth/token/renew-self", map[string]any{}, &r)
	return time.Duration(r.Auth.LeaseDuration) * time.Second, err
}

// RevokeSelf revokes the calling token.
func (c *Client) RevokeSelf(ctx context.Context) error {
	return c.Request(ctx, http.MethodPost, "auth/token/revoke-self", map[string]any{}, nil)
}

// ---- Policies, auth, mounts, audit ----

// PutPolicy writes an ACL policy.
func (c *Client) PutPolicy(ctx context.Context, name, hcl string) error {
	return c.Request(ctx, http.MethodPut, "sys/policies/acl/"+url.PathEscape(name), map[string]any{"policy": hcl}, nil)
}

// GetPolicy reads an ACL policy.
func (c *Client) GetPolicy(ctx context.Context, name string) (string, error) {
	var r struct {
		Data struct {
			Policy string `json:"policy"`
		} `json:"data"`
	}
	err := c.Request(ctx, http.MethodGet, "sys/policies/acl/"+url.PathEscape(name), nil, &r)
	return r.Data.Policy, err
}

// ListPolicies lists ACL policy names.
func (c *Client) ListPolicies(ctx context.Context) ([]string, error) {
	var r struct {
		Data struct {
			Keys []string `json:"keys"`
		} `json:"data"`
	}
	err := c.Request(ctx, "LIST", "sys/policies/acl", nil, &r)
	return r.Data.Keys, err
}

// DeletePolicy deletes an ACL policy.
func (c *Client) DeletePolicy(ctx context.Context, name string) error {
	return c.Request(ctx, http.MethodDelete, "sys/policies/acl/"+url.PathEscape(name), nil, nil)
}

// Mount is an auth or secrets mount.
type Mount struct {
	Type        string            `json:"type"`
	Description string            `json:"description"`
	Accessor    string            `json:"accessor"`
	Options     map[string]string `json:"options"`
}

func (c *Client) listMounts(ctx context.Context, path string) (map[string]Mount, error) {
	var r struct {
		Data map[string]Mount `json:"data"`
	}
	if err := c.Request(ctx, http.MethodGet, path, nil, &r); err != nil {
		return nil, err
	}
	return r.Data, nil
}

// ListAuth lists auth mounts keyed by path ("userpass/").
func (c *Client) ListAuth(ctx context.Context) (map[string]Mount, error) {
	return c.listMounts(ctx, "sys/auth")
}

// EnableAuth enables an auth method at path.
func (c *Client) EnableAuth(ctx context.Context, path, typ, description string) error {
	return c.Request(ctx, http.MethodPost, "sys/auth/"+escapePath(path), map[string]any{"type": typ, "description": description}, nil)
}

// DisableAuth disables the auth method at path.
func (c *Client) DisableAuth(ctx context.Context, path string) error {
	return c.Request(ctx, http.MethodDelete, "sys/auth/"+escapePath(path), nil, nil)
}

// ListMounts lists secrets engines keyed by path ("secret/").
func (c *Client) ListMounts(ctx context.Context) (map[string]Mount, error) {
	return c.listMounts(ctx, "sys/mounts")
}

// EnableAudit enables an audit device.
func (c *Client) EnableAudit(ctx context.Context, name, typ string, options map[string]string) error {
	return c.Request(ctx, http.MethodPut, "sys/audit/"+url.PathEscape(name), map[string]any{"type": typ, "options": options}, nil)
}

// ListAudit lists audit devices keyed by path.
func (c *Client) ListAudit(ctx context.Context) (map[string]Mount, error) {
	return c.listMounts(ctx, "sys/audit")
}

// escapePath escapes each segment of a slash-separated path.
func escapePath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// ---- KV ----

// KVSecret is a KV entry.
type KVSecret struct {
	Data     map[string]any `json:"data"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// KVRead reads a secret; version applies to KV v2 (0 = latest).
func (c *Client) KVRead(ctx context.Context, mount, path string, v2 bool, version int) (*KVSecret, error) {
	if v2 {
		p := escapePath(mount) + "/data/" + escapePath(path)
		if version > 0 {
			p += "?version=" + strconv.Itoa(version)
		}
		var r struct {
			Data KVSecret `json:"data"`
		}
		err := c.Request(ctx, http.MethodGet, p, nil, &r)
		return &r.Data, err
	}
	var r struct {
		Data map[string]any `json:"data"`
	}
	err := c.Request(ctx, http.MethodGet, escapePath(mount)+"/"+escapePath(path), nil, &r)
	return &KVSecret{Data: r.Data}, err
}

// KVWrite writes a secret; for KV v2 cas is mandatory (0 = must not exist).
func (c *Client) KVWrite(ctx context.Context, mount, path string, v2 bool, data map[string]any, cas int) (map[string]any, error) {
	if v2 {
		var r struct {
			Data map[string]any `json:"data"`
		}
		err := c.Request(ctx, http.MethodPost, escapePath(mount)+"/data/"+escapePath(path),
			map[string]any{"data": data, "options": map[string]any{"cas": cas}}, &r)
		return r.Data, err
	}
	return nil, c.Request(ctx, http.MethodPut, escapePath(mount)+"/"+escapePath(path), data, nil)
}

// KVDelete removes data. KV v2 modes: soft-delete (versions or latest),
// destroy (versions) and delete-metadata (all versions and metadata).
func (c *Client) KVDelete(ctx context.Context, mount, path string, v2 bool, mode string, versions []int) error {
	if !v2 {
		return c.Request(ctx, http.MethodDelete, escapePath(mount)+"/"+escapePath(path), nil, nil)
	}
	m, p := escapePath(mount), escapePath(path)
	switch mode {
	case "soft-delete":
		if len(versions) == 0 {
			return c.Request(ctx, http.MethodDelete, m+"/data/"+p, nil, nil)
		}
		return c.Request(ctx, http.MethodPost, m+"/delete/"+p, map[string]any{"versions": versions}, nil)
	case "destroy":
		if len(versions) == 0 {
			return errors.New("destroy requires versions")
		}
		return c.Request(ctx, http.MethodPost, m+"/destroy/"+p, map[string]any{"versions": versions}, nil)
	case "delete-metadata":
		return c.Request(ctx, http.MethodDelete, m+"/metadata/"+p, nil, nil)
	default:
		return fmt.Errorf("unknown delete mode %q", mode)
	}
}

// KVList lists keys under a path.
func (c *Client) KVList(ctx context.Context, mount, path string, v2 bool) ([]string, error) {
	p := escapePath(mount) + "/"
	if v2 {
		p += "metadata/"
	}
	if path = strings.Trim(path, "/"); path != "" {
		p += escapePath(path) + "/"
	}
	var r struct {
		Data struct {
			Keys []string `json:"keys"`
		} `json:"data"`
	}
	err := c.Request(ctx, "LIST", p, nil, &r)
	if StatusOf(err) == http.StatusNotFound {
		return []string{}, nil
	}
	return r.Data.Keys, err
}

// KVMetadata returns KV v2 metadata (versions, current_version, ...).
func (c *Client) KVMetadata(ctx context.Context, mount, path string) (map[string]any, error) {
	var r struct {
		Data map[string]any `json:"data"`
	}
	err := c.Request(ctx, http.MethodGet, escapePath(mount)+"/metadata/"+escapePath(path), nil, &r)
	return r.Data, err
}

// IsStandbySealRefused reports Vault's refusal to seal a standby node via the
// API (a standby is sealed by restarting its service instead).
func IsStandbySealRefused(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.HasMessage("cannot seal when in standby")
}

// IsNoRekeyInProgress reports that no rekey (or rekey verification) is in progress.
func IsNoRekeyInProgress(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == http.StatusBadRequest && ae.HasMessage("no rekey configuration")
}
