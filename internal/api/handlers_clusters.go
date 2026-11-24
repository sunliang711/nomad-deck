package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/db"
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
		HealthStatus: c.HealthStatus, CAExpiresAt: fmtTime(c.CAExpiresAt), Settings: json.RawMessage(c.ConfigJSON),
		CreatedAt: fmtTime(c.CreatedAt)}
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

func taskResponse(w http.ResponseWriter, t *db.OperationTask) {
	writeJSON(w, http.StatusAccepted, map[string]any{"task": t})
}

// clusterOfType loads a cluster and checks its type is handled.
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
		writeError(w, http.StatusNotImplemented, "not_implemented", "该集群类型的此操作尚未提供")
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
	var in struct {
		Type string `json:"type"`
		vault.CreateInput
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Type != "vault" {
		writeError(w, http.StatusNotImplemented, "not_implemented", "当前只支持创建 Vault 集群")
		return
	}
	c, err := a.Vault.CreateCluster(r.Context(), a.actor(r), in.CreateInput)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"cluster": clusterOf(c)})
}

func (a *API) deleteCluster(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.DeleteUndeployed(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) clusterStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	nodes, health, err := a.Vault.SyncStatus(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"health_status": health, "nodes": nodes})
}

func (a *API) addClusterNodes(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Nodes []vault.MemberInput `json:"nodes"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.AddMembers(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Nodes); err != nil {
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
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	issues, err := a.Vault.Preflight(r.Context(), chi.URLParam(r, "id"), in.ConfirmSwap)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	if issues == nil {
		issues = []vault.PreflightIssue{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues})
}

func (a *API) deployCluster(w http.ResponseWriter, r *http.Request) {
	var in vault.DeployInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.Deploy(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) joinClusterNode(w http.ResponseWriter, r *http.Request) {
	var in vault.JoinInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.NodeJoin(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) removeClusterNode(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.NodeRemove(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"))
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
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.NodeService(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"),
		chi.URLParam(r, "action"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) clusterGate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	res, err := a.Vault.CheckGate(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("node_id"))
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
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	p, err := a.Vault.PlanUpgrade(r.Context(), chi.URLParam(r, "id"), in.Version)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (a *API) upgradeCluster(w http.ResponseWriter, r *http.Request) {
	var in vault.UpgradeInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.Upgrade(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
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
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.RenewCerts(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmSingle)
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
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.RotateCA(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmSingle)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) supplyCredentials(w http.ResponseWriter, r *http.Request) {
	var in struct {
		vault.CredentialsInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	if err := a.Vault.SupplyCredentials(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.CredentialsInput); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) reconcileCluster(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	rep, err := a.Vault.Reconcile(r.Context(), a.actor(r), chi.URLParam(r, "id"))
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
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.SetMaintenance(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.Enabled); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) uninstallPlan(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	p, err := a.Vault.PlanUninstall(r.Context(), chi.URLParam(r, "id"))
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
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.Uninstall(r.Context(), a.actor(r), chi.URLParam(r, "id"), in.ConfirmName)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) doctorCluster(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	rep, err := a.Vault.Doctor(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report": rep})
}

// ---- Snapshots ----

func (a *API) listSnapshots(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	snaps, err := a.Vault.ListSnapshots(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
}

func (a *API) createSnapshot(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	t, err := a.Vault.CreateSnapshot(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

// downloadSnapshot streams a passphrase-encrypted portable archive. The
// passphrase and password travel in the request body, never in the URL.
func (a *API) downloadSnapshot(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		Passphrase      string `json:"passphrase"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.vaultCluster(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	if len(in.Passphrase) < 12 {
		writeError(w, http.StatusBadRequest, "invalid_argument", "归档口令至少 12 个字符")
		return
	}
	sid := chi.URLParam(r, "snapshot_id")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.ndsnap"`, c.Name, sid))
	if err := a.Vault.WriteArchive(r.Context(), a.actor(r), c.ID, sid, in.Passphrase, w); err != nil {
		a.Log.Error("snapshot download failed", "err", err)
	}
}

// uploadSnapshot accepts multipart form data: a "passphrase" field
// followed by the archive in a "file" part.
func (a *API) uploadSnapshot(w http.ResponseWriter, r *http.Request) {
	c, ok := a.vaultCluster(w, r)
	if !ok {
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_argument", "需要 multipart/form-data 请求")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<30)
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
			snap, err := a.Vault.ImportArchive(r.Context(), a.actor(r), c.ID, readCloser{part}, pass)
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
	var in struct {
		vault.RestoreInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if _, ok := a.vaultCluster(w, r); !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Vault.Restore(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "snapshot_id"), in.RestoreInput)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) deleteSnapshot(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.vaultCluster(w, r); !ok {
		return
	}
	if err := a.Vault.DeleteSnapshot(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "snapshot_id")); err != nil {
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
