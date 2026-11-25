package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/workbench"
)

func writeRaw(w http.ResponseWriter, key string, raw json.RawMessage) {
	writeJSON(w, http.StatusOK, map[string]json.RawMessage{key: raw})
}

// watch streams changes of several topics over one SSE connection. Each
// topic is backed by one shared upstream blocking query per cluster.
func (a *API) watch(w http.ResponseWriter, r *http.Request) {
	clusterID := chi.URLParam(r, "id")
	topics := strings.Split(r.URL.Query().Get("topics"), ",")
	if len(topics) == 0 || topics[0] == "" || len(topics) > 20 {
		writeError(w, http.StatusBadRequest, "invalid_argument", "topics 需为 1～20 个以逗号分隔的主题")
		return
	}
	for _, t := range topics {
		if err := workbench.ValidTopic(t); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
	}
	if _, err := a.Nomad.API(r.Context(), clusterID); err != nil {
		a.writeErr(w, r, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "no_stream", "当前连接不支持流式输出")
		return
	}
	merged := make(chan workbench.Event, 64)
	for _, t := range topics {
		ch, cancel, err := a.Workbench.Hub.Subscribe(clusterID, t)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", err.Error())
			return
		}
		defer cancel()
		go func(ch <-chan workbench.Event) {
			for {
				select {
				case ev, ok := <-ch:
					if !ok {
						return
					}
					select {
					case merged <- ev:
					case <-r.Context().Done():
						return
					}
				case <-r.Context().Done():
					return
				}
			}
		}(ch)
	}
	revoked, cancelRevoke := a.Auth.Revocations.Subscribe(principalFrom(r.Context()).Session.ID)
	defer cancelRevoke()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-revoked:
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev := <-merged:
			b, _ := json.Marshal(ev)
			if _, err := fmt.Fprintf(w, "event: change\ndata: %s\n\n", b); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (a *API) search(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.Search(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("q"), r.URL.Query().Get("namespace"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "results", raw)
}

func (a *API) jobView(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	raw, err := a.Workbench.JobView(r.Context(), c, ns, id, chi.URLParam(r, "view"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "data", raw)
}

func (a *API) forcePeriodic(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	raw, err := a.Workbench.ForcePeriodic(r.Context(), a.actor(r), c, ns, id)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "result", raw)
}

func (a *API) dispatchJob(w http.ResponseWriter, r *http.Request) {
	c, ns, id, ok := a.withJob(w, r)
	if !ok {
		return
	}
	var in workbench.DispatchInput
	if !decodeJSON(w, r, &in) {
		return
	}
	raw, err := a.Workbench.Dispatch(r.Context(), a.actor(r), c, ns, id, in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "result", raw)
}

func (a *API) deploymentAction(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Groups []string `json:"groups"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	raw, err := a.Workbench.DeploymentAction(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "dep_id"),
		chi.URLParam(r, "action"), in.Groups)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "result", raw)
}

func (a *API) allocDetail(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.Alloc(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "allocation", raw)
}

func (a *API) allocStats(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.AllocStats(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "stats", raw)
}

func (a *API) allocChecks(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.AllocChecks(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "checks", raw)
}

func (a *API) allocAction(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Task   string `json:"task"`
		Signal string `json:"signal"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	raw, err := a.Workbench.AllocAction(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "alloc_id"),
		chi.URLParam(r, "action"), in.Task, in.Signal)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "result", raw)
}

func (a *API) listClients(w http.ResponseWriter, r *http.Request) {
	out, err := a.Workbench.Clients(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}

func (a *API) clientDetail(w http.ResponseWriter, r *http.Request) {
	out, err := a.Workbench.Client(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) clientStats(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.ClientStats(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "stats", raw)
}

func (a *API) clientAction(w http.ResponseWriter, r *http.Request) {
	var in workbench.ClientActionInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := a.Workbench.ClientAction(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "node_id"),
		chi.URLParam(r, "action"), in); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadServers(w http.ResponseWriter, r *http.Request) {
	out, err := a.Workbench.Servers(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) topology(w http.ResponseWriter, r *http.Request) {
	out, err := a.Workbench.Topology(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) evaluations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	raw, err := a.Workbench.Evaluations(r.Context(), chi.URLParam(r, "id"), q.Get("status"), q.Get("job_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "evaluations", raw)
}

func (a *API) evaluation(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.Evaluation(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "eval_id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "evaluation", raw)
}

func (a *API) volumes(w http.ResponseWriter, r *http.Request) {
	out, err := a.Workbench.Volumes(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func volumeRef(r *http.Request) (string, string) {
	id, _ := url.PathUnescape(chi.URLParam(r, "volume_id"))
	ns := r.URL.Query().Get("namespace")
	if ns == "" {
		ns = "default"
	}
	return ns, id
}

func (a *API) volume(w http.ResponseWriter, r *http.Request) {
	ns, id := volumeRef(r)
	raw, err := a.Workbench.Volume(r.Context(), chi.URLParam(r, "id"), ns, id)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "volume", raw)
}

func (a *API) deleteVolume(w http.ResponseWriter, r *http.Request) {
	ns, id := volumeRef(r)
	if err := a.Workbench.DeregisterVolume(r.Context(), a.actor(r), chi.URLParam(r, "id"), ns, id); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) plugins(w http.ResponseWriter, r *http.Request) {
	raw, err := a.Workbench.Plugins(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeRaw(w, "plugins", raw)
}

func (a *API) listVariables(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := a.Workbench.Variables(r.Context(), chi.URLParam(r, "id"), q.Get("namespace"), q.Get("prefix"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"variables": out})
}

func varRef(r *http.Request) (string, string) {
	q := r.URL.Query()
	ns := q.Get("namespace")
	if ns == "" {
		ns = "default"
	}
	return ns, q.Get("path")
}

func (a *API) getVariable(w http.ResponseWriter, r *http.Request) {
	ns, p := varRef(r)
	v, err := a.Workbench.GetVariable(r.Context(), a.actor(r), chi.URLParam(r, "id"), ns, p, false)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"variable": v})
}

func (a *API) revealVariable(w http.ResponseWriter, r *http.Request) {
	if !decodeJSON(w, r, &struct{}{}) {
		return
	}
	ns, p := varRef(r)
	v, err := a.Workbench.GetVariable(r.Context(), a.actor(r), chi.URLParam(r, "id"), ns, p, true)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"variable": v})
}

func (a *API) putVariable(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items map[string]string `json:"items"`
		CAS   uint64            `json:"cas"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	ns, p := varRef(r)
	meta, err := a.Workbench.PutVariable(r.Context(), a.actor(r), chi.URLParam(r, "id"), ns, p, in.Items, in.CAS)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"variable": meta})
}

func (a *API) deleteVariable(w http.ResponseWriter, r *http.Request) {
	ns, p := varRef(r)
	cas, _ := strconv.ParseUint(r.URL.Query().Get("cas"), 10, 64)
	if err := a.Workbench.DeleteVariable(r.Context(), a.actor(r), chi.URLParam(r, "id"), ns, p, cas); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
