package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

type adminView struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	Disabled    bool   `json:"disabled"`
	LockedUntil any    `json:"locked_until"`
	LastLoginAt any    `json:"last_login_at"`
	CreatedAt   any    `json:"created_at"`
	UpdatedAt   any    `json:"updated_at"`
}

func adminOf(a *db.Admin) adminView {
	return adminView{ID: a.ID, Username: a.Username, Role: a.Role, Disabled: a.Disabled,
		LockedUntil: fmtTime(a.LockedUntil), LastLoginAt: fmtTime(a.LastLoginAt),
		CreatedAt: fmtTime(a.CreatedAt), UpdatedAt: fmtTime(a.UpdatedAt)}
}

func (a *API) change(r *http.Request, current string) auth.AccountChange {
	return auth.AccountChange{Actor: principalFrom(r.Context()), CurrentPassword: current, ClientIP: clientIPFrom(r.Context())}
}

func (a *API) listAdmins(w http.ResponseWriter, r *http.Request) {
	list, err := a.Auth.ListAdmins(r.Context(), principalFrom(r.Context()))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]adminView, 0, len(list))
	for _, ad := range list {
		out = append(out, adminOf(ad))
	}
	writeJSON(w, http.StatusOK, map[string]any{"admins": out})
}

func (a *API) createAdmin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		Username        string `json:"username"`
		Password        string `json:"password"`
		Role            string `json:"role"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ad, err := a.Auth.CreateAdmin(r.Context(), a.change(r, req.CurrentPassword), req.Username, req.Password, req.Role)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"admin": adminOf(ad)})
}

func (a *API) updateAdmin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		Username        string `json:"username"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ad, err := a.Auth.RenameAdmin(r.Context(), a.change(r, req.CurrentPassword), chi.URLParam(r, "id"), req.Username)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"admin": adminOf(ad)})
}

func (a *API) changeRole(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		Role            string `json:"role"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Auth.ChangeRole(r.Context(), a.change(r, req.CurrentPassword), chi.URLParam(r, "id"), req.Role); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) resetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Auth.ResetPassword(r.Context(), a.change(r, req.CurrentPassword), chi.URLParam(r, "id"), req.NewPassword); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) setDisabled(w http.ResponseWriter, r *http.Request, disabled bool) {
	var req struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Auth.SetDisabled(r.Context(), a.change(r, req.CurrentPassword), chi.URLParam(r, "id"), disabled); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) disableAdmin(w http.ResponseWriter, r *http.Request) { a.setDisabled(w, r, true) }
func (a *API) enableAdmin(w http.ResponseWriter, r *http.Request)  { a.setDisabled(w, r, false) }
