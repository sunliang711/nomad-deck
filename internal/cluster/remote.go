package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/sshx"
)

// BadRequest and Conflict build API errors with the shared error type.
func BadRequest(format string, args ...any) error {
	return &auth.Error{Status: 400, Code: "invalid_argument", Message: fmt.Sprintf(format, args...)}
}

// Conflict builds a 409 error with a machine-readable code.
func Conflict(code, format string, args ...any) error {
	return &auth.Error{Status: 409, Code: code, Message: fmt.Sprintf(format, args...)}
}

// Remote runs product steps on hosts: per-product op lock marker, detached
// transient units for long steps and direct sudo commands for short ones.
type Remote struct {
	DB      *db.DB
	Hosts   *hosts.Service
	Product string // nomad | docker
	// OpLock is the op lock marker path of the product on a host.
	OpLock string
}

// NodeCtx is an open SSH session to one host inside a task step.
type NodeCtx struct {
	Node *db.Node
	SSH  *sshx.Client
	Step *ops.Step
	r    *Remote
	task *ops.Task
	seq  int
}

// Connect opens an SSH session to a host.
func (r *Remote) Connect(ctx context.Context, nodeID string) (*db.Node, *sshx.Client, error) {
	n, err := db.GetNode(ctx, r.DB.Reader, nodeID)
	if err != nil {
		return nil, nil, err
	}
	if r.Hosts == nil {
		return nil, nil, errors.New("SSH is not available")
	}
	c, err := r.Hosts.Connect(ctx, n)
	if err != nil {
		return nil, nil, fmt.Errorf("SSH %s: %w", n.Name, err)
	}
	return n, c, nil
}

// Open starts a task step for a host and writes the product op lock
// marker so a control plane restart can find in-flight remote steps.
func (r *Remote) Open(ctx context.Context, t *ops.Task, nodeID, title string) (*NodeCtx, error) {
	n, c, err := r.Connect(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	step, err := t.Step(title+" "+n.Name, n.ID)
	if err != nil {
		return nil, err
	}
	nc := &NodeCtx{Node: n, SSH: c, Step: step, r: r, task: t}
	b, _ := json.Marshal(map[string]any{"remote_op_id": t.RemoteOpID, "task_id": t.ID, "product": r.Product,
		"unit_prefix": sshx.UnitName(t.RemoteOpID, ""), "started_at": time.Now().UTC().Format(time.RFC3339)})
	if err := sshx.PutFile(ctx, c, r.OpLock, b, "0600", "root:root", "0755"); err != nil {
		step.Finish(err, nil)
		return nil, err
	}
	return nc, nil
}

// Done finishes the step; the op lock marker is removed on success only,
// so a failed or interrupted step stays visible to reconciliation.
func (nc *NodeCtx) Done(ctx context.Context, err error) {
	if err == nil {
		_, _ = nc.SSH.Run(ctx, "rm -f "+sshx.Quote(nc.r.OpLock), sshx.RunOptions{Sudo: true})
	}
	nc.Step.Finish(err, nil)
}

// Remote runs a script as a detached transient systemd unit and follows
// its log; the unit keeps running if the control plane goes away.
func (nc *NodeCtx) Remote(ctx context.Context, name, script string) error {
	nc.seq++
	stepID := fmt.Sprintf("%s-%d", name, nc.seq)
	nc.Step.SetRemoteUnit(sshx.UnitName(nc.task.RemoteOpID, stepID))
	res, err := sshx.RunStep(ctx, nc.SSH, sshx.StepSpec{Product: nc.r.Product, OpID: nc.task.RemoteOpID, Step: stepID,
		Script: script, Log: nc.Step.Log(), Poll: 500 * time.Millisecond})
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	_ = sshx.CleanupStep(ctx, nc.SSH, nc.r.Product, nc.task.RemoteOpID, stepID)
	if res.Status != "success" {
		return fmt.Errorf("%s 在 %s 上失败（状态 %s，退出码 %d）", name, nc.Node.Name, res.Status, res.ExitCode)
	}
	return nil
}

// Run runs a short command as root and returns its stdout.
func (nc *NodeCtx) Run(ctx context.Context, script string) (string, error) {
	res, err := nc.SSH.Run(ctx, script, sshx.RunOptions{Sudo: true})
	if err != nil {
		return "", err
	}
	return string(res.Stdout), nil
}

// HTTPClient is the outbound client of a download task.
type HTTPClient struct {
	Client    *http.Client
	UseProxy  bool
	ProxyAddr string
}

// NewHTTPClient returns the download client, honouring the per-task proxy
// choice (nil means the system default).
func NewHTTPClient(ctx context.Context, p *netx.Manager, useProxy *bool) (*HTTPClient, error) {
	use := p.UseByDefault(ctx, netx.SettingUseForReleases)
	if useProxy != nil {
		use = *useProxy
	}
	c, addr, err := p.Client(ctx, use, 30*time.Minute)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		return nil, BadRequest("已选择使用系统代理，但尚未配置系统代理")
	}
	if err != nil {
		return nil, err
	}
	return &HTTPClient{Client: c, UseProxy: use, ProxyAddr: addr}, nil
}

// HostIssues runs the host checks every product deployment shares:
// completed probe, passwordless sudo, architecture, required tools and
// time synchronization.
func HostIssues(n *db.Node) []PreflightIssue {
	var out []PreflightIssue
	add := func(sev, format string, args ...any) {
		out = append(out, PreflightIssue{NodeID: n.ID, Node: n.Name, Severity: sev, Message: fmt.Sprintf(format, args...)})
	}
	if n.MachineID == "" || n.LastCheckedAt.IsZero() {
		add("block", "主机尚未完成连通性测试与环境探测")
		return out
	}
	if !n.SudoReady {
		add("block", "当前 SSH 用户没有免密 sudo 权限")
	}
	if n.Arch != "amd64" && n.Arch != "arm64" {
		add("block", "不支持的 CPU 架构 %s", n.Arch)
	}
	var probe struct {
		Missing []string `json:"missing_tools"`
	}
	_ = json.Unmarshal([]byte(n.ProbeJSON), &probe)
	if len(probe.Missing) > 0 {
		add("block", "缺少必要命令：%s", strings.Join(probe.Missing, "、"))
	}
	if n.TimeSync == "unsynced" {
		add("block", "时间未同步，请启用 systemd-timesyncd 或 chrony")
	}
	skew := n.ClockSkewMS
	if skew < 0 {
		skew = -skew
	}
	if skew > hosts.MaxClockSkew.Milliseconds() {
		add("block", "与控制面的时钟偏差 %d 毫秒，超过 30 秒", n.ClockSkewMS)
	}
	return out
}

// Blocking turns blocking or unconfirmed preflight issues into an error.
func Blocking(issues []PreflightIssue) error {
	var msgs []string
	for _, i := range issues {
		if i.Severity == "block" || i.Severity == "confirm" {
			msgs = append(msgs, i.Node+"："+i.Message)
		}
	}
	if len(msgs) == 0 {
		return nil
	}
	return Conflict("preflight_failed", "部署前检查未通过：\n%s", strings.Join(msgs, "\n"))
}

// NodeHosts lists the names and addresses a node certificate must cover:
// loopback, the advertise address, the host address and its aliases, and
// the public API host of the cluster.
func NodeHosts(n *db.Node, advertise, publicURL string, extra []string) []string {
	out := []string{"localhost", "127.0.0.1", "::1", advertise, n.Host}
	var aliases []string
	_ = json.Unmarshal([]byte(n.AddressAliasesJSON), &aliases)
	out = append(out, aliases...)
	if publicURL != "" {
		if u, err := url.Parse(publicURL); err == nil && u.Hostname() != "" {
			out = append(out, u.Hostname())
		}
	}
	out = append(out, extra...)
	seen := map[string]bool{}
	dedup := out[:0]
	for _, h := range out {
		if h != "" && !seen[h] {
			seen[h] = true
			dedup = append(dedup, h)
		}
	}
	return dedup
}

// AddKept appends a version to the kept-versions list (last three).
func AddKept(js, version string) string {
	var kept []string
	_ = json.Unmarshal([]byte(js), &kept)
	for _, k := range kept {
		if k == version {
			b, _ := json.Marshal(kept)
			return string(b)
		}
	}
	kept = append(kept, version)
	if len(kept) > 3 {
		kept = kept[len(kept)-3:]
	}
	b, _ := json.Marshal(kept)
	return string(b)
}

// ReconcileTasks inspects the remote steps of a target's tasks interrupted
// by a control plane restart. A task whose remote units all finished is
// closed as failed and its op lock markers removed; running or unknown
// units keep the report unresolved.
func (r *Remote) ReconcileTasks(ctx context.Context, targetType, targetID string) (*ReconcileReport, int, error) {
	tasks, err := db.ListTasks(ctx, r.DB.Reader, db.TaskFilter{TargetType: targetType, TargetID: targetID, Status: db.TaskNeedsReconcile})
	if err != nil {
		return nil, 0, err
	}
	rep := &ReconcileReport{Steps: []ReconcileStep{}, Resolved: true}
	for _, task := range tasks {
		steps, err := db.ListSteps(ctx, r.DB.Reader, task.ID)
		if err != nil {
			return nil, 0, err
		}
		running := false
		for _, st := range steps {
			if st.RemoteUnit == "" || st.NodeID == "" {
				continue
			}
			rs := ReconcileStep{TaskID: task.ID, Action: task.Action, Unit: st.RemoteUnit}
			n, c, err := r.Connect(ctx, st.NodeID)
			if n != nil {
				rs.Node = n.Name
			}
			if err != nil {
				rs.Status, rs.Error = "unreachable", err.Error()
				running = true
				rep.Steps = append(rep.Steps, rs)
				continue
			}
			stepID := strings.TrimPrefix(st.RemoteUnit, sshx.UnitName(task.RemoteOpID, ""))
			res, err := sshx.CheckStep(ctx, c, sshx.StepSpec{Product: r.Product, OpID: task.RemoteOpID, Step: stepID})
			if err != nil {
				rs.Status, rs.Error = "unknown", err.Error()
				running = true
			} else {
				rs.Status = res.Status
				if res.Status == "running" {
					running = true
				}
			}
			if !running {
				_, _ = c.Run(ctx, fmt.Sprintf(`if grep -q %s %s 2>/dev/null; then rm -f %s; fi`, sshx.Quote(task.RemoteOpID),
					sshx.Quote(r.OpLock), sshx.Quote(r.OpLock)), sshx.RunOptions{Sudo: true})
				_ = sshx.CleanupStep(ctx, c, r.Product, task.RemoteOpID, stepID)
			}
			rep.Steps = append(rep.Steps, rs)
		}
		if running {
			rep.Resolved = false
			continue
		}
		if err := db.FinishTask(ctx, r.DB.Writer, task.ID, db.TaskFailed, "已核对：控制面重启时被中断，远端步骤已不在运行", r.DB.Now()); err != nil {
			return nil, 0, err
		}
	}
	return rep, len(tasks), nil
}
