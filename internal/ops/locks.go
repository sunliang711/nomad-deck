// Package ops runs asynchronous operation tasks: two-level shared/exclusive
// locks, step bookkeeping with redacted log files, live log fan-out for SSE
// and crash recovery of unfinished tasks.
package ops

import (
	"context"
	"sort"
	"sync"
)

// LockMode is shared or exclusive.
type LockMode string

// Lock modes.
const (
	Shared    LockMode = "shared"
	Exclusive LockMode = "exclusive"
)

// LockReq requests one lock.
type LockReq struct {
	Key  string
	Mode LockMode
}

// ClusterLock is the lock key of a cluster.
func ClusterLock(clusterID string) string { return "cluster:" + clusterID }

// HostLock is the lock key of one product on one host.
func HostLock(nodeID, product string) string { return "host:" + nodeID + ":" + product }

type lockState struct {
	shared         int
	exclusive      bool
	waitingWriters int
}

// LockManager grants sets of locks atomically (all or nothing), which rules
// out lock-order deadlocks. Waiting exclusive requests block new shared
// grants on the same key so writers are not starved.
type LockManager struct {
	mu    sync.Mutex
	locks map[string]*lockState
	wake  chan struct{}
}

// NewLockManager creates an empty manager.
func NewLockManager() *LockManager {
	return &LockManager{locks: map[string]*lockState{}, wake: make(chan struct{})}
}

func (m *LockManager) state(key string) *lockState {
	s := m.locks[key]
	if s == nil {
		s = &lockState{}
		m.locks[key] = s
	}
	return s
}

func (m *LockManager) grantable(reqs []LockReq) bool {
	for _, r := range reqs {
		s := m.state(r.Key)
		if r.Mode == Exclusive {
			if s.exclusive || s.shared > 0 {
				return false
			}
		} else if s.exclusive || s.waitingWriters > 0 {
			return false
		}
	}
	return true
}

func (m *LockManager) broadcast() {
	close(m.wake)
	m.wake = make(chan struct{})
}

// Acquire blocks until every lock in reqs is granted or ctx is done. It
// returns a release function.
func (m *LockManager) Acquire(ctx context.Context, reqs []LockReq) (func(), error) {
	reqs = normalize(reqs)
	if len(reqs) == 0 {
		return func() {}, nil
	}
	m.mu.Lock()
	for _, r := range reqs {
		if r.Mode == Exclusive {
			m.state(r.Key).waitingWriters++
		}
	}
	for {
		// A waiting writer must not block itself.
		for _, r := range reqs {
			if r.Mode == Exclusive {
				m.state(r.Key).waitingWriters--
			}
		}
		if m.grantable(reqs) {
			for _, r := range reqs {
				s := m.state(r.Key)
				if r.Mode == Exclusive {
					s.exclusive = true
				} else {
					s.shared++
				}
			}
			m.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { m.release(reqs) }) }, nil
		}
		for _, r := range reqs {
			if r.Mode == Exclusive {
				m.state(r.Key).waitingWriters++
			}
		}
		wake := m.wake
		m.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			m.mu.Lock()
			for _, r := range reqs {
				if r.Mode == Exclusive {
					m.state(r.Key).waitingWriters--
				}
			}
			m.broadcast()
			m.mu.Unlock()
			return nil, ctx.Err()
		}
		m.mu.Lock()
	}
}

func (m *LockManager) release(reqs []LockReq) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range reqs {
		s := m.state(r.Key)
		if r.Mode == Exclusive {
			s.exclusive = false
		} else if s.shared > 0 {
			s.shared--
		}
		if !s.exclusive && s.shared == 0 && s.waitingWriters == 0 {
			delete(m.locks, r.Key)
		}
	}
	m.broadcast()
}

// Busy reports whether key currently has any holder.
func (m *LockManager) Busy(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.locks[key]
	return ok && (s.exclusive || s.shared > 0)
}

// normalize sorts requests and merges duplicates (exclusive wins).
func normalize(reqs []LockReq) []LockReq {
	byKey := map[string]LockMode{}
	for _, r := range reqs {
		if r.Key == "" {
			continue
		}
		if cur, ok := byKey[r.Key]; !ok || (cur == Shared && r.Mode == Exclusive) {
			byKey[r.Key] = r.Mode
		}
	}
	out := make([]LockReq, 0, len(byKey))
	for k, mode := range byKey {
		out = append(out, LockReq{Key: k, Mode: mode})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
