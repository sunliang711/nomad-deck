package sshx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Target describes how to reach and authenticate to a host.
type Target struct {
	Host     string
	Port     int
	User     string
	UseSudo  bool
	Signer   ssh.Signer // key authentication
	Password string     // one-time password authentication (key push only)
	// HostKeyFingerprint is the pinned SHA256 fingerprint; empty means trust
	// on first use (the observed fingerprint is returned by Dial).
	HostKeyFingerprint string
	Timeout            time.Duration
}

// ErrHostKeyMismatch is returned when the presented host key differs from the pinned one.
type ErrHostKeyMismatch struct {
	Expected, Actual string
}

func (e *ErrHostKeyMismatch) Error() string {
	return fmt.Sprintf("host key mismatch: expected %s, got %s", e.Expected, e.Actual)
}

// Client is an authenticated SSH connection.
type Client struct {
	ssh                *ssh.Client
	target             Target
	HostKeyFingerprint string

	sftpMu sync.Mutex
	sftp   *sftp.Client
}

// Dial connects and authenticates. On first use (no pinned fingerprint) the
// observed host key fingerprint is available as Client.HostKeyFingerprint.
func Dial(ctx context.Context, t Target) (*Client, error) {
	if t.Port == 0 {
		t.Port = 22
	}
	if t.Timeout == 0 {
		t.Timeout = 15 * time.Second
	}
	var auths []ssh.AuthMethod
	if t.Signer != nil {
		auths = append(auths, ssh.PublicKeys(t.Signer))
	}
	if t.Password != "" {
		pw := t.Password
		auths = append(auths, ssh.Password(pw), ssh.KeyboardInteractive(
			func(_, _ string, questions []string, _ []bool) ([]string, error) {
				ans := make([]string, len(questions))
				for i := range ans {
					ans[i] = pw
				}
				return ans, nil
			}))
	}
	if len(auths) == 0 {
		return nil, errors.New("no SSH authentication method")
	}
	var observed string
	cfg := &ssh.ClientConfig{
		User:    t.User,
		Auth:    auths,
		Timeout: t.Timeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			observed = ssh.FingerprintSHA256(key)
			if t.HostKeyFingerprint != "" && observed != t.HostKeyFingerprint {
				return &ErrHostKeyMismatch{Expected: t.HostKeyFingerprint, Actual: observed}
			}
			return nil
		},
	}
	addr := net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	d := net.Dialer{Timeout: t.Timeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(t.Timeout))
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		var mm *ErrHostKeyMismatch
		if errors.As(err, &mm) {
			return nil, mm
		}
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	client := &Client{ssh: ssh.NewClient(c, chans, reqs), target: t, HostKeyFingerprint: observed}
	go client.keepalive()
	return client, nil
}

func (c *Client) keepalive() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		if _, _, err := c.ssh.SendRequest("keepalive@openssh.com", true, nil); err != nil {
			return
		}
	}
}

// Close closes the connection.
func (c *Client) Close() error {
	c.sftpMu.Lock()
	if c.sftp != nil {
		c.sftp.Close()
		c.sftp = nil
	}
	c.sftpMu.Unlock()
	return c.ssh.Close()
}

// Alive reports whether the connection still responds.
func (c *Client) Alive() bool {
	_, _, err := c.ssh.SendRequest("keepalive@openssh.com", true, nil)
	return err == nil
}

// RunOptions control a remote command.
type RunOptions struct {
	Sudo   bool // wrap with "sudo -n" when the target uses sudo
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// Result of a remote command.
type Result struct {
	ExitCode int
	Stdout   []byte
	Stderr   []byte
}

// ErrExit is returned for non-zero exit codes.
type ErrExit struct {
	Code   int
	Stderr string
}

func (e *ErrExit) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("remote command exited with %d: %s", e.Code, e.Stderr)
	}
	return fmt.Sprintf("remote command exited with %d", e.Code)
}

// Run executes script with /bin/sh (optionally under sudo). The script text
// must come from a fixed template; dynamic values must be validated or quoted.
// When Stdout/Stderr are nil the output is captured in the result.
func (c *Client) Run(ctx context.Context, script string, opts RunOptions) (*Result, error) {
	sess, err := c.ssh.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()
	cmd := "/bin/sh -c " + Quote(script)
	if opts.Sudo && c.target.UseSudo {
		cmd = "sudo -n -- " + cmd
	}
	var outBuf, errBuf bytes.Buffer
	res := &Result{}
	sess.Stdin = opts.Stdin
	if opts.Stdout != nil {
		sess.Stdout = opts.Stdout
	} else {
		sess.Stdout = &limitedBuffer{buf: &outBuf, max: 8 << 20}
	}
	if opts.Stderr != nil {
		sess.Stderr = opts.Stderr
	} else {
		sess.Stderr = &limitedBuffer{buf: &errBuf, max: 1 << 20}
	}
	if err := sess.Start(cmd); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- sess.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGTERM)
		_ = sess.Close()
		return nil, ctx.Err()
	}
	res.Stdout, res.Stderr = outBuf.Bytes(), errBuf.Bytes()
	if err != nil {
		var ee *ssh.ExitError
		if errors.As(err, &ee) {
			res.ExitCode = ee.ExitStatus()
			return res, &ErrExit{Code: res.ExitCode, Stderr: truncateStr(string(res.Stderr), 2000)}
		}
		return res, err
	}
	return res, nil
}

// SFTP returns a shared SFTP client for this connection.
func (c *Client) SFTP() (*sftp.Client, error) {
	c.sftpMu.Lock()
	defer c.sftpMu.Unlock()
	if c.sftp != nil {
		return c.sftp, nil
	}
	s, err := sftp.NewClient(c.ssh)
	if err != nil {
		return nil, err
	}
	c.sftp = s
	return s, nil
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
