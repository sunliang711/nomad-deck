// Package workbench is the Nomad runtime workbench: shared blocking-query
// subscriptions streamed over SSE, search, job, allocation, client, server,
// topology, storage, evaluation and variable views, and the runtime
// operations on them. Every request goes through the control plane with
// the cluster's management token; browsers never see a Nomad token.
package workbench

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/nomad"
)

// Event is one change of a watched topic.
type Event struct {
	Topic string          `json:"topic"`
	Index uint64          `json:"index"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

// Hub shares one upstream blocking query per cluster and topic among all
// subscribers; a query whose subscribers are all gone is stopped after
// the idle grace period.
type Hub struct {
	mu      sync.Mutex
	queries map[string]*query
	// Client returns a management client for a cluster.
	Client func(ctx context.Context, clusterID string) (*nomad.Client, error)
	// Idle is how long a query outlives its last subscriber (default 60s).
	Idle time.Duration
	// Wait is the blocking query wait (default 5m).
	Wait time.Duration
	Log  *slog.Logger
	// started counts upstream queries started (tests).
	started int
}

type query struct {
	key     string
	cluster string
	topic   string
	subs    map[chan Event]struct{}
	last    *Event
	cancel  context.CancelFunc
	idleAt  time.Time
}

// topicPath maps a topic to its Nomad endpoint and a sanitizer for the
// payload. Topics:
//
//	jobs                       job list (all namespaces)
//	job/<ns>/<job>             job summary
//	allocs/<ns>/<job>          allocations of a job
//	deployments/<ns>/<job>     deployments of a job
//	evals/<ns>/<job>           evaluations of a job
//	alloc/<id>                 one allocation (embedded job removed)
//	deployment/<id>            one deployment
//	nodes                      client nodes
//	node/<id>                  one client node
//	evaluations                all evaluations
func topicPath(topic string) (string, func(json.RawMessage) json.RawMessage, error) {
	parts := strings.Split(topic, "/")
	keep := func(b json.RawMessage) json.RawMessage { return b }
	jobRef := func() (string, string, error) {
		if len(parts) != 3 {
			return "", "", fmt.Errorf("bad topic %q", topic)
		}
		job, err := url.PathUnescape(parts[2])
		if err != nil || job == "" || parts[1] == "" {
			return "", "", fmt.Errorf("bad topic %q", topic)
		}
		return url.QueryEscape(parts[1]), url.PathEscape(job), nil
	}
	switch parts[0] {
	case "jobs":
		return "jobs?namespace=*", keep, nil
	case "job":
		ns, job, err := jobRef()
		return "job/" + job + "/summary?namespace=" + ns, keep, err
	case "allocs":
		ns, job, err := jobRef()
		return "job/" + job + "/allocations?namespace=" + ns, keep, err
	case "deployments":
		ns, job, err := jobRef()
		return "job/" + job + "/deployments?namespace=" + ns, keep, err
	case "evals":
		ns, job, err := jobRef()
		return "job/" + job + "/evaluations?namespace=" + ns, keep, err
	case "alloc":
		if len(parts) != 2 || !reUUID.MatchString(parts[1]) {
			return "", nil, fmt.Errorf("bad topic %q", topic)
		}
		return "allocation/" + parts[1], stripJob, nil
	case "deployment":
		if len(parts) != 2 || !reUUID.MatchString(parts[1]) {
			return "", nil, fmt.Errorf("bad topic %q", topic)
		}
		return "deployment/" + parts[1], keep, nil
	case "nodes":
		return "nodes", keep, nil
	case "node":
		if len(parts) != 2 || !reUUID.MatchString(parts[1]) {
			return "", nil, fmt.Errorf("bad topic %q", topic)
		}
		return "node/" + parts[1], keep, nil
	case "evaluations":
		return "evaluations?namespace=*", keep, nil
	}
	return "", nil, fmt.Errorf("unknown topic %q", topic)
}

// stripJob removes the embedded job definition from an allocation.
func stripJob(b json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(b, &m) != nil {
		return b
	}
	delete(m, "Job")
	out, _ := json.Marshal(m)
	return out
}

// ValidTopic checks a topic name.
func ValidTopic(topic string) error {
	_, _, err := topicPath(topic)
	return err
}

func (h *Hub) idle() time.Duration {
	if h.Idle > 0 {
		return h.Idle
	}
	return 60 * time.Second
}

func (h *Hub) wait() time.Duration {
	if h.Wait > 0 {
		return h.Wait
	}
	return 5 * time.Minute
}

// Subscribe registers a subscriber; the current state is delivered first
// when known. The returned function unsubscribes.
func (h *Hub) Subscribe(clusterID, topic string) (<-chan Event, func(), error) {
	if err := ValidTopic(topic); err != nil {
		return nil, nil, err
	}
	key := clusterID + "|" + topic
	ch := make(chan Event, 16)
	h.mu.Lock()
	if h.queries == nil {
		h.queries = map[string]*query{}
	}
	q := h.queries[key]
	if q == nil {
		ctx, cancel := context.WithCancel(context.Background())
		q = &query{key: key, cluster: clusterID, topic: topic, subs: map[chan Event]struct{}{}, cancel: cancel}
		h.queries[key] = q
		h.started++
		go h.run(ctx, q)
	}
	q.subs[ch] = struct{}{}
	q.idleAt = time.Time{}
	if q.last != nil {
		ch <- *q.last
	}
	h.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(q.subs, ch)
			if len(q.subs) == 0 {
				q.idleAt = time.Now()
			}
			h.mu.Unlock()
		})
	}, nil
}

// Started reports how many upstream queries were started.
func (h *Hub) Started() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.started
}

func (h *Hub) publish(q *query, ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	q.last = &ev
	for ch := range q.subs {
		select {
		case ch <- ev:
		default: // a slow subscriber skips intermediate states
		}
	}
}

// reap stops the query when it has been idle long enough.
func (h *Hub) reap(q *query) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(q.subs) == 0 && !q.idleAt.IsZero() && time.Since(q.idleAt) >= h.idle() {
		delete(h.queries, q.key)
		q.cancel()
		return true
	}
	return false
}

func (h *Hub) run(ctx context.Context, q *query) {
	path, sanitize, _ := topicPath(q.topic)
	var index uint64
	backoff := time.Second
	for {
		if h.reap(q) || ctx.Err() != nil {
			return
		}
		c, err := h.Client(ctx, q.cluster)
		var body json.RawMessage
		var next uint64
		if err == nil {
			// Short waits while nobody listens let an idle query be reaped
			// promptly; the upstream request is shared either way.
			wait := h.wait()
			h.mu.Lock()
			if len(q.subs) == 0 && h.idle() < wait {
				wait = h.idle()
			}
			h.mu.Unlock()
			body, next, err = blocking(ctx, c, path, index, wait)
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			h.publish(q, Event{Topic: q.topic, Index: index, Error: err.Error()})
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		if next < index {
			index = 0 // index went backwards (restore or new leader): resync
			continue
		}
		if next != index || index == 0 {
			index = next
			h.publish(q, Event{Topic: q.topic, Index: index, Data: sanitize(body)})
		}
	}
}

// blocking performs one blocking query and returns the body and X-Nomad-Index.
func blocking(ctx context.Context, c *nomad.Client, path string, index uint64, wait time.Duration) (json.RawMessage, uint64, error) {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	full := fmt.Sprintf("%s/v1/%s%sindex=%d&wait=%ds", c.Addr, path, sep, index, int(wait.Seconds()))
	rctx, cancel := context.WithTimeout(ctx, wait+30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, full, nil)
	if err != nil {
		return nil, 0, err
	}
	if c.Token != "" {
		req.Header.Set("X-Nomad-Token", c.Token)
	}
	hc := *c.HTTP
	hc.Timeout = 0 // the request context bounds the long poll
	resp, err := hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var body json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, 0, err
	}
	if resp.StatusCode >= 300 {
		return nil, 0, fmt.Errorf("nomad: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	idx, _ := strconv.ParseUint(resp.Header.Get("X-Nomad-Index"), 10, 64)
	return body, idx, nil
}
