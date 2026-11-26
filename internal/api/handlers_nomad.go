package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// nomadCluster loads a cluster and checks it is a Nomad cluster.
func (a *API) nomadCluster(w http.ResponseWriter, r *http.Request) (*db.Cluster, bool) {
	c, err := db.GetCluster(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "集群不存在")
		return nil, false
	}
	if err != nil {
		a.writeErr(w, r, err)
		return nil, false
	}
	if c.Type != "nomad" {
		writeError(w, http.StatusBadRequest, "wrong_cluster_type", "该操作只适用于 Nomad 集群")
		return nil, false
	}
	return c, true
}

// taskOrNoContent answers 202 with a task, or 204 when nothing was queued.
func taskOrNoContent(w http.ResponseWriter, t *db.OperationTask) {
	if t == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	taskResponse(w, t)
}

func (a *API) updateCluster(w http.ResponseWriter, r *http.Request) {
	var in nomad.SettingsInput
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok {
		return
	}
	t, err := a.Nomad.UpdateSettings(r.Context(), a.actor(r), c.ID, in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskOrNoContent(w, t)
}

func (a *API) updateNodeConfig(w http.ResponseWriter, r *http.Request) {
	var in nomad.NodeConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok {
		return
	}
	t, err := a.Nomad.UpdateNodeConfig(r.Context(), a.actor(r), c.ID, chi.URLParam(r, "node_id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskOrNoContent(w, t)
}

func (a *API) rotateGossip(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	t, err := a.Nomad.RotateGossip(r.Context(), a.actor(r), c.ID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	taskResponse(w, t)
}

// ---- Governance ----

func (a *API) nomadListNamespaces(w http.ResponseWriter, r *http.Request) {
	out, err := a.Nomad.ListNamespaces(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"namespaces": out})
}

func (a *API) nomadPutNamespace(create bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in nomad.Namespace
		if !decodeJSON(w, r, &in) {
			return
		}
		if !create {
			in.Name = chi.URLParam(r, "name")
		}
		if err := a.Nomad.PutNamespace(r.Context(), a.actor(r), chi.URLParam(r, "id"), in, create); err != nil {
			a.writeErr(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *API) nomadDeleteNamespace(w http.ResponseWriter, r *http.Request) {
	if err := a.Nomad.DeleteNamespace(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadListNodePools(w http.ResponseWriter, r *http.Request) {
	out, err := a.Nomad.ListNodePools(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node_pools": out})
}

func (a *API) nomadPutNodePool(create bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name        string            `json:"name"`
			Description string            `json:"description"`
			Meta        map[string]string `json:"meta"`
		}
		if !decodeJSON(w, r, &in) {
			return
		}
		if !create {
			in.Name = chi.URLParam(r, "name")
		}
		np := nomad.NodePool{Name: in.Name, Description: in.Description, Meta: in.Meta}
		if err := a.Nomad.PutNodePool(r.Context(), a.actor(r), chi.URLParam(r, "id"), np, create); err != nil {
			a.writeErr(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *API) nomadDeleteNodePool(w http.ResponseWriter, r *http.Request) {
	if err := a.Nomad.DeleteNodePool(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadListPolicies(w http.ResponseWriter, r *http.Request) {
	out, err := a.Nomad.ListPolicies(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": out, "templates": nomad.PolicyTemplates})
}

func (a *API) nomadGetPolicy(w http.ResponseWriter, r *http.Request) {
	p, err := a.Nomad.GetPolicy(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policy": p})
}

func (a *API) nomadPutPolicy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Description string `json:"description"`
		Rules       string `json:"rules"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	p := nomad.ACLPolicy{Name: chi.URLParam(r, "name"), Description: in.Description, Rules: in.Rules}
	if err := a.Nomad.PutPolicy(r.Context(), a.actor(r), chi.URLParam(r, "id"), p); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadDeletePolicy(w http.ResponseWriter, r *http.Request) {
	if err := a.Nomad.DeletePolicy(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadListRoles(w http.ResponseWriter, r *http.Request) {
	out, err := a.Nomad.ListRoles(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": out})
}

func (a *API) nomadPutRole(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Policies    []string `json:"policies"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	role, err := a.Nomad.PutRole(r.Context(), a.actor(r), chi.URLParam(r, "id"),
		nomad.ACLRole{ID: chi.URLParam(r, "role_id"), Name: in.Name, Description: in.Description, Policies: in.Policies})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"role": role})
}

func (a *API) nomadDeleteRole(w http.ResponseWriter, r *http.Request) {
	if err := a.Nomad.DeleteRole(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "role_id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadListTokens(w http.ResponseWriter, r *http.Request) {
	out, err := a.Nomad.ListTokens(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

func (a *API) nomadCreateToken(w http.ResponseWriter, r *http.Request) {
	var in nomad.TokenInput
	if !decodeJSON(w, r, &in) {
		return
	}
	tok, err := a.Nomad.CreateToken(r.Context(), a.actor(r), chi.URLParam(r, "id"), in)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok})
}

func (a *API) nomadRevokeToken(w http.ResponseWriter, r *http.Request) {
	if err := a.Nomad.RevokeToken(r.Context(), a.actor(r), chi.URLParam(r, "id"), chi.URLParam(r, "accessor_id")); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) nomadRevealManagementToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	tok, err := a.Nomad.RevealManagementToken(r.Context(), a.actor(r), c.ID)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"management_token": tok})
}

func (a *API) nomadUILogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		TargetURL       string `json:"target_url"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, ok := a.nomadCluster(w, r)
	if !ok || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	link, err := a.Nomad.CreateUILogin(r.Context(), a.actor(r), c.ID, in.TargetURL)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, link)
}
