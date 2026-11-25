// Package api exposes the HTTP REST API and its middleware.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"

	"nomad-deck/internal/auth"
)

// SessionCookie is the name of the session cookie.
const SessionCookie = "nd_session"

type ctxKey int

const (
	ctxPrincipal ctxKey = iota
	ctxClientIP
)

// ErrorBody is the JSON error envelope.
type ErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	var b ErrorBody
	b.Error.Code, b.Error.Message = code, msg
	writeJSON(w, status, b)
}

// writeErr maps service errors to HTTP responses.
func (a *API) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var ae *auth.Error
	if errors.As(err, &ae) {
		if ae.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(int(ae.RetryAfter.Seconds()+0.5)))
		}
		writeError(w, ae.Status, ae.Code, ae.Message)
		return
	}
	a.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "服务器内部错误")
}

// decodeJSON reads a size-limited JSON body, rejecting unknown fields.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是合法的 JSON："+err.Error())
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体只能包含一个 JSON 对象")
		return false
	}
	return true
}

func principalFrom(ctx context.Context) *auth.Principal {
	p, _ := ctx.Value(ctxPrincipal).(*auth.Principal)
	return p
}

func clientIPFrom(ctx context.Context) string {
	s, _ := ctx.Value(ctxClientIP).(string)
	return s
}

// recoverer turns panics into 500 responses.
func (a *API) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				a.Log.Error("panic", "value", v, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal", "服务器内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// securityHeaders sets conservative response headers.
func (a *API) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if a.HTTPS {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP resolves the client address, honoring X-Forwarded-For only from
// trusted proxies.
func (a *API) clientIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := remoteIP(r.RemoteAddr)
		if a.isTrusted(ip) {
			if vals := r.Header.Values("X-Forwarded-For"); len(vals) > 0 {
				xff := strings.Join(vals, ",")
				parts := strings.Split(xff, ",")
				for i := len(parts) - 1; i >= 0; i-- {
					cand := strings.TrimSpace(parts[i])
					if _, err := netip.ParseAddr(cand); err != nil {
						break
					}
					ip = cand
					if !a.isTrusted(cand) {
						break
					}
				}
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxClientIP, ip)))
	})
}

type deferredDownloadWriter struct {
	w           http.ResponseWriter
	contentType string
	filename    string
	wrote       bool
}

func (d *deferredDownloadWriter) Header() http.Header { return d.w.Header() }

func (d *deferredDownloadWriter) Write(p []byte) (int, error) {
	if !d.wrote {
		d.wrote = true
		d.applyHeaders()
		d.w.WriteHeader(http.StatusOK)
	}
	return d.w.Write(p)
}

func (d *deferredDownloadWriter) WriteHeader(statusCode int) {
	if !d.wrote {
		d.wrote = true
		d.applyHeaders()
	}
	d.w.WriteHeader(statusCode)
}

func (d *deferredDownloadWriter) applyHeaders() {
	d.w.Header().Set("Content-Type", d.contentType)
	d.w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": sanitizeDownloadFilename(d.filename),
	}))
	d.w.Header().Set("Cache-Control", "no-store")
	d.w.Header().Set("X-Content-Type-Options", "nosniff")
}

func sanitizeDownloadFilename(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' || r == '"' || r == ';' {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "download.bin"
	}
	return name
}

func (a *API) isTrusted(ip string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, p := range a.TrustedProxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

// sameOrigin rejects state-changing requests whose Origin (or Referer) is not
// one of the allowed management origins.
func (a *API) sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			if ref := r.Header.Get("Referer"); ref != "" {
				if u, err := url.Parse(ref); err == nil && u.Host != "" {
					origin = u.Scheme + "://" + u.Host
				}
			}
		}
		if origin == "" || !a.AllowedOrigins[strings.ToLower(origin)] {
			writeError(w, http.StatusForbidden, "origin_rejected", "请求来源不被允许")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authenticate attaches the principal when a valid session cookie is present.
func (a *API) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(SessionCookie)
		if err == nil && c.Value != "" {
			p, err := a.Auth.Authenticate(r.Context(), c.Value)
			if err == nil {
				r = r.WithContext(context.WithValue(r.Context(), ctxPrincipal, p))
			} else {
				var ae *auth.Error
				if !errors.As(err, &ae) {
					a.Log.Error("authenticate", "err", err)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requireSession rejects anonymous requests and enforces CSRF on unsafe methods.
func (a *API) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := principalFrom(r.Context())
		if p == nil {
			a.writeErr(w, r, auth.ErrUnauthenticated)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if !auth.VerifyCSRF(p.Session, r.Header.Get("X-CSRF-Token")) {
				writeError(w, http.StatusForbidden, "csrf_failed", "CSRF 校验失败")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requireAdmin rejects non-admin principals.
func (a *API) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !principalFrom(r.Context()).IsAdmin() {
			a.writeErr(w, r, auth.ErrForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// accessLog logs each request at debug level.
func (a *API) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if a.Log.Enabled(r.Context(), slog.LevelDebug) {
			a.Log.Debug("http", "method", r.Method, "path", r.URL.Path, "ip", clientIPFrom(r.Context()))
		}
	})
}
