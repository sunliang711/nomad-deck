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

// SnapshotLock guards a cluster's stored snapshot files: downloads and
// restores hold it shared, rotation and deletion exclusively.
func SnapshotLock(clusterID string) string { return "snapshots:" + clusterID }

// HostLock is the lock key of one product on one host.
func HostLock(nodeID, product string) string { return "host:" + nodeID + ":" + product }

type lockState struct {
	shared    int
	exclusive bool
}

type lockWaiter struct {
	reqs []LockReq
}

// LockManager grants sets of locks atomically (all or nothing) in FIFO order
// for conflicting waiters, preventing both lock-order deadlocks and writer
// starvation while remaining deadlock-free on mixed Exclusive/Shared lock sets.
type LockManager struct {
	mu      sync.Mutex
	locks   map[string]*lockState
	waiters []*lockWaiter
	wake    chan struct{}
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

func (m *LockManager) waiterIndex(w *lockWaiter) int {
	for i, item := range m.waiters {
		if item == w {
			return i
		}
	}
	return -1
}

func (m *LockManager) removeWaiter(w *lockWaiter) {
	if idx := m.waiterIndex(w); idx >= 0 {
		m.waiters = append(m.waiters[:idx], m.waiters[idx+1:]...)
	}
}

func (m *LockManager) grantable(w *lockWaiter) bool {
	idx := m.waiterIndex(w)
	for _, r := range w.reqs {
		s := m.locks[r.Key]
		if r.Mode == Exclusive {
			if s != nil && (s.exclusive || s.shared > 0) {
				return false
			}
			continue
		}
		if s != nil && s.exclusive {
			return false
		}
		// Only earlier queued exclusive waiters on this key block a shared request.
		for j := 0; j < idx; j++ {
			for _, wr := range m.waiters[j].reqs {
				if wr.Key == r.Key && wr.Mode == Exclusive {
					return false
				}
			}
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
	w := &lockWaiter{reqs: reqs}
	m.mu.Lock()
	m.waiters = append(m.waiters, w)
	for {
		if m.grantable(w) {
			for _, r := range reqs {
				s := m.state(r.Key)
				if r.Mode == Exclusive {
					s.exclusive = true
				} else {
					s.shared++
				}
			}
			m.removeWaiter(w)
			m.broadcast()
			m.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { m.release(reqs) }) }, nil
		}
		wake := m.wake
		m.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			m.mu.Lock()
			m.removeWaiter(w)
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
		s := m.locks[r.Key]
		if s == nil {
			continue
		}
		if r.Mode == Exclusive {
			s.exclusive = false
		} else if s.shared > 0 {
			s.shared--
		}
		if !s.exclusive && s.shared == 0 {
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
