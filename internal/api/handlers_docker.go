package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/nomad"
)

func (a *API) getDocker(w http.ResponseWriter, r *http.Request) {
	v, err := a.Nomad.GetDocker(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"docker": v})
}

func (a *API) dockerAction(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerInstallInput
	if !decodeJSON(w, r, &in) {
		return
	}
	id := chi.URLParam(r, "id")
	var (
		t   any
		err error
	)
	switch chi.URLParam(r, "action") {
	case "install":
		t, err = a.Nomad.InstallDocker(r.Context(), a.actor(r), id, in, false)
	case "adopt":
		t, err = a.Nomad.InstallDocker(r.Context(), a.actor(r), id, in, true)
	case "upgrade":
		t, err = a.Nomad.UpgradeDocker(r.Context(), a.actor(r), id, in)
	default:
		writeError(w, http.StatusNotFound, "not_found", "不支持的操作")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"task": t})
}

func (a *API) putDockerConfig(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	t, err := a.Nomad.UpdateDockerConfig(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskOrNoContent(w, t)
}

func (a *API) dockerProxyTest(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	res, err := a.Nomad.TestPullProxy(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

func (a *API) clusterDockerPlan(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Version string `json:"version"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok {
		return
	}
	p, err := a.Nomad.PlanDockerUpgrade(r.Context(), c.ID, in.Version)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (a *API) clusterDockerUpgrade(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerInstallInput
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok {
		return
	}
	t, err := a.Nomad.UpgradeClusterDocker(r.Context(), a.actor(r), c.ID, in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) putDockerDefaults(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok {
		return
	}
	if err := a.Nomad.PutDockerDefaults(r.Context(), a.actor(r), c.ID, in); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) inspectDocker(w http.ResponseWriter, r *http.Request) {
	v, err := a.Nomad.InspectDocker(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"inspect": v})
}

func (a *API) pruneDocker(w http.ResponseWriter, r *http.Request) {
	var in nomad.DockerPruneInput
	if !decodeJSON(w, r, &in) {
		return
	}
	t, err := a.Nomad.PruneDocker(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}
