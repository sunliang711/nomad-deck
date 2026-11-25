package api

import (
	"net/http"

	"nomad-deck/internal/selfupdate"
)

func (a *API) systemVersion(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	q := r.URL.Query()
	refresh := q.Get("refresh") == "true"
	var useProxy *bool
	if v := q.Get("use_proxy"); v != "" {
		b := v == "true"
		useProxy = &b
	}
	info, err := a.SelfUpdate.VersionInfo(r.Context(), refresh, useProxy)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"system": info})
}

func (a *API) startSelfUpdate(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	var in struct {
		TargetVersion string `json:"target_version"`
		UseProxy      *bool  `json:"use_proxy"`
	}
	if r.ContentLength != 0 {
		if !decodeJSON(w, r, &in) {
			return
		}
	}
	task, err := a.SelfUpdate.StartUpgrade(r.Context(), a.actor(r), in.TargetVersion, in.UseProxy)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, task)
}

func (a *API) getSelfUpdateResult(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	res, err := a.SelfUpdate.LastResult(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

func (a *API) getSelfUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	sc, err := a.SelfUpdate.GetSchedule(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedule": sc})
}

func (a *API) createSelfUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	var in selfupdate.ScheduleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	sc, err := a.SelfUpdate.CreateSchedule(r.Context(), a.actor(r), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"schedule": sc})
}

func (a *API) cancelSelfUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	sc, err := a.SelfUpdate.CancelSchedule(r.Context(), a.actor(r))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedule": sc})
}

func (a *API) rollbackSelfUpdate(w http.ResponseWriter, r *http.Request) {
	if a.SelfUpdate == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "自更新服务未启用")
		return
	}
	task, err := a.SelfUpdate.ManualRollback(r.Context(), a.actor(r))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, task)
}
