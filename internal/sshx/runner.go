package sshx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// Remote base directory managed by NomadDeck on every host.
const RemoteBase = "/opt/nomad-deck"

// wrapperScript runs one step script, appending its output to a log file and
// persisting status, exit code and timestamps (with fsync) in a result file.
// Usage: nd-step <result-file> <log-file> <script-file>
const wrapperScript = `#!/bin/sh
res="$1"; log="$2"; script="$3"
umask 077
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
persist() { tmp="$res.tmp"; printf '%s\n' "$1" > "$tmp"; sync "$tmp" 2>/dev/null || sync; mv -f "$tmp" "$res"; sync "$(dirname "$res")" 2>/dev/null || true; }
start="$(now)"
persist "{\"status\":\"running\",\"started_at\":\"$start\",\"pid\":$$}"
/bin/sh "$script" >>"$log" 2>&1
code=$?
if [ "$code" -eq 0 ]; then st=success; else st=failed; fi
persist "{\"status\":\"$st\",\"exit_code\":$code,\"started_at\":\"$start\",\"finished_at\":\"$(now)\"}"
exit "$code"
`

var wrapperPath = func() string {
	sum := sha256.Sum256([]byte(wrapperScript))
	return RemoteBase + "/.runner/nd-step-" + hex.EncodeToString(sum[:6])
}()

// StepSpec describes a detached remote step.
type StepSpec struct {
	Product string // nomad | vault | docker | system — selects the results directory
	OpID    string // remote_op_id of the task
	Step    string // step identifier, unique within the task
	Script  string // POSIX shell script built from fixed templates
	Log     io.Writer
	Poll    time.Duration
}

// StepResult is the persisted outcome of a remote step.
type StepResult struct {
	Status     string `json:"status"` // running | success | failed | interrupted | missing
	ExitCode   int    `json:"exit_code"`
	StartedAt  string `json:"started_at"`
	FinishedAt string `json:"finished_at"`
	UnitActive bool   `json:"-"`
}

func (s StepSpec) validate() error {
	for _, v := range []string{s.Product, s.OpID, s.Step} {
		if err := ValidIdent(v); err != nil {
			return err
		}
	}
	return nil
}

func resultsDir(product string) string { return RemoteBase + "/" + product + "/.op-results" }

// UnitName returns the transient systemd unit name of a step.
func UnitName(opID, step string) string { return "nomad-deck-op-" + opID + "-" + step }

func stepPaths(product, opID, step string) (res, log, script string) {
	base := resultsDir(product) + "/" + opID + "-" + step
	return base + ".json", base + ".log", base + ".sh"
}

// writeRootFile writes content to path as root (0700 parent dir, given mode).
func writeRootFile(ctx context.Context, c *Client, path string, content []byte, mode string) error {
	if err := ValidPath(path); err != nil {
		return err
	}
	dir := path[:strings.LastIndex(path, "/")]
	script := fmt.Sprintf(`set -e
install -d -m 0700 %[1]s
tmp=%[2]s.tmp.$$
cat > "$tmp"
chmod %[3]s "$tmp"
mv -f "$tmp" %[2]s
`, Quote(dir), Quote(path), mode)
	_, err := c.Run(ctx, script, RunOptions{Sudo: true, Stdin: bytes.NewReader(content)})
	return err
}

// EnsureRunner installs the step wrapper on the host if missing.
func EnsureRunner(ctx context.Context, c *Client) error {
	if _, err := c.Run(ctx, "test -x "+Quote(wrapperPath), RunOptions{Sudo: true}); err == nil {
		return nil
	}
	return writeRootFile(ctx, c, wrapperPath, []byte(wrapperScript), "0700")
}

// StartStep uploads the script and launches it as a transient systemd unit,
// so it keeps running when the SSH session or the control plane goes away.
func StartStep(ctx context.Context, c *Client, s StepSpec) (string, error) {
	if err := s.validate(); err != nil {
		return "", err
	}
	if err := EnsureRunner(ctx, c); err != nil {
		return "", fmt.Errorf("install step runner: %w", err)
	}
	res, log, script := stepPaths(s.Product, s.OpID, s.Step)
	if err := writeRootFile(ctx, c, script, []byte(s.Script), "0700"); err != nil {
		return "", fmt.Errorf("upload step script: %w", err)
	}
	unit := UnitName(s.OpID, s.Step)
	cmd := fmt.Sprintf("rm -f %s %s && systemd-run --unit=%s --collect --quiet -p Type=exec %s %s %s %s",
		Quote(res), Quote(log), unit, Quote(wrapperPath), Quote(res), Quote(log), Quote(script))
	if _, err := c.Run(ctx, cmd, RunOptions{Sudo: true}); err != nil {
		return "", fmt.Errorf("start transient unit: %w", err)
	}
	return unit, nil
}

// RunStep starts a step and follows its log until it finishes. If ctx is
// cancelled the remote step keeps running and ctx.Err() is returned.
func RunStep(ctx context.Context, c *Client, s StepSpec) (*StepResult, error) {
	if _, err := StartStep(ctx, c, s); err != nil {
		return nil, err
	}
	return FollowStep(ctx, c, s)
}

// FollowStep streams a step's log from the beginning and waits for its result.
func FollowStep(ctx context.Context, c *Client, s StepSpec) (*StepResult, error) {
	if err := s.validate(); err != nil {
		return nil, err
	}
	poll := s.Poll
	if poll <= 0 {
		poll = time.Second
	}
	var offset int64
	missingSince := time.Time{}
	for {
		chunk, r, err := pollStep(ctx, c, s, offset)
		if err != nil {
			return nil, err
		}
		if len(chunk) > 0 && s.Log != nil {
			_, _ = s.Log.Write(chunk)
		}
		offset += int64(len(chunk))
		switch {
		case r.Status == "success" || r.Status == "failed":
			return r, nil
		case r.Status == "running" && !r.UnitActive:
			// The wrapper died without recording an outcome (killed or host rebooted).
			r.Status = "interrupted"
			return r, nil
		case r.Status == "missing" && !r.UnitActive:
			if missingSince.IsZero() {
				missingSince = time.Now()
			} else if time.Since(missingSince) > 10*time.Second {
				r.Status = "interrupted"
				return r, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(poll):
		}
	}
}

// CheckStep reports a step's persisted state without following logs (used
// for crash reconciliation).
func CheckStep(ctx context.Context, c *Client, s StepSpec) (*StepResult, error) {
	if err := s.validate(); err != nil {
		return nil, err
	}
	_, r, err := pollStep(ctx, c, s, 1<<62)
	if err != nil {
		return nil, err
	}
	if r.Status == "running" && !r.UnitActive {
		r.Status = "interrupted"
	}
	return r, nil
}

func pollStep(ctx context.Context, c *Client, s StepSpec, offset int64) ([]byte, *StepResult, error) {
	res, log, _ := stepPaths(s.Product, s.OpID, s.Step)
	marker := "<<ND-" + randomMarker() + ">>"
	script := fmt.Sprintf(`if [ -f %[1]s ]; then tail -c +%[2]d %[1]s; fi
printf '\n%[3]s\n'
cat %[4]s 2>/dev/null || printf '{"status":"missing"}'
printf '\n%[3]s\n'
systemctl is-active %[5]s 2>/dev/null || true
`, Quote(log), offset+1, marker, Quote(res), UnitName(s.OpID, s.Step))
	out, err := c.Run(ctx, script, RunOptions{Sudo: true})
	if err != nil {
		return nil, nil, err
	}
	parts := bytes.Split(out.Stdout, []byte("\n"+marker+"\n"))
	if len(parts) != 3 {
		return nil, nil, errors.New("unexpected step poll output")
	}
	r := &StepResult{}
	if err := json.Unmarshal(bytes.TrimSpace(parts[1]), r); err != nil {
		r.Status = "missing"
	}
	state := strings.TrimSpace(string(parts[2]))
	r.UnitActive = state == "active" || state == "activating" || state == "reloading"
	if offset >= 1<<62 {
		return nil, r, nil
	}
	return parts[0], r, nil
}

// CleanupStep removes a step's result, log and script files.
func CleanupStep(ctx context.Context, c *Client, product, opID, step string) error {
	if err := ValidIdent(product); err != nil {
		return err
	}
	res, log, script := stepPaths(product, opID, step)
	_, err := c.Run(ctx, "rm -f "+Quote(res)+" "+Quote(log)+" "+Quote(script), RunOptions{Sudo: true})
	return err
}

var reOwner = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?$`)

// PutFile writes content to path as root through stdin (so secrets never
// appear in command lines or logs), creating the parent directory with
// dirMode and setting owner ("user" or "user:group") and mode atomically.
func PutFile(ctx context.Context, c *Client, path string, content []byte, mode, owner, dirMode string) error {
	if err := ValidPath(path); err != nil {
		return err
	}
	if !validMode(mode) || !validMode(dirMode) {
		return fmt.Errorf("invalid file mode")
	}
	if owner == "" {
		owner = "root:root"
	}
	if !reOwner.MatchString(owner) {
		return fmt.Errorf("invalid owner %q", owner)
	}
	dir := path[:strings.LastIndex(path, "/")]
	script := fmt.Sprintf(`set -e
install -d -m %[4]s %[1]s
tmp=%[2]s.nd-tmp.$$
trap 'rm -f "$tmp"' EXIT
(umask 077; cat > "$tmp")
chown %[5]s "$tmp"
chmod %[3]s "$tmp"
mv -f "$tmp" %[2]s
trap - EXIT
`, Quote(dir), Quote(path), mode, dirMode, owner)
	_, err := c.Run(ctx, script, RunOptions{Sudo: true, Stdin: bytes.NewReader(content)})
	return err
}
