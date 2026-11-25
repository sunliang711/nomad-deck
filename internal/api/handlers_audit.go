package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/db"
)

type auditView struct {
	ID              string          `json:"id"`
	ActorID         string          `json:"actor_id"`
	ActorName       string          `json:"actor_name"`
	ClientIP        string          `json:"client_ip"`
	Action          string          `json:"action"`
	ResourceType    string          `json:"resource_type"`
	ResourceID      string          `json:"resource_id"`
	ResourceName    string          `json:"resource_name"`
	RequestSummary  json.RawMessage `json:"request_summary"`
	OperationTaskID string          `json:"operation_task_id"`
	Result          string          `json:"result"`
	ErrorMessage    string          `json:"error_message"`
	DurationMS      int64           `json:"duration_ms"`
	CreatedAt       any             `json:"created_at"`
}

func auditOf(l *db.AuditLog) auditView {
	summary := json.RawMessage(l.RequestSummaryJSON)
	if !json.Valid(summary) {
		summary = json.RawMessage("{}")
	}
	return auditView{ID: l.ID, ActorID: l.ActorID, ActorName: l.ActorName, ClientIP: l.ClientIP, Action: l.Action,
		ResourceType: l.ResourceType, ResourceID: l.ResourceID, ResourceName: l.ResourceName, RequestSummary: summary,
		OperationTaskID: l.OperationTaskID, Result: l.Result, ErrorMessage: l.ErrorMessage, DurationMS: l.DurationMS,
		CreatedAt: fmtTime(l.CreatedAt)}
}

func parseAuditFilter(w http.ResponseWriter, r *http.Request, defaultLimit int) (db.AuditFilter, bool) {
	q := r.URL.Query()
	f := db.AuditFilter{
		Action:       q.Get("action"),
		ResourceType: q.Get("resource_type"),
		Result:       q.Get("result"),
		ActorName:    q.Get("actor"),
		Keyword:      q.Get("q"),
		Before:       q.Get("before"),
		Limit:        defaultLimit,
	}
	for name, dst := range map[string]*time.Time{"from": &f.From, "to": &f.To} {
		if v := q.Get(name); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid_argument", name+" 需为 RFC 3339 时间")
				return db.AuditFilter{}, false
			}
			*dst = t
		}
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 500 {
			writeError(w, http.StatusBadRequest, "invalid_argument", "limit 需为 1～500")
			return db.AuditFilter{}, false
		}
		f.Limit = n
	}
	return f, true
}

func (a *API) listAuditLogs(w http.ResponseWriter, r *http.Request) {
	f, ok := parseAuditFilter(w, r, 100)
	if !ok {
		return
	}
	logs, err := db.ListAuditLogs(r.Context(), a.DB.Reader, f)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	out := make([]auditView, 0, len(logs))
	for _, l := range logs {
		out = append(out, auditOf(l))
	}
	resp := map[string]any{"audit_logs": out}
	limit := f.Limit
	if limit == 0 {
		limit = 100
	}
	if len(logs) == limit {
		resp["next_before"] = logs[len(logs)-1].ID
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *API) exportAuditLogs(w http.ResponseWriter, r *http.Request) {
	f, ok := parseAuditFilter(w, r, 500)
	if !ok {
		return
	}
	const maxExport = 5000
	var all []*db.AuditLog
	for len(all) < maxExport {
		batch, err := db.ListAuditLogs(r.Context(), a.DB.Reader, f)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
		all = append(all, batch...)
		if len(batch) < f.Limit {
			break
		}
		f.Before = batch[len(batch)-1].ID
	}
	if len(all) > maxExport {
		all = all[:maxExport]
	}

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "json" {
		out := make([]auditView, 0, len(all))
		for _, l := range all {
			out = append(out, auditOf(l))
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit-logs.json"`)
		_ = json.NewEncoder(w).Encode(out)
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="audit-logs.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"id", "created_at", "actor_name", "client_ip", "action", "resource_type", "resource_id", "resource_name", "result", "error_message", "duration_ms", "request_summary_json"})
	for _, l := range all {
		_ = cw.Write([]string{
			l.ID,
			l.CreatedAt.UTC().Format(time.RFC3339),
			l.ActorName,
			l.ClientIP,
			l.Action,
			l.ResourceType,
			l.ResourceID,
			l.ResourceName,
			l.Result,
			l.ErrorMessage,
			strconv.FormatInt(l.DurationMS, 10),
			l.RequestSummaryJSON,
		})
	}
	cw.Flush()
}

func (a *API) getAuditLog(w http.ResponseWriter, r *http.Request) {
	l, err := db.GetAuditLog(r.Context(), a.DB.Reader, chi.URLParam(r, "id"))
	if errors.Is(err, db.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "审计记录不存在")
		return
	}
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit_log": auditOf(l)})
}
