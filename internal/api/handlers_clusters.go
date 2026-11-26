package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/sshx"
	"nomad-deck/internal/vault"
)

// ---- Views ----

type clusterView struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Type              string          `json:"type"`
	Mode              string          `json:"mode"`
	TLSEnabled        bool            `json:"tls_enabled"`
	PublicAPIURL      string          `json:"public_api_url"`
	InitState         string          `json:"init_state"`
	MaintenanceMode   bool            `json:"maintenance_mode"`
	MaintenanceReason string          `json:"maintenance_reason"`
	HealthStatus      string          `json:"health_status"`
	CAExpiresAt       any             `json:"ca_expires_at"`
	Settings          json.RawMessage `json:"settings"`
	CreatedAt         any             `json:"created_at"`
}

func clusterOf(c *db.Cluster) clusterView {
	return clusterView{ID: c.ID, Name: c.Name, Type: c.Type, Mode: c.Mode, TLSEnabled: c.TLSEnabled, PublicAPIURL: c.PublicAPIURL,
		InitState: c.InitState, MaintenanceMode: c.MaintenanceMode, MaintenanceReason: c.MaintenanceReason,
		HealthStatus: c.HealthStatus, CAExpiresAt: fmtTime(c.CAExpiresAt), Settings: sanitizeClusterSettings(c.ConfigJSON),
		CreatedAt: fmtTime(c.CreatedAt)}
}

func sanitizeClusterSettings(raw string) json.RawMessage {
	if strings.TrimSpace(raw) == "" {
		return json.RawMessage("{}")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return json.RawMessage("{}")
	}
	if dd, ok := m["docker_defaults"].(map[string]any); ok {
		if pp, ok := dd["pull_proxy"].(map[string]any); ok {
			if enc, _ := pp["password_encrypted"].(string); enc != "" {
				pp["password_set"] = true
			}
			delete(pp, "password_encrypted")
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return json.RawMessage("{}")
	}
	return b
}

type memberView struct {
	NodeID           string          `json:"node_id"`
	Name             string          `json:"name"`
	Host             string          `json:"host"`
	Role             string          `json:"role"`
	AdvertiseAddr    string          `json:"advertise_addr"`
	APIAddr          string          `json:"api_addr"`
	ClusterAddr      string          `json:"cluster_addr"`
	InstallState     string          `json:"install_state"`
	InstalledVersion string          `json:"installed_version"`
	ServiceStatus    string          `json:"service_status"`
	RaftRole         string          `json:"raft_role"`
	IsVoter          bool            `json:"is_voter"`
	IsSealed         *bool           `json:"is_sealed"`
	Config           json.RawMessage `json:"config"`
	CertExpiresAt    any             `json:"cert_expires_at"`
	LastSyncedAt     any             `json:"last_synced_at"`
}

func memberOf(m *db.ClusterNode) memberView {
	return memberView{NodeID: m.NodeID, Name: m.NodeName, Host: m.NodeHost, Role: m.Role, AdvertiseAddr: m.AdvertiseAddr,
		APIAddr: m.APIAddr, ClusterAddr: m.ClusterAddr, InstallState: m.InstallState, InstalledVersion: m.InstalledVersion,
		ServiceStatus: m.ServiceStatus, RaftRole: m.RaftRole, IsVoter: m.IsVoter, IsSealed: m.IsSealed,
		Config: json.RawMessage(m.NodeConfigJSON), CertExpiresAt: fmtTime(m.CertExpiresAt), LastSyncedAt: fmtTime(m.LastSyncedAt)}
}

func strictJSON(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after JSON object")
	}
	return nil
}

func taskResponse(w http.ResponseWriter, t *db.OperationTask) {
	writeJSON(w, http.StatusAccepted, map[string]any{"task": t})
}

// driver loads the cluster of the request and returns the driver of its type.
func (a *API) driver(w http.ResponseWriter, r *http.Request) (cluster.Driver, *db.Cluster, bool) {
	c, err := db.GetCluster(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return nil, nil, false
	}
	if err != nil {
		a.writeErr(w, r, err)
		return nil, nil, false
	}
	var d cluster.Driver
	switch c.Type {
	case "vault":
		d = a.Vault.Driver()
	case "nomad":
		d = a.Nomad.Driver()
	default:
		writeError(w, http.StatusNotImplemented, "not_implemented", "不支持的集群类型 "+c.Type)
		return nil, nil, false
	}
	return d, c, true
}

// vaultCluster loads a cluster and checks it is a Vault cluster.
func (a *API) vaultCluster(w http.ResponseWriter, r *http.Request) (*db.Cluster, bool) {
	c, err := db.GetCluster(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return nil, false
	}
	if err != nil {
		a.writeErr(w, r, err)
		return nil, false
	}
	if c.Type != "vault" {
		writeError(w, http.StatusBadRequest, "wrong_cluster_type", "该操作只适用于 Vault 集群")
		return nil, false
	}
	return c, true
}

func (a *API) verifyPassword(w http.ResponseWriter, r *http.Request, password string) bool {
	if err := a.Auth.VerifyPassword(principalFrom(r.Context()), password); err != nil {
		a.writeErr(w, r, err)
		return false
	}
	return true
}

// ---- Clusters ----

func (a *API) listClusters(w http.ResponseWriter, r *http.Request) {
	cs, err := db.ListClusters(r.Context(), a.DB.Reader, r.URL.Query().Get("type"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := []clusterView{}
	for _, c := range cs {
		out = append(out, clusterOf(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"clusters": out})
}

func (a *API) getCluster(w http.ResponseWriter, r *http.Request) {
	c, err := db.GetCluster(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	ms, err := db.ListClusterNodes(r.Context(), a.DB.Reader, c.ID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	members := []memberView{}
	for _, m := range ms {
		members = append(members, memberOf(m))
	}
	resp := map[string]any{"cluster": clusterOf(c), "nodes": members}
	if c.Type == "vault" {
		if cu, err := a.Vault.Custody(r.Context(), c.ID); err == nil {
			resp["custody"] = cu
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) createCluster(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体过大或无法读取")
		return
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &kind); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是合法的 JSON")
		return
	}
	var c *db.Cluster
	var parseErr error
	switch kind.Type {
	case "vault":
		var in vault.CreateInput
		if parseErr = strictJSON(body, &struct {
			Type string `json:"type"`
			*vault.CreateInput
		}{CreateInput: &in}); parseErr == nil {
			c, err = a.Vault.CreateCluster(r.Context(), a.actor(r), in)
		}
	case "nomad":
		var in nomad.CreateInput
		if parseErr = strictJSON(body, &struct {
			Type string `json:"type"`
			*nomad.CreateInput
		}{CreateInput: &in}); parseErr == nil {
			c, err = a.Nomad.CreateCluster(r.Context(), a.actor(r), in)
		}
	default:
		writeError(w, http.StatusBadRequest, "invalid_argument", "type 需为 vault 或 nomad")
		return
	}
	if parseErr != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是合法的 JSON："+parseErr.Error())
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"cluster": clusterOf(c)})
}

func (a *API) deleteCluster(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	if err := d.DeleteUndeployed(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) clusterStatus(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	rep, err := d.Status(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": rep})
}

func (a *API) addClusterNodes(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Nodes []cluster.MemberInput `json:"nodes"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	if err := d.AddMembers(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Nodes); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) clusterPreflight(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmSwap bool `json:"confirm_swap"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	issues, err := d.Preflight(r.Context(), chi.URLParam(r, "id"), in.ConfirmSwap)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	if issues == nil {
		issues = []cluster.PreflightIssue{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues})
}

func (a *API) deployCluster(w http.ResponseWriter, r *http.Request) {
	var in cluster.DeployInput
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.Deploy(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) joinClusterNode(w http.ResponseWriter, r *http.Request) {
	var in cluster.JoinInput
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.NodeJoin(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) removeClusterNode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Force bool `json:"force"`
	}
	if r.Body != nil {
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是合法的 JSON："+err.Error())
			return
		} else if err == nil {
			if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
				writeError(w, http.StatusBadRequest, "invalid_json", "请求体只能包含一个 JSON 对象")
				return
			}
		}
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.NodeRemove(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"), in.Force)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) clusterNodeService(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmSingle bool `json:"confirm_single_node"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.NodeService(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"),
		chi.URLParam(r, "action"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) clusterGate(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	res, err := d.CheckGate(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("node_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"gate": res})
}

func (a *API) upgradePlan(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Version string `json:"version"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	p, err := d.PlanUpgrade(r.Context(), chi.URLParam(r, "id"), in.Version)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (a *API) upgradeCluster(w http.ResponseWriter, r *http.Request) {
	var in cluster.UpgradeInput
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.Upgrade(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) renewCerts(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmSingle bool `json:"confirm_single_node"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.RenewCerts(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) rotateCA(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmSingle   bool   `json:"confirm_single_node"`
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := d.RotateCA(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) supplyCredentials(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UnsealKeys      []string `json:"unseal_keys"`
		RootToken       string   `json:"root_token"`
		Mode            string   `json:"mode"`
		ManagementToken string   `json:"management_token"`
		ConfirmName     string   `json:"confirm_name"`
		CurrentPassword string   `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	_, c, ok := a.driver(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	if c.Type == "nomad" {
		t, err := a.Nomad.SupplyCredentials(r.Context(), a.actor(r), c.ID,
			nomad.CredentialsInput{Mode: in.Mode, ManagementToken: in.ManagementToken, ConfirmName: in.ConfirmName})
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		taskResponse(w, t)
		return
	}
	if err := a.Vault.SupplyCredentials(r.Context(), a.actor(r), c.ID,
		vault.CredentialsInput{UnsealKeys: in.UnsealKeys, RootToken: in.RootToken}); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) reconcileCluster(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	rep, err := d.Reconcile(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report": rep})
}

func (a *API) setMaintenance(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	if err := d.SetMaintenance(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Enabled); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) setClusterProxy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UseProxy bool `json:"use_proxy"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, err := db.GetCluster(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	cfg := map[string]any{}
	if strings.TrimSpace(c.ConfigJSON) != "" {
		_ = json.Unmarshal([]byte(c.ConfigJSON), &cfg)
	}
	cfg["use_proxy"] = in.UseProxy
	b, err := json.Marshal(cfg)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	c.ConfigJSON = string(b)
	if err := db.UpdateClusterSettings(r.Context(), a.DB.Writer, c, a.DB.Now()); err != nil {
		a.writeErr(w, r, err)
		return
	}
	_ = a.Auth.Audit.Record(r.Context(), nil, audit.Event{
		Actor: a.actor(r), Action: "cluster.proxy_update", ResourceType: "cluster",
		ResourceID: c.ID, ResourceName: c.Name, Summary: map[string]any{"use_proxy": in.UseProxy},
	})
	writeJSON(w, http.StatusOK, map[string]any{"cluster": clusterOf(c)})
}

func (a *API) uninstallPlan(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	p, err := d.PlanUninstall(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (a *API) uninstallCluster(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmName     string `json:"confirm_name"`
		CurrentPassword string `json:"current_password"`
		Force           bool   `json:"force"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := d.Uninstall(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmName, in.Force)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) doctorCluster(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	rep, err := d.Doctor(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report": rep})
}

// ---- Snapshots ----

func (a *API) listSnapshots(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	snaps, err := d.ListSnapshots(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
}

func (a *API) createSnapshot(w http.ResponseWriter, r *http.Request) {
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.CreateSnapshot(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) guardSnapshotRotation(w http.ResponseWriter) bool {
	if a.Rotation != nil && a.Rotation.IsRunning() {
		writeError(w, http.StatusConflict, "key_rotation_in_progress", "主密钥轮换进行中，暂不允许下载、恢复或删除快照")
		return false
	}
	return true
}

// downloadSnapshot streams a passphrase-encrypted portable archive. The
// passphrase and password travel in the request body, never in the URL.
func (a *API) downloadSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.guardSnapshotRotation(w) {
		return
	}
	var in struct {
		CurrentPassword string `json:"current_password"`
		Passphrase      string `json:"passphrase"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, c, ok := a.driver(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	if len(in.Passphrase) < 12 {
		writeError(w, http.StatusBadRequest, "invalid_argument", "归档口令至少 12 个字符")
		return
	}
	sid := chi.URLParam(r, "snapshot_id")
	dw := &deferredDownloadWriter{w: w, contentType: "application/octet-stream", filename: c.Name + "-" + sid + ".ndsnap"}
	if err := d.WriteArchive(r.Context(), a.actor(r), c.ID, sid, in.Passphrase, dw); err != nil {
		if !dw.wrote {
			a.writeErr(w, r, err)
			return
		}
		a.Log.Error("snapshot download failed", "err", err)
	}
}

// uploadSnapshot accepts multipart form data: a "passphrase" field
// followed by the archive in a "file" part.
func (a *API) uploadSnapshot(w http.ResponseWriter, r *http.Request) {
	d, c, ok := a.driver(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<30)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_argument", "需要 multipart/form-data 请求")
		return
	}
	pass := ""
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			writeError(w, http.StatusBadRequest, "invalid_argument", "缺少 file 部分")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", "上传内容无法解析")
			return
		}
		switch part.FormName() {
		case "passphrase":
			b, _ := io.ReadAll(io.LimitReader(part, 1024))
			pass = string(b)
		case "file":
			if pass == "" {
				writeError(w, http.StatusBadRequest, "invalid_argument", "passphrase 字段必须位于 file 之前")
				return
			}
			snap, err := d.ImportArchive(r.Context(), a.actor(r), c.ID, readCloser{part}, pass)
			if err != nil {
				a.writeErr(w, r, err)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"snapshot_id": snap.ID})
			return
		}
	}
}

type readCloser struct{ p *multipart.Part }

func (r readCloser) Read(b []byte) (int, error) { return r.p.Read(b) }
func (r readCloser) Close() error               { return r.p.Close() }

func (a *API) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.guardSnapshotRotation(w) {
		return
	}
	var in struct {
		cluster.RestoreInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := d.Restore(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "snapshot_id"), in.RestoreInput)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) deleteSnapshot(w http.ResponseWriter, r *http.Request) {
	if !a.guardSnapshotRotation(w) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	if err := d.DeleteSnapshot(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "snapshot_id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- Vault specific ----

func (a *API) vaultInit(w http.ResponseWriter, r *http.Request) {
	var in vault.InitInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.Init(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultUnseal(w http.ResponseWriter, r *http.Request) {
	var in vault.UnsealInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.Unseal(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultSeal(w http.ResponseWriter, r *http.Request) {
	var in vault.SealInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.Seal(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultCustody(w http.ResponseWriter, r *http.Request) {
	var in struct {
		vault.CustodyInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if in.ClearSuppression && !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	if err := a.Vault.UpdateCustody(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.CustodyInput); err != nil {
		a.writeErr(w, r, err)
		return
	}
	cu, _ := a.Vault.Custody(r.Context(), chi.URLParam(r, "id"))
	writeJSON(w, http.StatusOK, map[string]any{"custody": cu})
}

func (a *API) vaultBackup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		Passphrase      string `json:"passphrase"`
		IncludeHistory  bool   `json:"include_history"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	data, name, err := a.Vault.ExportBackup(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Passphrase, in.IncludeHistory)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (a *API) vaultRecoverToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.RecoverToken(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultGenerateRootToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	tok, err := a.Vault.GenerateRootToken(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"root_token": tok})
}

func (a *API) vaultRevokeRootToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.RevokeToken(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Token); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) vaultUILogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		TargetURL       string `json:"target_url"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	link, err := a.Vault.CreateWrappedUILogin(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.TargetURL)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, link)
}

func (a *API) vaultRekey(w http.ResponseWriter, r *http.Request) {
	var in struct {
		vault.RekeyInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.Rekey(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.RekeyInput)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultKeyGenerations(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	gens, err := a.Vault.Generations(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"generations": gens})
}

func (a *API) vaultListAuth(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	as, err := a.Vault.ListAuth(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"auth": as})
}

func (a *API) vaultEnableAuth(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path        string `json:"path"`
		Type        string `json:"type"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.EnableAuth(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Path, in.Type, in.Description); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) vaultDisableAuth(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.DisableAuth(r.Context(), a.actor(r), chi.URLParam(r, "id"), r.URL.Query().Get("path")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) vaultListPolicies(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	ps, err := a.Vault.ListPolicies(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": ps})
}

func (a *API) vaultGetPolicy(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	p, err := a.Vault.GetPolicy(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": chi.URLParam(r, "name"), "policy": p})
}

func (a *API) vaultPutPolicy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Policy string `json:"policy"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.PutPolicy(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "name"), in.Policy); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) vaultDeletePolicy(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.DeletePolicy(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) vaultKVMounts(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	ms, err := a.Vault.KVMounts(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mounts": ms})
}

// vaultEnableKVMount creates a KV v2 engine after admin authorization.
func (a *API) vaultEnableKVMount(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path        string `json:"path"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.EnableKVMount(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Path, in.Description); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (a *API) vaultKVList(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	q := r.URL.Query()
	keys, err := a.Vault.KVList(r.Context(), chi.URLParam(r, "id"), q.Get("mount"), q.Get("path"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (a *API) vaultKVMetadata(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	q := r.URL.Query()
	md, err := a.Vault.KVMetadata(r.Context(), chi.URLParam(r, "id"), q.Get("mount"), q.Get("path"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"metadata": md})
}

func (a *API) vaultKVRead(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	q := r.URL.Query()
	version, _ := strconv.Atoi(q.Get("version"))
	sec, err := a.Vault.KVRead(r.Context(), a.actor(r), chi.URLParam(r, "id"), q.Get("mount"), q.Get("path"), version)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"secret": sec})
}

func (a *API) vaultKVWrite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Data map[string]any `json:"data"`
		CAS  *int           `json:"cas"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	q := r.URL.Query()
	res, err := a.Vault.KVWrite(r.Context(), a.actor(r), chi.URLParam(r, "id"), q.Get("mount"), q.Get("path"), in.Data, in.CAS)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

func (a *API) vaultKVDelete(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	q := r.URL.Query()
	var versions []int
	for _, v := range strings.Split(q.Get("versions"), ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			versions = append(versions, n)
		}
	}
	if err := a.Vault.KVDelete(r.Context(), a.actor(r), chi.URLParam(r, "id"), q.Get("mount"), q.Get("path"), q.Get("mode"), versions); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) rollbackNodeConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmSingle bool `json:"confirm_single_node"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	d, _, ok := a.driver(w, r)
	if !ok {
		return
	}
	t, err := d.RollbackGeneration(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) vaultInitReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmName     string `json:"confirm_name"`
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.ResetInDoubt(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmName)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

var reLogSince = regexp.MustCompile(`^[0-9A-Za-z :._+-]{1,40}$`)

type sseLineWriter struct {
	mu      *sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
}

func (s *sseLineWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b, _ := json.Marshal(map[string]string{"data": string(p)})
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := fmt.Fprintf(s.w, "event: log\ndata: %s\n\n", b); err != nil {
		return 0, err
	}
	s.flusher.Flush()
	return len(p), nil
}

// streamNodeLogs streams redacted systemd journalctl logs for one cluster node
// over SSE without acquiring any cluster or host operation locks.
func (a *API) streamNodeLogs(w http.ResponseWriter, r *http.Request) {
	clusterID := chi.URLParam(r, "id")
	nodeID := chi.URLParam(r, "node_id")
	cl, err := db.GetCluster(r.Context(), a.DB.Reader, clusterID)
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	unit := map[string]string{"nomad": "nomad.service", "vault": "vault.service"}[cl.Type]
	if unit == "" {
		writeError(w, http.StatusBadRequest, "invalid_argument", "不支持的集群类型："+cl.Type)
		return
	}
	members, err := db.ListClusterNodes(r.Context(), a.DB.Reader, clusterID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	isMember := false
	for _, m := range members {
		if m.NodeID == nodeID {
			isMember = true
			break
		}
	}
	if !isMember {
		writeError(w, http.StatusNotFound, "not_found", "节点不属于该集群")
		return
	}
	node, err := db.GetNode(r.Context(), a.DB.Reader, nodeID)
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "主机不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}

	q := r.URL.Query()
	lines := 200
	if raw := q.Get("lines"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 2000 {
			writeError(w, http.StatusBadRequest, "invalid_argument", "lines 需为 1～2000")
			return
		}
		lines = n
	}
	follow := q.Get("follow") != "false"
	since := q.Get("since")
	if since != "" && !reLogSince.MatchString(since) {
		writeError(w, http.StatusBadRequest, "invalid_argument", "since 参数格式不合法")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no_stream", "当前连接不支持流式输出")
		return
	}
	sessID := principalFrom(r.Context()).Session.ID
	releaseStream, ok := a.acquireLogStream(sessID, node.ID)
	if !ok {
		writeError(w, http.StatusTooManyRequests, "too_many_log_streams", "日志流连接数已达上限，请关闭部分日志窗口后再试")
		return
	}
	defer releaseStream()
	client, err := a.Hosts.Connect(r.Context(), node)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}

	revoked, cancelRevoke := a.Auth.Revocations.Subscribe(sessID)
	defer cancelRevoke()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var args []string
	args = append(args, "journalctl", "-u", sshx.Quote(unit), "-n", strconv.Itoa(lines), "--no-pager", "--output=short-iso")
	if follow {
		args = append(args, "--follow")
	}
	if since != "" {
		args = append(args, "--since", sshx.Quote(since))
	}
	script := strings.Join(args, " ")

	var mu sync.Mutex
	rw := audit.NewWriter(&sseLineWriter{mu: &mu, w: w, flusher: flusher})
	runCtx, cancelRun := context.WithCancel(r.Context())
	defer cancelRun()

	doneCh := make(chan error, 1)
	go func() {
		_, err := client.Run(runCtx, script, sshx.RunOptions{Sudo: true, Stdout: rw, Stderr: rw})
		doneCh <- err
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			cancelRun()
			<-doneCh
			return
		case <-revoked:
			cancelRun()
			<-doneCh
			return
		case <-heartbeat.C:
			mu.Lock()
			_, err := io.WriteString(w, ": ping\n\n")
			if err == nil {
				flusher.Flush()
			}
			mu.Unlock()
			if err != nil {
				cancelRun()
				<-doneCh
				return
			}
		case err := <-doneCh:
			_ = rw.Flush()
			payload := map[string]any{"status": "done"}
			if err != nil && runCtx.Err() == nil {
				payload["status"] = "failed"
				payload["error"] = audit.RedactString(err.Error())
			}
			b, _ := json.Marshal(payload)
			mu.Lock()
			_, _ = fmt.Fprintf(w, "event: done\ndata: %s\n\n", b)
			flusher.Flush()
			mu.Unlock()
			return
		}
	}
}
