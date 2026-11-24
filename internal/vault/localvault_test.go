package vault

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nomad-deck/internal/pki"
)

// localCluster runs real Vault server processes on 127.0.0.1 with Raft
// storage and TLS. Tests using it are skipped when no vault binary is found
// or with -short.
type localCluster struct {
	t     *testing.T
	bin   string
	dir   string
	caPEM string
	nodes []*localNode
}

type localNode struct {
	name     string
	apiPort  int
	clusPort int
	dir      string
	cfg      string
	mu       sync.Mutex
	cmd      *exec.Cmd
	logBuf   *bytes.Buffer
}

func (n *localNode) addr() string { return fmt.Sprintf("https://127.0.0.1:%d", n.apiPort) }

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func vaultBinary(t *testing.T) string {
	if testing.Short() {
		t.Skip("skipping real Vault test in -short mode")
	}
	if p := os.Getenv("ND_VAULT_BIN"); p != "" {
		return p
	}
	p, err := exec.LookPath("vault")
	if err != nil {
		t.Skip("vault binary not found")
	}
	return p
}

func newLocalCluster(t *testing.T, size int) *localCluster {
	bin := vaultBinary(t)
	dir, err := os.MkdirTemp("", "ndv")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caM, err := pki.NewCA("local test CA", pki.CATTL, now)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := pki.ParseCA(caM.CertPEM, caM.KeyPEM)
	lc := &localCluster{t: t, bin: bin, dir: dir, caPEM: caM.CertPEM}
	for i := 0; i < size; i++ {
		n := &localNode{name: fmt.Sprintf("n%d", i+1), apiPort: freePort(t), clusPort: freePort(t),
			dir: filepath.Join(dir, fmt.Sprintf("n%d", i+1))}
		os.MkdirAll(filepath.Join(n.dir, "raft"), 0o700)
		leaf, err := ca.Issue(pki.Request{CommonName: n.name, Hosts: []string{"127.0.0.1", "localhost"}}, now)
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(n.dir, "ca.crt"), []byte(caM.CertPEM), 0o600)
		os.WriteFile(filepath.Join(n.dir, "server.crt"), []byte(leaf.CertPEM), 0o600)
		os.WriteFile(filepath.Join(n.dir, "server.key"), []byte(leaf.KeyPEM), 0o600)
		lc.nodes = append(lc.nodes, n)
	}
	for _, n := range lc.nodes {
		var joins strings.Builder
		for _, p := range lc.nodes {
			if p != n {
				fmt.Fprintf(&joins, "  retry_join {\n    leader_api_addr = %q\n    leader_ca_cert_file = %q\n  }\n", p.addr(), filepath.Join(n.dir, "ca.crt"))
			}
		}
		n.cfg = filepath.Join(n.dir, "config.hcl")
		cfg := fmt.Sprintf(`disable_mlock = true
cluster_name = "local"
api_addr = %q
cluster_addr = "https://127.0.0.1:%d"
listener "tcp" {
  address = "127.0.0.1:%d"
  cluster_address = "127.0.0.1:%d"
  tls_cert_file = %q
  tls_key_file = %q
}
storage "raft" {
  path = %q
  node_id = %q
%s}
`, n.addr(), n.clusPort, n.apiPort, n.clusPort, filepath.Join(n.dir, "server.crt"), filepath.Join(n.dir, "server.key"),
			filepath.Join(n.dir, "raft"), n.name, joins.String())
		os.WriteFile(n.cfg, []byte(cfg), 0o600)
	}
	t.Cleanup(func() {
		for _, n := range lc.nodes {
			n.stop()
		}
		if t.Failed() {
			for _, n := range lc.nodes {
				if n.logBuf != nil {
					t.Logf("--- %s log ---\n%s", n.name, tail(n.logBuf.String(), 3000))
				}
			}
		}
		os.RemoveAll(dir)
	})
	return lc
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func (lc *localCluster) start(n *localNode) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.logBuf == nil {
		n.logBuf = &bytes.Buffer{}
	}
	cmd := exec.Command(lc.bin, "server", "-config="+n.cfg)
	cmd.Stdout, cmd.Stderr = &lockedWriter{w: n.logBuf}, &lockedWriter{w: n.logBuf}
	cmd.Env = append(os.Environ(), "VAULT_LOG_LEVEL=info")
	if err := cmd.Start(); err != nil {
		lc.t.Fatal(err)
	}
	n.cmd = cmd
	lc.waitUp(n)
}

var logMu sync.Mutex

type lockedWriter struct{ w *bytes.Buffer }

func (l *lockedWriter) Write(p []byte) (int, error) {
	logMu.Lock()
	defer logMu.Unlock()
	return l.w.Write(p)
}

func (n *localNode) stop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.cmd != nil && n.cmd.Process != nil {
		_ = n.cmd.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { n.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			n.cmd.Process.Kill()
			<-done
		}
		n.cmd = nil
	}
}

func (lc *localCluster) client(n *localNode, token string) *Client {
	c, err := NewClient(n.addr(), lc.caPEM, token, 20*time.Second)
	if err != nil {
		lc.t.Fatal(err)
	}
	return c
}

func (lc *localCluster) waitUp(n *localNode) {
	c := lc.client(n, "")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := c.SealStatus(context.Background()); err == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	lc.t.Fatalf("%s did not come up", n.name)
}

func waitFor(t *testing.T, what string, timeout time.Duration, f func() (bool, error)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		ok, err := f()
		if ok {
			return
		}
		last = err
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s (last error: %v)", what, last)
}
