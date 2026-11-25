package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/integration"
)

func (a *API) listIntegrations(w http.ResponseWriter, r *http.Request) {
	out, err := a.Integrations.List(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"integrations": out})
}

func (a *API) getIntegration(w http.ResponseWriter, r *http.Request) {
	v, err := a.Integrations.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"integration": v})
}

func (a *API) createIntegration(w http.ResponseWriter, r *http.Request) {
	var in integration.Input
	if !decodeJSON(w, r, &in) {
		return
	}
	v, err := a.Integrations.Create(r.Context(), a.actor(r), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"integration": v})
}

func (a *API) updateIntegration(w http.ResponseWriter, r *http.Request) {
	var in integration.Input
	if !decodeJSON(w, r, &in) {
		return
	}
	v, err := a.Integrations.Update(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"integration": v})
}

func (a *API) deleteIntegration(w http.ResponseWriter, r *http.Request) {
	var in integration.ApplyInput
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体过大或无法读取")
		return
	}
	if len(bytes.TrimSpace(body)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是合法的 JSON："+err.Error())
			return
		}
		if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid_json", "请求体只能包含一个 JSON 对象")
			return
		}
	}
	t, err := a.Integrations.Delete(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskOrNoContent(w, t)
}

func (a *API) listIntegrationRoles(w http.ResponseWriter, r *http.Request) {
	v, err := a.Integrations.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": v.Roles})
}

func (a *API) putIntegrationRole(w http.ResponseWriter, r *http.Request) {
	var in integration.RoleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	v, err := a.Integrations.PutRole(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "role_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"integration": v})
}

func (a *API) deleteIntegrationRole(w http.ResponseWriter, r *http.Request) {
	if err := a.Integrations.DeleteRole(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "role_id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) planIntegration(w http.ResponseWriter, r *http.Request) {
	p, err := a.Integrations.PlanFor(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": p})
}

func (a *API) applyIntegration(w http.ResponseWriter, r *http.Request) {
	var in integration.ApplyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	t, err := a.Integrations.Apply(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

func (a *API) doctorIntegration(w http.ResponseWriter, r *http.Request) {
	var in integration.DoctorInput
	if !decodeJSON(w, r, &in) {
		return
	}
	rep, err := a.Integrations.Doctor(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report": rep})
}

func (a *API) integrationJobExample(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Role       string `json:"role"`
		SecretPath string `json:"secret_path"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	hcl, err := a.Integrations.JobExample(r.Context(), chi.URLParam(r, "id"), in.Role, in.SecretPath)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hcl": hcl})
}
