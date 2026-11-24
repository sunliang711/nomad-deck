package auth

import "sync"

// Revocations notifies long-lived connections (SSE streams, terminals) when
// their session is revoked so they can be closed immediately.
type Revocations struct {
	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{}
}

// NewRevocations creates an empty broadcaster.
func NewRevocations() *Revocations {
	return &Revocations{subs: map[string]map[chan struct{}]struct{}{}}
}

// Subscribe returns a channel closed when sessionID is revoked, and a cancel func.
func (r *Revocations) Subscribe(sessionID string) (<-chan struct{}, func()) {
	ch := make(chan struct{})
	r.mu.Lock()
	if r.subs[sessionID] == nil {
		r.subs[sessionID] = map[chan struct{}]struct{}{}
	}
	r.subs[sessionID][ch] = struct{}{}
	r.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			r.mu.Lock()
			if set, ok := r.subs[sessionID]; ok {
				if _, ok := set[ch]; ok {
					delete(set, ch)
					close(ch)
				}
				if len(set) == 0 {
					delete(r.subs, sessionID)
				}
			}
			r.mu.Unlock()
		})
	}
	return ch, cancel
}

// Revoke closes every subscription of the given sessions.
func (r *Revocations) Revoke(sessionIDs ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range sessionIDs {
		for ch := range r.subs[id] {
			close(ch)
		}
		delete(r.subs, id)
	}
}

// RevokeAll closes every subscription (used after migration import).
func (r *Revocations) RevokeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, set := range r.subs {
		for ch := range set {
			close(ch)
		}
		delete(r.subs, id)
	}
}
