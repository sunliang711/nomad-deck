package audit

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"nomad-deck/internal/db"
)

// Actor identifies who performed an action.
type Actor struct {
	ID       string
	Name     string
	ClientIP string
}

// System actors.
var (
	ActorCron = Actor{Name: "system:cron"}
	ActorCLI  = Actor{Name: "local:cli"}
)

// Event is an audit entry before persistence.
type Event struct {
	Actor           Actor
	Action          string
	ResourceType    string
	ResourceID      string
	ResourceName    string
	Summary         map[string]any
	OperationTaskID string
	Err             error
	Started         time.Time
}

// Recorder persists audit events.
type Recorder struct {
	DB  *db.DB
	Log *slog.Logger
}

// Record redacts and stores an event using q (a transaction or the writer pool).
func (r *Recorder) Record(ctx context.Context, q db.Querier, ev Event) error {
	if q == nil {
		q = r.DB.Writer
	}
	summary := "{}"
	if ev.Summary != nil {
		b, err := json.Marshal(RedactValue(ev.Summary))
		if err == nil {
			summary = string(b)
		}
	}
	now := r.DB.Now()
	rec := &db.AuditLog{
		ID:                 db.NewID(),
		ActorID:            ev.Actor.ID,
		ActorName:          ev.Actor.Name,
		ClientIP:           ev.Actor.ClientIP,
		Action:             ev.Action,
		ResourceType:       ev.ResourceType,
		ResourceID:         ev.ResourceID,
		ResourceName:       ev.ResourceName,
		RequestSummaryJSON: summary,
		OperationTaskID:    ev.OperationTaskID,
		Result:             "success",
		CreatedAt:          now,
	}
	if !ev.Started.IsZero() {
		rec.DurationMS = now.Sub(ev.Started).Milliseconds()
	}
	if ev.Err != nil {
		rec.Result = "failed"
		rec.ErrorMessage = RedactString(ev.Err.Error())
	}
	if err := db.InsertAuditLog(ctx, q, rec); err != nil {
		if r.Log != nil {
			r.Log.Error("write audit log failed", "action", ev.Action, "err", err)
		}
		return err
	}
	return nil
}
