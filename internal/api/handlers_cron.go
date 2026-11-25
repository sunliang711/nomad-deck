package api

import (
	"net/http"
	"strconv"
	"strings"

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

func (a *API) previewCronSchedule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Schedule string `json:"schedule"`
		CronExpr string `json:"cron_expr"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	expr := strings.TrimSpace(req.Schedule)
	if expr == "" {
		expr = strings.TrimSpace(req.CronExpr)
	}
	times, err := a.Cron.Preview(r.Context(), expr, 5)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_cron", err.Error())
		return
	}
	out := make([]string, 0, len(times))
	for _, t := range times {
		out = append(out, t.UTC().Format("2006-01-02T15:04:05Z"))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"next_runs": out,
		"timezone":  a.Cron.Timezone(r.Context()),
	})
}
