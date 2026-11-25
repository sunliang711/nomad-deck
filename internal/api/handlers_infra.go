package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/sshx"
)

func (a *API) actor(r *http.Request) audit.Actor {
	return principalFrom(r.Context()).Actor(clientIPFrom(r.Context()))
}

// ---- SSH keys ----

type sshKeyView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Algorithm   string `json:"algorithm"`
	PublicKey   string `json:"public_key"`
	Fingerprint string `json:"fingerprint"`
	IsDefault   bool   `json:"is_default"`
	CreatedAt   any    `json:"created_at"`
	SetupCmd    string `json:"setup_command"`
}

func sshKeyOf(k *db.SSHKey) sshKeyView {
	cmd := `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
		`(grep -qxF ` + sshx.Quote(k.PublicKey) + ` ~/.ssh/authorized_keys || echo ` + sshx.Quote(k.PublicKey) + ` >> ~/.ssh/authorized_keys)`
	return sshKeyView{ID: k.ID, Name: k.Name, Algorithm: k.Algorithm, PublicKey: k.PublicKey, Fingerprint: k.Fingerprint,
		IsDefault: k.IsDefault, CreatedAt: fmtTime(k.CreatedAt), SetupCmd: cmd}
}

func (a *API) listSSHKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := db.ListSSHKeys(r.Context(), a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]sshKeyView, 0, len(keys))
	for _, k := range keys {
		out = append(out, sshKeyOf(k))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ssh_keys": out})
}

func (a *API) importSSHKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		PrivateKey string `json:"private_key"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	k, err := a.Hosts.ImportKey(r.Context(), a.actor(r), req.Name, req.PrivateKey)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ssh_key": sshKeyOf(k)})
}

func (a *API) generateSSHKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	k, err := a.Hosts.GenerateKey(r.Context(), a.actor(r), req.Name)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ssh_key": sshKeyOf(k)})
}

func (a *API) setDefaultSSHKey(w http.ResponseWriter, r *http.Request) {
	if err := a.Hosts.SetDefaultKey(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) deleteSSHKey(w http.ResponseWriter, r *http.Request) {
	if err := a.Hosts.DeleteKey(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- Nodes ----

type nodeView struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	Host               string            `json:"host"`
	SSHPort            int               `json:"ssh_port"`
	SSHUser            string            `json:"ssh_user"`
	SSHKeyID           string            `json:"ssh_key_id"`
	UseSudo            bool              `json:"use_sudo"`
	SudoReady          bool              `json:"sudo_ready"`
	SELinuxMode        string            `json:"selinux_mode"`
	SwapEnabled        bool              `json:"swap_enabled"`
	OSFamily           string            `json:"os_family"`
	OSCodename         string            `json:"os_codename"`
	PackageManager     string            `json:"package_manager"`
	DockerMode         string            `json:"docker_mode"`
	DockerStatus       string            `json:"docker_status"`
	DockerVersion      string            `json:"docker_version"`
	MachineID          string            `json:"machine_id"`
	AddressAliases     []string          `json:"address_aliases"`
	TimeSync           string            `json:"time_sync"`
	ClockSkewMS        int64             `json:"clock_skew_ms"`
	HostKeyFingerprint string            `json:"host_key_fingerprint"`
	OSInfo             string            `json:"os_info"`
	Arch               string            `json:"arch"`
	CPUCores           int               `json:"cpu_cores"`
	CPUPercent         float64           `json:"cpu_percent"`
	MemTotalBytes      int64             `json:"mem_total_bytes"`
	MemUsedBytes       int64             `json:"mem_used_bytes"`
	MemPercent         float64           `json:"mem_percent"`
	Status             string            `json:"status"`
	LastCheckedAt      any               `json:"last_checked_at"`
	Labels             map[string]string `json:"labels"`
	Notes              string            `json:"notes"`
	CreatedAt          any               `json:"created_at"`
	UpdatedAt          any               `json:"updated_at"`
}

func nodeOf(n *db.Node) nodeView {
	v := nodeView{ID: n.ID, Name: n.Name, Host: n.Host, SSHPort: n.SSHPort, SSHUser: n.SSHUser, SSHKeyID: n.SSHKeyID,
		UseSudo: n.UseSudo, SudoReady: n.SudoReady, SELinuxMode: n.SELinuxMode, SwapEnabled: n.SwapEnabled,
		OSFamily: n.OSFamily, OSCodename: n.OSCodename, PackageManager: n.PackageManager, DockerMode: n.DockerMode,
		DockerStatus: n.DockerStatus, DockerVersion: n.DockerVersion, MachineID: n.MachineID, TimeSync: n.TimeSync,
		ClockSkewMS: n.ClockSkewMS, HostKeyFingerprint: n.HostKeyFingerprint, OSInfo: n.OSInfo, Arch: n.Arch,
		CPUCores: n.CPUCores, CPUPercent: n.CPUPercent, MemTotalBytes: n.MemTotalBytes, MemUsedBytes: n.MemUsedBytes, MemPercent: n.MemPercent,
		Status: n.Status, LastCheckedAt: fmtTime(n.LastCheckedAt), Notes: n.Notes,
		CreatedAt: fmtTime(n.CreatedAt), UpdatedAt: fmtTime(n.UpdatedAt)}
	_ = json.Unmarshal([]byte(n.AddressAliasesJSON), &v.AddressAliases)
	_ = json.Unmarshal([]byte(n.LabelsJSON), &v.Labels)
	if v.AddressAliases == nil {
		v.AddressAliases = []string{}
	}
	return v
}

func (a *API) listNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := db.ListNodes(r.Context(), a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]nodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, nodeOf(n))
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out})
}

func (a *API) getNode(w http.ResponseWriter, r *http.Request) {
	n, err := db.GetNode(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "主机不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	var probe json.RawMessage = []byte(n.ProbeJSON)
	if !json.Valid(probe) {
		probe = []byte("{}")
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": nodeOf(n), "probe": probe})
}

func (a *API) createNode(w http.ResponseWriter, r *http.Request) {
	var in hosts.NodeInput
	if !decodeJSON(w, r, &in) {
		return
	}
	n, err := a.Hosts.CreateNode(r.Context(), a.actor(r), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"node": nodeOf(n)})
}

func (a *API) updateNode(w http.ResponseWriter, r *http.Request) {
	var in hosts.NodeInput
	if !decodeJSON(w, r, &in) {
		return
	}
	n, err := a.Hosts.UpdateNode(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": nodeOf(n)})
}

func (a *API) deleteNode(w http.ResponseWriter, r *http.Request) {
	if err := a.Hosts.DeleteNode(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) setNodeAliases(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Aliases []string `json:"aliases"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Hosts.SetAliases(r.Context(), a.actor(r), chi.URLParam(r, "id"), req.Aliases); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) pushNodeKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	err := a.Hosts.PushKey(r.Context(), a.actor(r), chi.URLParam(r, "id"), req.Password)
	req.Password = ""
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) testNode(w http.ResponseWriter, r *http.Request) {
	res, err := a.Hosts.Test(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": nodeOf(res.Node), "probe": res.Probe, "warnings": res.Warnings})
}

func (a *API) refreshNodeMetrics(w http.ResponseWriter, r *http.Request) {
	n, err := a.Hosts.RefreshNodeMetrics(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": nodeOf(n)})
}

func (a *API) refreshAllNodeMetrics(w http.ResponseWriter, r *http.Request) {
	okCount, failCount, err := a.Hosts.RefreshAllMetrics(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	nodes, err := db.ListNodes(r.Context(), a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]nodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, nodeOf(n))
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out, "ok": okCount, "failed": failCount})
}

func (a *API) resetNodeFingerprint(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Auth.VerifyPassword(principalFrom(r.Context()), req.CurrentPassword); err != nil {
		a.writeErr(w, r, err)
		return
	}
	if err := a.Hosts.ResetFingerprint(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
