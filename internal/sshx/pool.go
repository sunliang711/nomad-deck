package sshx

import (
	"context"
	"sync"
)

// Pool caches one connection per key (normally the node ID plus pinned host
// key) and bounds the number of concurrent remote operations.
type Pool struct {
	mu      sync.Mutex
	clients map[string]*Client
	sem     chan struct{}
}

// NewPool creates a pool allowing maxConcurrent simultaneous operations.
func NewPool(maxConcurrent int) *Pool {
	if maxConcurrent <= 0 {
		maxConcurrent = 10
	}
	return &Pool{clients: map[string]*Client{}, sem: make(chan struct{}, maxConcurrent)}
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

// Get returns a live cached client for key or dials a new one.
func (p *Pool) Get(ctx context.Context, key string, t Target) (*Client, error) {
	p.mu.Lock()
	c := p.clients[key]
	p.mu.Unlock()
	if c != nil {
		if c.Alive() {
			return c, nil
		}
		p.Drop(key)
	}
	c, err := Dial(ctx, t)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	if old := p.clients[key]; old != nil {
		old.Close()
	}
	p.clients[key] = c
	p.mu.Unlock()
	return c, nil
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
