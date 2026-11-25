package jobs

import (
	"testing"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/nomaddev"
)

// env wires the job center to a real Nomad dev agent.
type env struct {
	t      *testing.T
	s      *Service
	cl     *db.Cluster
	dev    *nomaddev.Env
	caller Caller
}

func newEnv(t *testing.T) *env {
	dev := nomaddev.Start(t)
	s := &Service{DB: dev.DB, Keys: dev.Keys, Audit: dev.Audit, Ops: dev.Ops, Nomad: dev.Nomad}
	s.Init()
	return &env{t: t, s: s, cl: dev.Cluster, dev: dev,
		caller: Caller{Actor: audit.Actor{ID: "admin1", Name: "root"}, SessionID: "sess1", IsAdmin: true}}
}

func (e *env) raw() *nomad.Client { return e.dev.Raw() }
