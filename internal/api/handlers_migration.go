package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/migration"
)

// barrierGuard rejects state-changing requests while the control plane is
// under a global maintenance barrier (for example during an import).
func (a *API) barrierGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if a.Ops != nil {
				if reason := a.Ops.Barrier(); reason != "" {
					writeError(w, http.StatusServiceUnavailable, "maintenance", "控制面处于全局维护状态（"+reason+"），暂不接受变更")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) migrationExport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string   `json:"current_password"`
		Passphrase      string   `json:"passphrase"`
		Include         []string `json:"include"`
	}
	if !decodeJSON(w, r, &in) || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	actor := a.actor(r)
	name := fmt.Sprintf("nomad-deck-%s.ndbundle", time.Now().UTC().Format("20060102T150405Z"))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.Header().Set("Cache-Control", "no-store")
	m, err := a.Migration.Export(r.Context(), migration.ExportOptions{Kind: migration.KindMigration, Include: in.Include,
		Passphrase: in.Passphrase, CreatedBy: actor.Name}, w)
	summary := map[string]any{"include": in.Include}
	if m != nil {
		summary["rows"], summary["log_files"] = m.Rows, m.LogFiles
	}
	_ = a.Auth.Audit.Record(r.Context(), nil, audit.Event{Actor: actor, Action: "migration.export", ResourceType: "control_plane",
		Summary: summary, Err: err})
	if err != nil {
		w.Header().Del("Content-Disposition")
		a.writeErr(w, r, err)
	}
}

// migrationPreview accepts multipart form data: "passphrase" and
// "strategy" fields followed by the bundle in a "file" part.
func (a *API) migrationPreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, migration.MaxBundleSize+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_argument", "需要 multipart/form-data 请求")
		return
	}
	fields := map[string]string{}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			writeError(w, http.StatusBadRequest, "invalid_argument", "缺少 file 部分")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_argument", "上传内容无法解析")
			return
		}
		switch part.FormName() {
		case "passphrase", "strategy":
			b, _ := io.ReadAll(io.LimitReader(part, 1024))
			fields[part.FormName()] = strings.TrimRight(string(b), "\r\n")
		case "file":
			if fields["passphrase"] == "" {
				writeError(w, http.StatusBadRequest, "invalid_argument", "passphrase 字段必须位于 file 之前")
				return
			}
			p := principalFrom(r.Context())
			rep, err := a.Migration.Preview(r.Context(), p.Session.ID, p.Admin.ID, part, fields["passphrase"], fields["strategy"])
			_ = a.Auth.Audit.Record(r.Context(), nil, audit.Event{Actor: a.actor(r), Action: "migration.preview", ResourceType: "control_plane",
				Summary: map[string]any{"strategy": fields["strategy"]}, Err: err})
			if err != nil {
				a.writeErr(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"report": rep})
			return
		}
	}
}

func (a *API) migrationApply(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PreviewToken    string `json:"preview_token"`
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	p := principalFrom(r.Context())
	res, err := a.Migration.Apply(r.Context(), a.actor(r), p.Session.ID, p.Admin.ID, in.PreviewToken)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res, "relogin_required": true})
}

func (a *API) migrationActivate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
	}
	if !decodeJSON(w, r, &in) || !a.verifyPassword(w, r, in.CurrentPassword) {
		return
	}
	n, err := a.Migration.Activate(r.Context(), a.actor(r))
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	if a.Cron != nil {
		a.Cron.Reschedule(r.Context())
	}
	writeJSON(w, http.StatusOK, map[string]any{"activated": true, "released_clusters": n})
}
