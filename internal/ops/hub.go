package ops

import "sync"

// Progress carries structured stage/download progress for long tasks.
type Progress struct {
	Stage string `json:"stage"`
	Done  int64  `json:"done,omitempty"`
	Total int64  `json:"total,omitempty"`
}

// Event is pushed to live subscribers of a task.
type Event struct {
	Type     string    `json:"type"` // log | step | progress | done
	StepID   string    `json:"step_id,omitempty"`
	Offset   int64     `json:"offset,omitempty"` // byte offset of Data within the step log
	Data     string    `json:"data,omitempty"`
	Status   string    `json:"status,omitempty"`
	Name     string    `json:"name,omitempty"`
	Error    string    `json:"error,omitempty"`
	Progress *Progress `json:"progress,omitempty"`
}

// Hub fans out task events to subscribers. Slow subscribers are dropped
// (their channel is closed) instead of blocking the task.
type Hub struct {
	mu   sync.Mutex
	subs map[string]map[chan Event]struct{}
	done map[string]bool
}

// NewHub creates a hub.
func NewHub() *Hub {
	return &Hub{subs: map[string]map[chan Event]struct{}{}, done: map[string]bool{}}
}

// Subscribe returns an event channel for a task and an unsubscribe func.
// The channel is closed when the task finishes, the subscriber is too slow
// or unsubscribe is called.
func (h *Hub) Subscribe(taskID string) (<-chan Event, func()) {
	ch := make(chan Event, 512)
	h.mu.Lock()
	if h.done[taskID] {
		h.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	if h.subs[taskID] == nil {
		h.subs[taskID] = map[chan Event]struct{}{}
	}
	h.subs[taskID][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if set, ok := h.subs[taskID]; ok {
			if _, ok := set[ch]; ok {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(h.subs, taskID)
			}
		}
		h.mu.Unlock()
	}
}

// Publish delivers an event to every subscriber of a task.
func (h *Hub) Publish(taskID string, ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[taskID] {
		select {
		case ch <- ev:
		default:
			delete(h.subs[taskID], ch)
			close(ch)
		}
	}
	if len(h.subs[taskID]) == 0 {
		delete(h.subs, taskID)
	}
}

// Finish publishes a done event and closes all subscriptions of a task.
func (h *Hub) Finish(taskID string, status, errMsg string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[taskID] {
		select {
		case ch <- Event{Type: "done", Status: status, Error: errMsg}:
		default:
		}
		close(ch)
	}
	delete(h.subs, taskID)
	h.done[taskID] = true
	if len(h.done) > 10000 {
		h.done = map[string]bool{taskID: true}
	}
}
