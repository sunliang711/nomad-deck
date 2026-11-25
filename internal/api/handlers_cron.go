package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/cron"
)

func (a *API) listCronJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := a.Cron.List(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cron_jobs": jobs})
}

func (a *API) createCronJob(w http.ResponseWriter, r *http.Request) {
	var in cron.JobInput
	if !decodeJSON(w, r, &in) {
		return
	}
	j, err := a.Cron.Create(r.Context(), a.actor(r), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"cron_job": j})
}

func (a *API) updateCronJob(w http.ResponseWriter, r *http.Request) {
	var in cron.JobInput
	if !decodeJSON(w, r, &in) {
		return
	}
	j, err := a.Cron.Update(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cron_job": j})
}

func (a *API) deleteCronJob(w http.ResponseWriter, r *http.Request) {
	if err := a.Cron.Delete(r.Context(), a.actor(r), chi.URLParam(r, "id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) runCronJob(w http.ResponseWriter, r *http.Request) {
	run, err := a.Cron.Trigger(r.Context(), a.actor(r), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	if run == nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"queued": true})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"run": run})
}

func (a *API) listCronRuns(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	runs, err := a.Cron.Runs(r.Context(), chi.URLParam(r, "id"), limit)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
}
