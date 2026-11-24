package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
)

type userView struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func userOf(a *db.Admin) userView { return userView{ID: a.ID, Username: a.Username, Role: a.Role} }

func (a *API) authStatus(w http.ResponseWriter, r *http.Request) {
	needs, err := a.Auth.NeedsSetup(r.Context())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	resp := map[string]any{"needs_setup": needs, "authenticated": false}
	if p := principalFrom(r.Context()); p != nil {
		c, _ := r.Cookie(SessionCookie)
		resp["authenticated"] = true
		resp["user"] = userOf(p.Admin)
		resp["csrf_token"] = a.Auth.CSRFToken(c.Value)
		resp["session_expires_at"] = fmtTime(p.Session.ExpiresAt)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) authSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SetupToken string `json:"setup_token"`
		Username   string `json:"username"`
		Password   string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	admin, err := a.Auth.Setup(r.Context(), auth.SetupInput{SetupToken: req.SetupToken, Username: req.Username,
		Password: req.Password, ClientIP: clientIPFrom(r.Context())})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": userOf(admin)})
}

func (a *API) authLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := a.Auth.Login(r.Context(), req.Username, req.Password, clientIPFrom(r.Context()), r.UserAgent())
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: res.Token, Path: "/", HttpOnly: true, Secure: true,
		SameSite: http.SameSiteLaxMode, Expires: res.Session.ExpiresAt,
		MaxAge: int(time.Until(res.Session.ExpiresAt).Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"user": userOf(res.Admin), "csrf_token": res.CSRFToken, "session_expires_at": fmtTime(res.Session.ExpiresAt),
	})
}

func (a *API) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(0, 0)})
}

func (a *API) authLogout(w http.ResponseWriter, r *http.Request) {
	if err := a.Auth.Logout(r.Context(), principalFrom(r.Context()), clientIPFrom(r.Context())); err != nil {
		a.writeErr(w, r, err)
		return
	}
	a.clearCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) authChangePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := a.Auth.ChangePassword(r.Context(), principalFrom(r.Context()), req.CurrentPassword, req.NewPassword,
		clientIPFrom(r.Context())); err != nil {
		a.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type sessionView struct {
	ID         string `json:"id"`
	AdminID    string `json:"admin_id"`
	ClientIP   string `json:"client_ip"`
	UserAgent  string `json:"user_agent"`
	CreatedAt  any    `json:"created_at"`
	LastSeenAt any    `json:"last_seen_at"`
	ExpiresAt  any    `json:"expires_at"`
	Current    bool   `json:"current"`
}

func (a *API) listSessions(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	sessions, err := a.Auth.ListSessions(r.Context(), p, r.URL.Query().Get("all") == "true")
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]sessionView, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, sessionView{ID: s.ID, AdminID: s.AdminID, ClientIP: s.ClientIP, UserAgent: s.UserAgent,
			CreatedAt: fmtTime(s.CreatedAt), LastSeenAt: fmtTime(s.LastSeenAt), ExpiresAt: fmtTime(s.ExpiresAt),
			Current: s.ID == p.Session.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (a *API) revokeSession(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	id := chi.URLParam(r, "id")
	if err := a.Auth.RevokeSession(r.Context(), p, id, clientIPFrom(r.Context())); err != nil {
		a.writeErr(w, r, err)
		return
	}
	if id == p.Session.ID {
		a.clearCookie(w)
	}
	w.WriteHeader(http.StatusNoContent)
}
