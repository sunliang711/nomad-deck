package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/backup"
)

func (a *API) getBackupConfig(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	cfg, err := a.Backup.GetConfig(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backup": cfg})
}

func (a *API) putBackupConfig(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	var in struct {
		backup.ConfigInput
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	cfg, err := a.Backup.SaveConfig(r.Context(), a.actor(r), in.ConfigInput)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backup": cfg})
}

func (a *API) testBackupTarget(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	var in backup.TargetInput
	if !decodeJSON(w, r, &in) {
		return
	}
	res, err := a.Backup.TestTarget(r.Context(), a.actor(r), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

func (a *API) runBackup(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	rv, err := a.Backup.RunManual(r.Context(), a.actor(r))
	if err != nil && rv == nil {
		a.writeErr(w, r, err)
		return
	}
	status := http.StatusOK
	if err != nil {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{"run": rv})
}

func (a *API) listBackupHistory(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "" && kind != "control_plane" && kind != "raft_snapshot" {
		writeError(w, http.StatusBadRequest, "invalid_argument", "kind 需为 control_plane 或 raft_snapshot")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	runs, err := a.Backup.ListHistory(r.Context(), kind, limit)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}

func (a *API) listTargetSnapshots(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	items, err := a.Backup.ListTargetSnapshots(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": items})
}

func (a *API) importTargetSnapshot(w http.ResponseWriter, r *http.Request) {
	if a.Backup == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "灾备服务未启用")
		return
	}
	var in struct {
		TargetID   string `json:"target_id"`
		Object     string `json:"object"`
		ClusterID  string `json:"cluster_id"`
		Passphrase string `json:"passphrase"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	snap, err := a.Backup.ImportSnapshotFromTarget(r.Context(), a.actor(r), in.TargetID, in.Object, in.ClusterID, in.Passphrase)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"snapshot_id": snap.ID})
}
