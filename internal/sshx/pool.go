package sshx

import (
	"context"
	"sync"
)

type dialCall struct {
	done   chan struct{}
	client *Client
	err    error
}

// Pool caches one connection per key (normally the node ID plus pinned host
// key) and bounds the number of concurrent remote operations.
type Pool struct {
	mu      sync.Mutex
	clients map[string]*Client
	dialing map[string]*dialCall
	sem     chan struct{}
}

// NewPool creates a pool allowing maxConcurrent simultaneous operations.
func NewPool(maxConcurrent int) *Pool {
	if maxConcurrent <= 0 {
		maxConcurrent = 10
	}
	return &Pool{clients: map[string]*Client{}, dialing: map[string]*dialCall{}, sem: make(chan struct{}, maxConcurrent)}
}

// Acquire reserves a concurrency slot; call the returned release when done.
func (p *Pool) Acquire(ctx context.Context) (func(), error) {
	select {
	case p.sem <- struct{}{}:
		return func() { <-p.sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Get returns a live cached client for key or dials a new one (deduplicating
// concurrent dials for the same key so active connections are never closed).
func (p *Pool) Get(ctx context.Context, key string, t Target) (*Client, error) {
	for {
		p.mu.Lock()
		c := p.clients[key]
		if c != nil {
			p.mu.Unlock()
			if c.Alive() {
				return c, nil
			}
			p.dropIf(key, c)
			p.mu.Lock()
		}
		if call := p.dialing[key]; call != nil {
			p.mu.Unlock()
			select {
			case <-call.done:
				if call.err == nil && call.client != nil && call.client.Alive() {
					return call.client, nil
				}
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		call := &dialCall{done: make(chan struct{})}
		if p.dialing == nil {
			p.dialing = map[string]*dialCall{}
		}
		p.dialing[key] = call
		p.mu.Unlock()

		dialed, err := Dial(ctx, t)
		p.mu.Lock()
		delete(p.dialing, key)
		var ret *Client
		if err == nil {
			if existing := p.clients[key]; existing != nil && existing.Alive() {
				ret = existing
				dialed.Close()
			} else {
				if existing != nil {
					existing.Close()
				}
				p.clients[key] = dialed
				ret = dialed
			}
		}
		call.client, call.err = ret, err
		close(call.done)
		p.mu.Unlock()
		return ret, err
	}
}

func (p *Pool) dropIf(key string, target *Client) {
	p.mu.Lock()
	c := p.clients[key]
	if c == target {
		delete(p.clients, key)
	} else {
		c = nil
	}
	p.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

// Rekey moves a cached client from oldKey to newKey if oldKey still holds c.
func (p *Pool) Rekey(oldKey, newKey string, c *Client) {
	if oldKey == newKey || c == nil {
		return
	}
	p.mu.Lock()
	if p.clients[oldKey] == c {
		delete(p.clients, oldKey)
	}
	if _, exists := p.clients[newKey]; !exists {
		p.clients[newKey] = c
	}
	p.mu.Unlock()
}

// Drop closes and forgets a cached client.
func (p *Pool) Drop(key string) {
	p.mu.Lock()
	c := p.clients[key]
	delete(p.clients, key)
	p.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

// DropPrefix closes every client whose key starts with prefix.
func (p *Pool) DropPrefix(prefix string) {
	p.mu.Lock()
	var victims []*Client
	for k, c := range p.clients {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			victims = append(victims, c)
			delete(p.clients, k)
		}
	}
	p.mu.Unlock()
	for _, c := range victims {
		c.Close()
	}
}

// Close closes every cached client.
func (p *Pool) Close() {
	p.DropPrefix("")
}
