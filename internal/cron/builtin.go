package cron

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/integration"
	"nomad-deck/internal/jobs"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/vault"
)

// Default retention values.
const (
	DefaultSnapshotRetention = 7
	DefaultCertAlertDays     = 30
	DefaultExportRetention   = 14
)

// SkipError marks a run that had nothing to do (recorded as skipped).
type SkipError struct{ Reason string }

func (e *SkipError) Error() string { return e.Reason }

// Skip returns a SkipError.
func Skip(format string, args ...any) error { return &SkipError{Reason: fmt.Sprintf(format, args...)} }

// BuiltinDef is the default definition of a built-in job.
type BuiltinDef struct {
	Key          string
	Name         string
	Description  string
	ScheduleType string
	Expr         string
	TimeoutSec   int
}

// Builtins lists the built-in jobs with their default schedules.
var Builtins = []BuiltinDef{
	{"cluster_health_check", "主机与集群健康巡检", "定时探测纳管主机在线状态、时钟偏差以及 Nomad / Vault 集群健康情况。", "cron", "*/5 * * * *", 300},
	{"cert_expiry_check", "证书临期检查", "巡检集群 mTLS CA 与节点证书剩余有效期，触发仪表盘预警。", "cron", "0 8 * * *", 300},
	{"vault_token_renew", "Vault 运维 Token 续租", "自动续租 Vault 运维 Token，防止托管运维权限过期。", "cron", "0 */6 * * *", 300},
	{"vault_auto_unseal_watch", "Vault 自动解封巡检", "巡检已启用自动解封的 Vault 节点并在重启密封后自动解封。", "cron", "*/2 * * * *", 300},
	{"raft_snapshot_backup", "集群 Raft 快照备份", "定期采集 Nomad 与 Vault 集群 Raft 状态快照并按策略清理旧快照。", "cron", "0 3 * * *", 1800},
	{"control_plane_backup", "控制面灾备备份", "将控制面数据库与集群快照打包加密，同步至 SafeKeep 灾备目标。", "cron", "30 1 * * *", 1800},
	{"self_update_check", "NomadDeck 新版本检查", "检查 GitHub Release 新版本并更新仪表盘新版本提示状态。", "cron", "0 */6 * * *", 300},
	{"cleanup_audit_logs", "审计日志清理", "按保留时长清理过期的审计日志记录。", "cron", "0 2 * * *", 600},
	{"cleanup_operation_logs", "运维任务日志清理", "按保留时长清理过期的异步运维任务日志与定时执行历史。", "cron", "30 2 * * *", 600},
}

func builtinDescription(key string) string {
	for _, b := range Builtins {
		if b.Key == key {
			return b.Description
		}
	}
	return ""
}

// seed inserts missing built-in jobs; existing ones keep their edits.
func (s *Scheduler) seed(ctx context.Context) error {
	for _, b := range Builtins {
		if _, err := db.GetCronJobByKey(ctx, s.DB.Reader, b.Key); err == nil {
			continue
		}
		j := &db.CronJob{
			ID: db.NewID(), JobKey: b.Key, Name: b.Name, ScheduleType: b.ScheduleType, CronExpr: b.Expr,
			TimeoutSeconds: b.TimeoutSec, OverlapPolicy: "skip_if_running", MisfirePolicy: "skip",
			Enabled: true, PayloadJSON: "{}", ConfigJSON: "{}", IsBuiltin: true, UpdatedAt: s.DB.Now(),
		}
		if err := db.InsertCronJob(ctx, s.DB.Writer, j); err != nil && !errors.Is(err, db.ErrUnique) {
			return err
		}
	}
	return nil
}

// Platform holds the services the built-in and custom jobs use.
type Platform struct {
	Hosts        *hosts.Service
	Drivers      map[string]cluster.Driver
	Vault        *vault.Service
	Integrations *integration.Service
	Jobs         *jobs.Service
	DataDir      string

	// Backup produces the control-plane disaster-recovery bundle
	// (control_plane_backup). Nil means backups are not available.
	Backup Handler
	// BackupTarget backs up the control plane or a cluster snapshot to a
	// specific backup target (e.g. SafeKeep).
	BackupTarget func(ctx context.Context, r *Run, targetID, clusterID string) (string, error)
	// ValidateBackupTarget verifies that targetID exists.
	ValidateBackupTarget func(ctx context.Context, targetID string) error
	// Offsite copies a fresh snapshot to the backup targets.
	Offsite func(ctx context.Context, r *Run, snap *db.Snapshot, clusterName string) error
	// SelfUpdateCheck queries the latest release.
	SelfUpdateCheck func(ctx context.Context) (string, error)
}

// Install registers the built-in handlers and custom job types.
func (s *Scheduler) Install(p *Platform) {
	s.Register("cluster_health_check", p.healthCheck(s))
	s.Register("cert_expiry_check", p.certCheck(s))
	s.Register("vault_token_renew", func(ctx context.Context, r *Run) (string, error) {
		if p.Vault == nil {
			return "", Skip("未启用 Vault 驱动")
		}
		if err := p.Vault.RenewTokens(ctx); err != nil {
			return "部分集群续租失败", err
		}
		return "全部 Vault 集群运维 Token 已续租", nil
	})
	s.Register("vault_auto_unseal_watch", func(ctx context.Context, r *Run) (string, error) {
		if p.Vault == nil {
			return "", Skip("未启用 Vault 驱动")
		}
		n, err := p.Vault.AutoUnsealSweep(ctx)
		if err != nil {
			return "", err
		}
		if n == 0 {
			return "未发现需要解封的节点", nil
		}
		return fmt.Sprintf("已为 %d 个集群提交自动解封任务", n), nil
	})
	s.Register("raft_snapshot_backup", p.snapshotAll(s))
	s.Register("control_plane_backup", func(ctx context.Context, r *Run) (string, error) {
		if p.Backup == nil {
			return "", Skip("控制面灾备备份不可用")
		}
		return p.Backup(ctx, r)
	})
	s.Register("self_update_check", func(ctx context.Context, r *Run) (string, error) {
		if p.SelfUpdateCheck == nil {
			return "", Skip("当前构建未启用控制面自更新")
		}
		return p.SelfUpdateCheck(ctx)
	})
	s.Register("cleanup_audit_logs", func(ctx context.Context, r *Run) (string, error) {
		cutoff, label := retentionCutoff(ctx, s, r.Job, "audit.retention_days", 90)
		n, err := db.DeleteOldAuditLogs(ctx, s.DB.Writer, cutoff)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("清理 %d 条超过 %s 的审计日志", n, label), nil
	})
	s.Register("cleanup_operation_logs", func(ctx context.Context, r *Run) (string, error) {
		cutoff, label := retentionCutoff(ctx, s, r.Job, "ops.retention_days", 60)
		ids, err := db.OldFinishedTaskIDs(ctx, s.DB.Reader, cutoff)
		if err != nil {
			return "", err
		}
		for _, id := range ids {
			_ = os.RemoveAll(s.Ops.LogDir(id))
		}
		if err := db.DeleteTasks(ctx, s.DB.Writer, ids); err != nil {
			return "", err
		}
		runs, err := db.DeleteOldCronRuns(ctx, s.DB.Writer, cutoff)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("清理 %d 个运维任务及其步骤日志、%d 条定时任务执行记录（保留 %s）", len(ids), runs, label), nil
	})
	p.installCustom(s)
}

func retentionCutoff(ctx context.Context, s *Scheduler, j *db.CronJob, settingKey string, defaultDays int) (time.Time, string) {
	if j != nil && strings.TrimSpace(j.ConfigJSON) != "" && j.ConfigJSON != "{}" {
		var cfg struct {
			Retention string `json:"retention"`
		}
		if json.Unmarshal([]byte(j.ConfigJSON), &cfg) == nil && strings.TrimSpace(cfg.Retention) != "" {
			if dur, err := ParseDuration(cfg.Retention); err == nil && dur >= time.Minute {
				return s.DB.Now().Add(-dur), strings.TrimSpace(cfg.Retention)
			}
		}
	}
	days := db.IntSetting(ctx, s.DB.Reader, settingKey, defaultDays)
	return s.DB.Now().AddDate(0, 0, -days), fmt.Sprintf("%d 天", days)
}

func (p *Platform) healthCheck(s *Scheduler) Handler {
	return func(ctx context.Context, r *Run) (string, error) {
		nodes, err := db.ListNodes(ctx, s.DB.Reader)
		if err != nil {
			return "", err
		}
		var mu sync.Mutex
		var wg sync.WaitGroup
		sem := make(chan struct{}, 8)
		online := 0
		for _, n := range nodes {
			wg.Add(1)
			go func(n *db.Node) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				err := p.Hosts.Ping(ctx, n)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					r.Logf("主机 %s（%s）不可达：%v", n.Name, n.Host, err)
					return
				}
				online++
			}(n)
		}
		wg.Wait()
		health := map[string]int{}
		clusters, err := db.ListClusters(ctx, s.DB.Reader, "")
		if err != nil {
			return "", err
		}
		skipped := 0
		for _, c := range clusters {
			d := p.Drivers[c.Type]
			if d == nil || c.InitState != db.InitInitialized || c.MaintenanceMode {
				skipped++
				continue
			}
			if _, err := d.Status(ctx, c.ID); err != nil {
				r.Logf("集群 %s 状态同步失败：%v", c.Name, err)
			}
			if fresh, err := db.GetCluster(ctx, s.DB.Reader, c.ID); err == nil {
				health[fresh.HealthStatus]++
				if fresh.HealthStatus != "healthy" {
					r.Logf("集群 %s 状态：%s", c.Name, fresh.HealthStatus)
				}
			}
		}
		parts := []string{fmt.Sprintf("主机在线 %d/%d", online, len(nodes))}
		keys := make([]string, 0, len(health))
		for k := range health {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s %d", k, health[k]))
		}
		if skipped > 0 {
			parts = append(parts, fmt.Sprintf("跳过未初始化或维护中的集群 %d", skipped))
		}
		return strings.Join(parts, "，"), nil
	}
}

// CertAlert is a certificate that expires soon.
type CertAlert struct {
	ClusterID   string    `json:"cluster_id"`
	ClusterName string    `json:"cluster_name"`
	Kind        string    `json:"kind"` // ca | client | node
	Node        string    `json:"node,omitempty"`
	ExpiresAt   time.Time `json:"expires_at"`
	DaysLeft    int       `json:"days_left"`
}

// CertAlerts lists certificates expiring within the alert threshold.
func CertAlerts(ctx context.Context, d *db.DB) ([]CertAlert, error) {
	days := db.IntSetting(ctx, d.Reader, "cert.alert_days", DefaultCertAlertDays)
	now := d.Now()
	limit := now.AddDate(0, 0, days)
	clusters, err := db.ListClusters(ctx, d.Reader, "")
	if err != nil {
		return nil, err
	}
	out := []CertAlert{}
	add := func(c *db.Cluster, kind, node string, exp time.Time) {
		if exp.IsZero() || exp.After(limit) {
			return
		}
		out = append(out, CertAlert{ClusterID: c.ID, ClusterName: c.Name, Kind: kind, Node: node, ExpiresAt: exp,
			DaysLeft: int(exp.Sub(now).Hours() / 24)})
	}
	for _, c := range clusters {
		add(c, "ca", "", c.CAExpiresAt)
		add(c, "client", "", c.ClientCertExpiresAt)
		members, err := db.ListClusterNodes(ctx, d.Reader, c.ID)
		if err != nil {
			return nil, err
		}
		for _, m := range members {
			if m.InstallState == "installed" {
				add(c, "node", m.NodeName, m.CertExpiresAt)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ExpiresAt.Before(out[j].ExpiresAt) })
	return out, nil
}

var certKind = map[string]string{"ca": "集群 CA", "client": "控制面客户端证书", "node": "节点证书"}

func (p *Platform) certCheck(s *Scheduler) Handler {
	return func(ctx context.Context, r *Run) (string, error) {
		alerts, err := CertAlerts(ctx, s.DB)
		if err != nil {
			return "", err
		}
		for _, a := range alerts {
			who := a.ClusterName
			if a.Node != "" {
				who += " / " + a.Node
			}
			r.Logf("%s：%s 剩余 %d 天（%s 到期）", who, certKind[a.Kind], a.DaysLeft, a.ExpiresAt.Format("2006-01-02"))
		}
		if len(alerts) == 0 {
			return "没有临期证书", nil
		}
		return fmt.Sprintf("%d 张证书将在 %d 天内到期", len(alerts), db.IntSetting(ctx, s.DB.Reader, "cert.alert_days", DefaultCertAlertDays)), nil
	}
}

// snapshotTargets lists clusters eligible for scheduled snapshots.
func (p *Platform) snapshotTargets(ctx context.Context, d *db.DB) ([]*db.Cluster, error) {
	clusters, err := db.ListClusters(ctx, d.Reader, "")
	if err != nil {
		return nil, err
	}
	var out []*db.Cluster
	for _, c := range clusters {
		if p.Drivers[c.Type] != nil && c.InitState == db.InitInitialized && !c.MaintenanceMode {
			out = append(out, c)
		}
	}
	return out, nil
}

func (p *Platform) snapshotAll(s *Scheduler) Handler {
	return func(ctx context.Context, r *Run) (string, error) {
		targets, err := p.snapshotTargets(ctx, s.DB)
		if err != nil {
			return "", err
		}
		if len(targets) == 0 {
			return "", Skip("没有可备份的集群")
		}
		return p.snapshotTask(ctx, s, r, targets, "cron.raft_snapshot_backup", "", "scheduled")
	}
}

// snapshotTask runs one operation task that snapshots each cluster under
// its shared cluster lock, copies it off-site and rotates old scheduled
// snapshots under the exclusive snapshot-store lock.
func (p *Platform) snapshotTask(ctx context.Context, s *Scheduler, r *Run, targets []*db.Cluster, action, targetID, trigger string) (string, error) {
	var mu sync.Mutex
	var done, failed []string
	_, err := r.Task(ctx, ops.Spec{Action: action, TargetType: "cluster", TargetID: targetID,
		Run: func(ctx context.Context, t *ops.Task) error {
			var errs []error
			for _, c := range targets {
				err := p.snapshotOne(ctx, s, r, t, c, trigger)
				mu.Lock()
				if err != nil {
					failed = append(failed, c.Name)
					errs = append(errs, fmt.Errorf("%s：%w", c.Name, err))
				} else {
					done = append(done, c.Name)
				}
				mu.Unlock()
			}
			return errors.Join(errs...)
		}})
	sum := fmt.Sprintf("成功 %d 个集群", len(done))
	if len(failed) > 0 {
		sum += fmt.Sprintf("，失败 %d 个（%s）", len(failed), strings.Join(failed, "、"))
	}
	return sum, err
}

func (p *Platform) snapshotOne(ctx context.Context, s *Scheduler, r *Run, t *ops.Task, c *db.Cluster, trigger string) error {
	d := p.Drivers[c.Type]
	step, err := t.Step(fmt.Sprintf("集群 %s：导出并加密 Raft 快照", c.Name), "")
	if err != nil {
		return err
	}
	lctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	release, err := s.Ops.Locks.Acquire(lctx, []ops.LockReq{{Key: ops.ClusterLock(c.ID), Mode: ops.Shared}})
	cancel()
	if err != nil {
		err = errors.New("等待集群锁超时（集群上有独占运维任务在执行）")
		step.Finish(err, nil)
		return err
	}
	snap, err := d.TakeSnapshot(ctx, c.ID, trigger, audit.ActorCron.Name)
	release()
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	step.Logf("快照 %s 已加密保存并回读校验（%d 字节）", snap.ID, snap.SizeBytes)
	r.Logf("集群 %s：快照 %s（%d 字节）", c.Name, snap.ID, snap.SizeBytes)
	step.Finish(nil, nil)
	var errs []error
	if p.Offsite != nil {
		st, _ := t.Step(fmt.Sprintf("集群 %s：写入异地备份目标", c.Name), "")
		err := p.Offsite(ctx, r, snap, c.Name)
		if st != nil {
			if err == nil {
				st.Logf("可移植快照归档已写入备份目标并回读校验")
			}
			st.Finish(err, nil)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("异地备份失败：%w", err))
		}
	}
	if trigger == "scheduled" {
		st, _ := t.Step(fmt.Sprintf("集群 %s：轮转本地快照", c.Name), "")
		n, err := p.rotateSnapshots(ctx, s, c.ID)
		if st != nil {
			if err == nil {
				st.Logf("删除 %d 个超出保留份数的定时快照", n)
			}
			st.Finish(err, nil)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("轮转失败：%w", err))
		}
	}
	return errors.Join(errs...)
}

// rotateSnapshots keeps the newest snapshot.retention_count scheduled
// snapshots (manual, uploaded and pre-upgrade snapshots are never rotated).
func (p *Platform) rotateSnapshots(ctx context.Context, s *Scheduler, clusterID string) (int, error) {
	keep := db.IntSetting(ctx, s.DB.Reader, "snapshot.retention_count", DefaultSnapshotRetention)
	lctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	release, err := s.Ops.Locks.Acquire(lctx, []ops.LockReq{{Key: ops.SnapshotLock(clusterID), Mode: ops.Exclusive}})
	cancel()
	if err != nil {
		return 0, errors.New("快照正在被下载或恢复，本次跳过轮转")
	}
	defer release()
	snaps, err := db.ListSnapshots(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return 0, err
	}
	n, kept := 0, 0
	for _, sn := range snaps { // newest first
		if sn.TriggerType != "scheduled" {
			continue
		}
		kept++
		if kept <= keep {
			continue
		}
		if err := db.DeleteSnapshot(ctx, s.DB.Writer, sn.ID); err != nil {
			return n, err
		}
		_ = os.Remove(sn.FilePath)
		n++
	}
	return n, nil
}

// rotateFiles keeps the newest keep files matching prefix in dir.
func rotateFiles(dir, prefix string, keep int) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	n := 0
	for i, name := range names {
		if i >= keep {
			if os.Remove(filepath.Join(dir, name)) == nil {
				n++
			}
		}
	}
	return n
}
