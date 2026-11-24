package api

import (
	"log/slog"
	"net/http"
	"net/netip"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/version"
)

// API holds handler dependencies.
type API struct {
	DB             *db.DB
	Auth           *auth.Service
	Hosts          *hosts.Service
	Proxy          *netx.Manager
	Ops            *ops.Engine
	Releases       *release.Provider
	Log            *slog.Logger
	AllowedOrigins map[string]bool
	TrustedProxies []netip.Prefix
	HTTPS          bool // cookies and HSTS assume the browser uses HTTPS
	Ready          *atomic.Bool
}

// Handler builds the HTTP handler tree.
func (a *API) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(a.recoverer, a.securityHeaders, a.clientIP, a.accessLog)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.Version})
	})
	r.Get("/readyz", a.readyz)

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(a.sameOrigin, a.authenticate)
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "not_found", "接口不存在")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不被允许")
		})

		r.Get("/auth/status", a.authStatus)
		r.Post("/auth/setup", a.authSetup)
		r.Post("/auth/login", a.authLogin)

		r.Group(func(r chi.Router) {
			r.Use(a.requireSession)
			r.Post("/auth/logout", a.authLogout)
			r.Put("/auth/password", a.authChangePassword)
			r.Get("/auth/sessions", a.listSessions)
			r.Delete("/auth/sessions/{id}", a.revokeSession)

			r.Get("/audit-logs", a.listAuditLogs)
			r.Get("/audit-logs/{id}", a.getAuditLog)

			r.Get("/ssh-keys", a.listSSHKeys)
			r.Get("/nodes", a.listNodes)
			r.Get("/nodes/{id}", a.getNode)
			r.Get("/settings", a.getSettings)
			r.Get("/settings/proxy", a.getProxy)
			r.Get("/releases/{product}", a.listReleases)
			r.Get("/operations", a.listOperations)
			r.Get("/operations/{id}", a.getOperation)
			r.Get("/operations/{id}/stream", a.streamOperation)

			r.Group(func(r chi.Router) {
				r.Use(a.requireAdmin)
				r.Get("/admins", a.listAdmins)
				r.Post("/admins", a.createAdmin)
				r.Put("/admins/{id}", a.updateAdmin)
				r.Put("/admins/{id}/role", a.changeRole)
				r.Post("/admins/{id}/reset-password", a.resetPassword)
				r.Post("/admins/{id}/disable", a.disableAdmin)
				r.Post("/admins/{id}/enable", a.enableAdmin)

				r.Post("/ssh-keys", a.importSSHKey)
				r.Post("/ssh-keys/generate", a.generateSSHKey)
				r.Put("/ssh-keys/{id}/default", a.setDefaultSSHKey)
				r.Delete("/ssh-keys/{id}", a.deleteSSHKey)

				r.Post("/nodes", a.createNode)
				r.Put("/nodes/{id}", a.updateNode)
				r.Delete("/nodes/{id}", a.deleteNode)
				r.Put("/nodes/{id}/aliases", a.setNodeAliases)
				r.Post("/nodes/{id}/push-key", a.pushNodeKey)
				r.Post("/nodes/{id}/test", a.testNode)
				r.Post("/nodes/{id}/reset-fingerprint", a.resetNodeFingerprint)

				r.Put("/settings", a.putSettings)
				r.Put("/settings/proxy", a.putProxy)
				r.Post("/settings/proxy/test", a.testProxy)
			})
		})
	})
	return r
}

func (a *API) readyz(w http.ResponseWriter, r *http.Request) {
	if a.Ready == nil || !a.Ready.Load() {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "服务尚未就绪")
		return
	}
	if err := a.DB.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "db_unavailable", "数据库不可用")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func fmtTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
