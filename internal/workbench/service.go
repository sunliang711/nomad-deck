package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// Service serves runtime views and operations.
type Service struct {
	DB    *db.DB
	Audit *audit.Recorder
	Nomad *nomad.Service
	Log   *slog.Logger
	Hub   *Hub
	stats *statsCache

	exec     *execState
	execOnce sync.Once
}

var (
	badRequest = cluster.BadRequest
	conflict   = cluster.Conflict
	reUUID     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reNS       = regexp.MustCompile(`^[A-Za-z0-9*][A-Za-z0-9_-]{0,127}$`)
	reJobID    = regexp.MustCompile(`^[^\x00-\x1f]{1,256}$`)
)

// Init wires the hub.
func (s *Service) Init() {
	if s.Hub == nil {
		s.Hub = &Hub{Log: s.Log}
	}
	s.Hub.Client = s.Nomad.API
	s.stats = newStatsCache()
}

func (s *Service) api(ctx context.Context, clusterID string) (*nomad.Client, error) {
	return s.Nomad.API(ctx, clusterID)
}

func validUUID(id string) error {
	if !reUUID.MatchString(id) {
		return badRequest("ID 格式不正确")
	}
	return nil
}

func validJob(ns, jobID string) error {
	if !reNS.MatchString(ns) || ns == "*" || !reJobID.MatchString(jobID) {
		return badRequest("Namespace 或 Job ID 不合法")
	}
	return nil
}

func jobPath(ns, jobID, sub string) string {
	p := "job/" + url.PathEscape(jobID)
	if sub != "" {
		p += "/" + sub
	}
	return p + "?namespace=" + url.QueryEscape(ns)
}

// nomadErr maps Nomad errors to API errors.
func nomadErr(err error) error {
	var ae *nomad.APIError
	if !errors.As(err, &ae) {
		return err
	}
	switch {
	case ae.Status == 404 || strings.Contains(strings.ToLower(ae.Message), "not found"):
		return &auth.Error{Status: 404, Code: "not_found", Message: "Nomad 返回：对象不存在"}
	case ae.Status == 400 || ae.Status == 409:
		return &auth.Error{Status: 400, Code: "nomad_rejected", Message: "Nomad 拒绝了请求：" + ae.Message}
	case ae.Status == 403:
		return &auth.Error{Status: 502, Code: "nomad_permission", Message: "托管的 Management Token 被拒绝：" + ae.Message}
	}
	if strings.Contains(strings.ToLower(ae.Message), "index") && strings.Contains(strings.ToLower(ae.Message), "cas") {
		return conflict("cas_conflict", "对象已被他人修改，请刷新后重试")
	}
	return &auth.Error{Status: 502, Code: "nomad_error", Message: ae.Error()}
}

// get performs a GET and returns the raw JSON body.
func (s *Service) get(ctx context.Context, clusterID, path string) (json.RawMessage, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	if err := c.Request(ctx, "GET", path, nil, &raw); err != nil {
		return nil, nomadErr(err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("null")
	}
	return raw, nil
}

func (s *Service) auditOp(ctx context.Context, actor audit.Actor, clusterID, action, resource string, summary map[string]any, err error) {
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "nomad." + action, ResourceType: "nomad_runtime",
		ResourceID: clusterID + "/" + resource, ResourceName: resource, Summary: summary, Err: err})
}

var (
	reSignal = regexp.MustCompile(`^SIG[A-Z0-9]{2,12}$`)
	reWord   = regexp.MustCompile(`^[a-z_]{1,32}$`)
	reVolID  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)
