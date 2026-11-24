package vault

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

func (s *Service) requireOperable(cl *cluster) error {
	if cl.InitState != db.InitInitialized {
		return conflict("not_initialized", "集群尚未完成初始化")
	}
	if cl.MaintenanceMode {
		return conflict("maintenance", "集群处于维护模式（%s），请先处理后再操作", cl.MaintenanceReason)
	}
	return nil
}

// nodeRole returns active/standby/sealed/down for a member.
func (s *Service) nodeRole(ctx context.Context, cl *cluster, m *db.ClusterNode) string {
	c, err := s.client(cl, m, "")
	if err != nil {
		return "down"
	}
	h, err := c.Health(ctx)
	switch {
	case err != nil:
		return "down"
	case h.Sealed:
		return "sealed"
	case h.Standby:
		return "standby"
	default:
		return "active"
	}
}

// rollingOrder puts the active node last.
func (s *Service) rollingOrder(ctx context.Context, cl *cluster, members []*db.ClusterNode) []*db.ClusterNode {
	var head, tail []*db.ClusterNode
	for _, m := range members {
		if s.nodeRole(ctx, cl, m) == "active" {
			tail = append(tail, m)
		} else {
			head = append(head, m)
		}
	}
	return append(head, tail...)
}

// waitHealthyMember waits until autopilot reports the member as a healthy voter.
func (s *Service) waitHealthyMember(ctx context.Context, cl *cluster, m *db.ClusterNode, log func(string, ...any)) error {
	id := memberConfig(m).RaftNodeID
	deadline := time.Now().Add(s.joinTimeout())
	for {
		admin, _, err := s.adminClient(ctx, cl)
		if err == nil {
			var ap *AutopilotState
			if ap, err = admin.AutopilotState(ctx); err == nil {
				if sv, ok := ap.Servers[id]; ok && sv.Healthy && (sv.Status == "voter" || sv.Status == "leader") {
					log("%s 健康（%s，last_index=%d）", m.NodeName, sv.Status, sv.LastIndex)
					return nil
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s 未在超时内恢复为健康投票成员（%v）", m.NodeName, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
}

// waitOtherActive waits until a member other than except is active.
func (s *Service) waitOtherActive(ctx context.Context, cl *cluster, members []*db.ClusterNode, except *db.ClusterNode) error {
	deadline := time.Now().Add(s.joinTimeout())
	for time.Now().Before(deadline) {
		for _, m := range members {
			if m.ID != except.ID && s.nodeRole(ctx, cl, m) == "active" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
	return errors.New("等待其他节点接管 Active 超时")
}

// restartAndRecover restarts a node's service, unseals it and waits until
// it is healthy again.
func (s *Service) restartAndRecover(ctx context.Context, t *ops.Task, cl *cluster, members []*db.ClusterNode, nc *nodeCtx, version string) error {
	if err := s.service(ctx, t, nc, "restart"); err != nil {
		return err
	}
	return s.recoverNode(ctx, cl, members, nc, version)
}

func (s *Service) recoverNode(ctx context.Context, cl *cluster, members []*db.ClusterNode, nc *nodeCtx, version string) error {
	if _, err := s.waitAPI(ctx, cl, nc.m, version); err != nil {
		return err
	}
	keys, gen, err := s.activeKeys(ctx, cl.ID)
	if err != nil {
		return err
	}
	if err := s.unsealMember(ctx, cl, nc.m, keys); err != nil {
		return err
	}
	nc.step.Logf("已使用第 %d 代密钥解封", gen)
	if len(members) == 1 {
		c, _ := s.client(cl, nc.m, "")
		return s.waitActive(ctx, c, 2*time.Minute)
	}
	return s.waitHealthyMember(ctx, cl, nc.m, nc.step.Logf)
}

// gateFor checks the quorum gate for a member about to go down.
func (s *Service) gateFor(ctx context.Context, cl *cluster, m *db.ClusterNode, confirmSingle bool, log func(string, ...any)) error {
	admin, _, err := s.adminClient(ctx, cl)
	if err != nil {
		return err
	}
	r, err := s.gate(ctx, admin, m, confirmSingle)
	if err != nil {
		return err
	}
	log("仲裁门禁：%s", r.Reason)
	if !r.Allowed {
		return gateError(r)
	}
	return nil
}

// rolling applies change to every node (standbys first, active last): gate,
// change, restart, unseal, wait healthy.
func (s *Service) rolling(ctx context.Context, t *ops.Task, cl *cluster, title string, confirmSingle bool,
	change func(nc *nodeCtx, members []*db.ClusterNode) error) error {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	for _, m := range s.rollingOrder(ctx, cl, members) {
		if err := func() (err error) {
			nc, err := s.openNode(ctx, t, m, title)
			if err != nil {
				return err
			}
			defer func() { nc.done(ctx, err) }()
			if err := s.gateFor(ctx, cl, m, confirmSingle, nc.step.Logf); err != nil {
				return err
			}
			if err := change(nc, members); err != nil {
				return err
			}
			return s.restartAndRecover(ctx, t, cl, members, nc, "")
		}(); err != nil {
			return fmt.Errorf("滚动执行在 %s 处停止：%w", m.NodeName, err)
		}
	}
	return nil
}

// ---- Scale out ----

// JoinInput adds a node to an initialized cluster.
type JoinInput struct {
	AdvertiseAddr string `json:"advertise_addr"`
	UseProxy      *bool  `json:"use_proxy"`
	ConfirmSwap   bool   `json:"confirm_swap"`
}

// NodeJoin installs Vault on a new host and joins it with the two-phase
// Shamir protocol (Init is never called on the new node).
func (s *Service) NodeJoin(ctx context.Context, actor audit.Actor, clusterID, nodeID string, in JoinInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	if cl.Settings.Version == "" {
		return nil, conflict("no_version", "集群版本未知，无法扩容")
	}
	if err := validVersion(cl.Settings.Version); err != nil {
		return nil, err
	}
	issues, err := s.preflight(ctx, []*db.ClusterNode{{NodeID: nodeID}}, in.ConfirmSwap)
	if err != nil {
		return nil, badRequest("主机不存在")
	}
	if err := blocking(issues); err != nil {
		return nil, err
	}
	hc, err := s.httpClient(ctx, in.UseProxy)
	if err != nil {
		return nil, err
	}
	var m *db.ClusterNode
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		m, err = s.insertMember(ctx, tx, cl.Cluster, cl.Settings, MemberInput{NodeID: nodeID, AdvertiseAddr: in.AdvertiseAddr}, s.DB.Now())
		return err
	}); err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_join", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "vault"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID, "use_proxy": hc.useProxy, "version": cl.Settings.Version},
		Run: func(ctx context.Context, t *ops.Task) error {
			err := s.runJoin(ctx, t, cl, m.ID, hc)
			if err != nil {
				if mm, e := db.GetClusterNode(ctx, s.DB.Reader, clusterID, nodeID); e == nil {
					mm.InstallState = "failed"
					_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, mm, s.DB.Now())
				}
			}
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_join", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node_id": nodeID, "use_proxy": hc.useProxy}})
	return task, nil
}

func (s *Service) runJoin(ctx context.Context, t *ops.Task, cl *cluster, memberID string, hc *httpClientResult) error {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	var m *db.ClusterNode
	for _, x := range members {
		if x.ID == memberID {
			m = x
		}
	}
	if m == nil {
		return errors.New("member disappeared")
	}
	arts, err := s.fetchArtifacts(ctx, t, hc, cl.Settings.Version, []*db.ClusterNode{m})
	if err != nil {
		return err
	}
	var ca *pki.CA
	if cl.TLSEnabled {
		if ca, err = s.caSigner(cl); err != nil {
			return err
		}
	}
	if err := s.deployNode(ctx, t, cl, members, m, arts, ca); err != nil {
		return err
	}
	keys, _, err := s.activeKeys(ctx, cl.ID)
	if err != nil {
		return err
	}
	admin, _, err := s.adminClient(ctx, cl)
	if err != nil {
		return err
	}
	step, err := t.Step("Raft 两阶段加入 "+m.NodeName, m.NodeID)
	if err != nil {
		return err
	}
	err = s.joinMember(ctx, cl, m, keys, admin, step.Logf)
	step.Finish(err, nil)
	if err == nil {
		_, _, _ = s.SyncStatus(ctx, cl.ID)
	}
	return err
}

// ---- Scale in ----

// NodeRemove safely removes a node: quorum gate, step-down if active,
// remove-peer, then stop and wipe the node so retry_join cannot re-add it.
func (s *Service) NodeRemove(ctx context.Context, actor audit.Actor, clusterID, nodeID string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	target, err := s.targets(members, []string{nodeID})
	if err != nil {
		return nil, err
	}
	if len(members) <= 1 {
		return nil, conflict("last_node", "不能移除集群的最后一个节点，请使用卸载")
	}
	if cl.InitState == db.InitInitialized && cl.MaintenanceMode {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	m := target[0]
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_remove", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRemove(ctx, t, cl, members, m)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_remove", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node_id": nodeID, "node": m.NodeName}})
	return task, nil
}

const wipeScript = `systemctl disable --now vault.service >/dev/null 2>&1 || true
rm -f ` + UnitFile + ` ` + LogrotateF + ` ` + SystemLink + `
rm -rf -- ` + Base + `
systemctl daemon-reload
echo "vault removed from host"
`

// wipe removes Vault from a host. It runs as a direct command because it
// deletes the directory holding detached step results.
func (s *Service) wipe(ctx context.Context, nc *nodeCtx) error {
	out, err := s.run(ctx, nc, wipeScript)
	if err == nil {
		nc.step.Logf("%s", strings.TrimSpace(out))
	}
	return err
}

func (s *Service) runRemove(ctx context.Context, t *ops.Task, cl *cluster, members []*db.ClusterNode, m *db.ClusterNode) error {
	step, err := t.Step("移出 Raft "+m.NodeName, m.NodeID)
	if err != nil {
		return err
	}
	err = func() error {
		if cl.InitState != db.InitInitialized {
			return nil
		}
		admin, _, err := s.adminClient(ctx, cl)
		if err != nil {
			return err
		}
		r, err := s.gate(ctx, admin, m, false)
		if err != nil {
			return err
		}
		step.Logf("仲裁门禁：%s", r.Reason)
		if !r.Allowed {
			return gateError(r)
		}
		if s.nodeRole(ctx, cl, m) == "active" {
			tok, _ := s.adminToken(ctx, cl.ID)
			c, _ := s.client(cl, m, tok)
			step.Logf("目标为 Active，执行 step-down")
			if err := c.StepDown(ctx); err != nil {
				return err
			}
			if err := s.waitOtherActive(ctx, cl, members, m); err != nil {
				return err
			}
			if admin, _, err = s.adminClient(ctx, cl); err != nil {
				return err
			}
		}
		if err := admin.RemovePeer(ctx, memberConfig(m).RaftNodeID); err != nil && StatusOf(err) != 400 {
			return err
		}
		step.Logf("已从 Raft 成员中移除 %s", memberConfig(m).RaftNodeID)
		return nil
	}()
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	nc, err := s.openNode(ctx, t, m, "停服并清理")
	if err != nil {
		return fmt.Errorf("节点已移出 Raft，但无法连接清理（请手动停止 vault 服务）：%w", err)
	}
	err = s.wipe(ctx, nc)
	nc.step.Finish(err, nil)
	if err != nil {
		return err
	}
	if err := db.DeleteClusterNode(ctx, s.DB.Writer, m.ID); err != nil {
		return err
	}
	_, _, _ = s.SyncStatus(ctx, cl.ID)
	return nil
}

// ---- Single-node service actions ----

// NodeService starts, stops or restarts one node through the quorum gate;
// started nodes are unsealed by the task itself.
func (s *Service) NodeService(ctx context.Context, actor audit.Actor, clusterID, nodeID, action string, confirmSingle bool) (*db.OperationTask, error) {
	if action != "start" && action != "stop" && action != "restart" {
		return nil, badRequest("不支持的操作 %s", action)
	}
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	target, err := s.targets(members, []string{nodeID})
	if err != nil {
		return nil, err
	}
	m := target[0]
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_service", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "vault"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID, "action": action, "confirm_single": confirmSingle},
		Run: func(ctx context.Context, t *ops.Task) (err error) {
			nc, err := s.openNode(ctx, t, m, action)
			if err != nil {
				return err
			}
			defer func() { nc.done(ctx, err) }()
			initialized := cl.InitState == db.InitInitialized
			if initialized && action != "start" && s.nodeRole(ctx, cl, m) != "down" {
				if err := s.gateFor(ctx, cl, m, confirmSingle, nc.step.Logf); err != nil {
					return err
				}
			}
			if err := s.service(ctx, t, nc, action); err != nil {
				return err
			}
			if action == "stop" || !initialized {
				return nil
			}
			return s.recoverNode(ctx, cl, members, nc, "")
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_" + action, ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node": m.NodeName}})
	return task, nil
}

// ---- Certificates ----

// RenewCerts issues new node certificates and rolls them out.
func (s *Service) RenewCerts(ctx context.Context, actor audit.Actor, clusterID string, confirmSingle bool) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	if !cl.TLSEnabled {
		return nil, conflict("tls_disabled", "集群未启用 TLS")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.cert_renew", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			ca, err := s.caSigner(cl)
			if err != nil {
				return err
			}
			return s.rolling(ctx, t, cl, "续期证书", confirmSingle, func(nc *nodeCtx, ms []*db.ClusterNode) error {
				return s.applyGeneration(ctx, nc, cl, ms, ca, cl.CACertPEM)
			})
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.cert_renew", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

// RotateCA replaces the cluster CA with an overlap: first every node gets a
// certificate from the new CA while the trust bundle holds both CAs, then
// the old CA is dropped from the bundle.
func (s *Service) RotateCA(ctx context.Context, actor audit.Actor, clusterID string, confirmSingle bool) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	if !cl.TLSEnabled {
		return nil, conflict("tls_disabled", "集群未启用 TLS")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.ca_rotate", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRotateCA(ctx, t, clusterID, confirmSingle)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.ca_rotate", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

func (s *Service) runRotateCA(ctx context.Context, t *ops.Task, clusterID string, confirmSingle bool) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	certs, err := pki.ParseCerts(cl.CACertPEM)
	if err != nil {
		return err
	}
	if len(certs) == 1 {
		step, err := t.Step("生成新 CA 并下发双 CA 信任链", "")
		if err != nil {
			return err
		}
		now := time.Now()
		ca, err := pki.NewCA("NomadDeck Vault CA "+cl.Name, pki.CATTL, now)
		if err == nil {
			var enc string
			if enc, err = s.Keys.EncryptString(ca.KeyPEM, db.ClusterCAKeyAAD(cl.ID)); err == nil {
				cl.CACertPEM = strings.TrimSpace(cl.CACertPEM) + "\n" + ca.CertPEM
				cl.CAKeyEncrypted = enc
				cl.CAExpiresAt, _ = pki.EarliestExpiry(cl.CACertPEM)
				err = db.UpdateClusterTLS(ctx, s.DB.Writer, cl.Cluster, s.DB.Now())
			}
		}
		step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	_ = t.Checkpoint(map[string]any{"phase": "overlap"})
	ca, err := s.caSigner(cl)
	if err != nil {
		return err
	}
	if err := s.rolling(ctx, t, cl, "签发新 CA 证书", confirmSingle, func(nc *nodeCtx, ms []*db.ClusterNode) error {
		return s.applyGeneration(ctx, nc, cl, ms, ca, cl.CACertPEM)
	}); err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "drop_old"})
	newOnly := string(pemOf(ca))
	cl.CACertPEM = newOnly
	cl.CAExpiresAt = ca.Cert.NotAfter
	if err := db.UpdateClusterTLS(ctx, s.DB.Writer, cl.Cluster, s.DB.Now()); err != nil {
		return err
	}
	return s.rolling(ctx, t, cl, "移除旧 CA", confirmSingle, func(nc *nodeCtx, ms []*db.ClusterNode) error {
		return s.applyGeneration(ctx, nc, cl, ms, ca, newOnly)
	})
}

// ---- Upgrade ----

// UpgradePlan is the dry-run preview of a rolling upgrade.
type UpgradePlan struct {
	Check   release.UpgradeCheck `json:"check"`
	Order   []string             `json:"order"`
	Current string               `json:"current_version"`
	Target  string               `json:"target_version"`
}

// PlanUpgrade previews an upgrade.
func (s *Service) PlanUpgrade(ctx context.Context, clusterID, version string) (*UpgradePlan, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := validVersion(version); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	p := &UpgradePlan{Current: cl.Settings.Version, Target: version,
		Check: release.CheckUpgrade("vault", cl.Settings.Version, version, db.IntSetting(ctx, s.DB.Reader, "upgrade.max_minor_skip", 2))}
	for _, m := range s.rollingOrder(ctx, cl, members) {
		p.Order = append(p.Order, m.NodeName+"（"+s.nodeRole(ctx, cl, m)+"）")
	}
	return p, nil
}

// UpgradeInput starts a rolling upgrade.
type UpgradeInput struct {
	Version       string `json:"version"`
	UseProxy      *bool  `json:"use_proxy"`
	Confirm       bool   `json:"confirm"`
	ConfirmSingle bool   `json:"confirm_single_node"`
}

// Upgrade performs the rolling upgrade: pre-upgrade snapshot, standbys one
// by one, then the active node is stopped normally (no step-down) and
// upgraded once an upgraded node has taken over.
func (s *Service) Upgrade(ctx context.Context, actor audit.Actor, clusterID string, in UpgradeInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	plan, err := s.PlanUpgrade(ctx, clusterID, in.Version)
	if err != nil {
		return nil, err
	}
	if !plan.Check.Allowed {
		return nil, conflict("upgrade_not_allowed", "版本跨度校验未通过：%s", plan.Check.Reason)
	}
	if plan.Check.NeedsConfirmation && !in.Confirm {
		return nil, conflict("confirmation_required", "本次升级跨越 %d 个小版本或经过须人工确认的版本，请查看升级计划后确认", plan.Check.MinorSkip)
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if len(members) == 1 && !in.ConfirmSingle {
		return nil, conflict("confirm_single_node", "单节点集群升级会中断服务，需显式确认")
	}
	hc, err := s.httpClient(ctx, in.UseProxy)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.upgrade", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Params: map[string]any{"from": cl.Settings.Version, "to": in.Version, "use_proxy": hc.useProxy, "confirm": in.Confirm},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runUpgrade(ctx, t, cl, in, hc)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.upgrade", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"from": cl.Settings.Version, "to": in.Version}})
	return task, nil
}

func (s *Service) runUpgrade(ctx context.Context, t *ops.Task, cl *cluster, in UpgradeInput, hc *httpClientResult) error {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	arts, err := s.fetchArtifacts(ctx, t, hc, in.Version, members)
	if err != nil {
		return err
	}
	step, err := t.Step("升级前 Raft 快照", "")
	if err != nil {
		return err
	}
	admin, _, err := s.adminClient(ctx, cl)
	var snap *db.Snapshot
	if err == nil {
		snap, err = s.takeSnapshot(ctx, cl, admin, "pre_upgrade", "system:upgrade")
	}
	if err == nil {
		step.Logf("升级前快照 %s 已保存并回读校验通过", snap.ID)
	}
	step.Finish(err, nil)
	if err != nil {
		return fmt.Errorf("升级前快照失败，未改动任何节点：%w", err)
	}
	_ = t.Checkpoint(map[string]any{"phase": "snapshot", "snapshot_id": snap.ID, "to": in.Version})
	order := s.rollingOrder(ctx, cl, members)
	for i, m := range order {
		isActive := i == len(order)-1 && s.nodeRole(ctx, cl, m) == "active"
		if err := s.upgradeNode(ctx, t, cl, members, m, arts, in, isActive); err != nil {
			return err
		}
		_ = t.Checkpoint(map[string]any{"phase": "node_done", "node": m.NodeName, "snapshot_id": snap.ID, "to": in.Version})
	}
	cl.Settings.Version = in.Version
	if b, err := jsonMarshal(cl.Settings); err == nil {
		cl.ConfigJSON = b
		_ = db.UpdateClusterSettings(ctx, s.DB.Writer, cl.Cluster, s.DB.Now())
	}
	_, _, _ = s.SyncStatus(ctx, cl.ID)
	return nil
}

func (s *Service) upgradeNode(ctx context.Context, t *ops.Task, cl *cluster, members []*db.ClusterNode, m *db.ClusterNode,
	arts map[string]*release.Artifact, in UpgradeInput, isActive bool) (err error) {
	nc, err := s.openNode(ctx, t, m, "升级")
	if err != nil {
		return err
	}
	defer func() { nc.done(ctx, err) }()
	art := arts[nc.node.Arch]
	old := m.InstalledVersion
	if err := s.gateFor(ctx, cl, m, in.ConfirmSingle, nc.step.Logf); err != nil {
		return err
	}
	if isActive && len(members) > 1 {
		// Stop the old active normally; an upgraded standby takes over.
		if err := s.installBinary(ctx, t, nc, art); err != nil {
			return err
		}
		if err := s.service(ctx, t, nc, "stop"); err != nil {
			return err
		}
		if err := s.waitOtherActive(ctx, cl, members, m); err != nil {
			return fmt.Errorf("熔断：%w", err)
		}
		nc.step.Logf("已升级的节点接管为 Active")
		if err := s.service(ctx, t, nc, "start"); err != nil {
			return err
		}
	} else {
		if err := s.installBinary(ctx, t, nc, art); err != nil {
			return err
		}
		if err := s.service(ctx, t, nc, "restart"); err != nil {
			return err
		}
	}
	if _, err := s.waitAPI(ctx, cl, m, in.Version); err != nil {
		// The new binary never served: storage was not touched, roll back.
		nc.step.Logf("新版本未能启动（%v），回切到 %s", err, old)
		if old != "" {
			if _, rerr := s.run(ctx, nc, ActivateBinaryScript(old)); rerr == nil {
				_ = s.service(ctx, t, nc, "restart")
				_ = s.recoverNode(ctx, cl, members, nc, old)
			}
		}
		return fmt.Errorf("%s 升级失败并已回切旧版本，后续节点未升级：%w", m.NodeName, ops.ErrRolledBack)
	}
	if err := s.recoverNode(ctx, cl, members, nc, in.Version); err != nil {
		return fmt.Errorf("熔断：%s 已运行新版本但未恢复健康，禁止自动降级，请检查后按升级前快照恢复：%w", m.NodeName, err)
	}
	m.InstalledVersion = in.Version
	m.KeptVersionsJSON = addKept(m.KeptVersionsJSON, in.Version)
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

// ---- Uninstall ----

// UninstallPlan lists what an uninstall removes.
type UninstallPlan struct {
	Nodes     []string `json:"nodes"`
	Snapshots int      `json:"snapshots"`
	Warnings  []string `json:"warnings"`
}

// PlanUninstall previews an uninstall.
func (s *Service) PlanUninstall(ctx context.Context, clusterID string) (*UninstallPlan, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	snaps, _ := db.ListSnapshots(ctx, s.DB.Reader, clusterID)
	p := &UninstallPlan{Snapshots: len(snaps), Warnings: []string{
		"所有节点上的 Vault 服务、配置、TLS 材料与 Raft 数据将被删除，数据不可恢复",
		"控制面托管的全部代际 Unseal Key、运维 Token 与该集群的快照将被删除",
		"如需保留，请先导出离线紧急备份与快照归档",
	}}
	for _, m := range members {
		p.Nodes = append(p.Nodes, m.NodeName)
	}
	return p, nil
}

// Uninstall removes Vault from every node and deletes the cluster.
func (s *Service) Uninstall(ctx context.Context, actor audit.Actor, clusterID, confirmName string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if confirmName != cl.Name {
		return nil, badRequest("请输入集群名称以确认卸载")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.uninstall", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: map[string]any{"name": cl.Name},
		Run: func(ctx context.Context, t *ops.Task) error {
			var errs []error
			for _, m := range members {
				if m.InstallState == "pending" {
					continue
				}
				nc, err := s.openNode(ctx, t, m, "卸载")
				if err != nil {
					errs = append(errs, err)
					continue
				}
				err = s.wipe(ctx, nc)
				nc.step.Finish(err, nil)
				errs = append(errs, err)
			}
			if err := errors.Join(errs...); err != nil {
				return err
			}
			snaps, _ := db.ListSnapshots(ctx, s.DB.Reader, clusterID)
			if err := db.DeleteCluster(ctx, s.DB.Writer, clusterID); err != nil {
				return err
			}
			for _, sn := range snaps {
				_ = os.Remove(sn.FilePath)
			}
			return nil
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.uninstall", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

// DeleteUndeployed removes a cluster record that was never deployed.
func (s *Service) DeleteUndeployed(ctx context.Context, actor audit.Actor, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.InstallState != "pending" {
			return conflict("deployed", "集群已部署，请使用卸载")
		}
	}
	if err := db.DeleteCluster(ctx, s.DB.Writer, clusterID); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.delete", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name})
}

// ---- Maintenance and reconciliation ----

// SetMaintenance toggles maintenance mode.
func (s *Service) SetMaintenance(ctx context.Context, actor audit.Actor, clusterID string, on bool) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if err := db.SetClusterMaintenance(ctx, s.DB.Writer, clusterID, on, "manual_maintenance", s.DB.Now()); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.maintenance", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"on": on, "previous_reason": cl.MaintenanceReason}})
}

// ReconcileStep is the observed state of one remote step.
type ReconcileStep struct {
	TaskID string `json:"task_id"`
	Action string `json:"action"`
	Node   string `json:"node"`
	Unit   string `json:"unit"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// ReconcileReport is the outcome of a reconciliation.
type ReconcileReport struct {
	Steps    []ReconcileStep `json:"steps"`
	Resolved bool            `json:"resolved"`
	Message  string          `json:"message"`
}

// Reconcile inspects remote steps of tasks interrupted by a control plane
// restart (op lock and persisted step results) and unlocks the cluster
// when nothing is still running.
func (s *Service) Reconcile(ctx context.Context, actor audit.Actor, clusterID string) (*ReconcileReport, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	tasks, err := db.ListTasks(ctx, s.DB.Reader, db.TaskFilter{TargetType: "cluster", TargetID: clusterID, Status: db.TaskNeedsReconcile})
	if err != nil {
		return nil, err
	}
	rep := &ReconcileReport{Steps: []ReconcileStep{}, Resolved: true}
	for _, task := range tasks {
		steps, err := db.ListSteps(ctx, s.DB.Reader, task.ID)
		if err != nil {
			return nil, err
		}
		running := false
		for _, st := range steps {
			if st.RemoteUnit == "" || st.NodeID == "" {
				continue
			}
			rs := ReconcileStep{TaskID: task.ID, Action: task.Action, Unit: st.RemoteUnit}
			n, err := db.GetNode(ctx, s.DB.Reader, st.NodeID)
			if err != nil {
				continue
			}
			rs.Node = n.Name
			c, err := s.Hosts.Connect(ctx, n)
			if err != nil {
				rs.Status, rs.Error = "unreachable", err.Error()
				running = true
				rep.Steps = append(rep.Steps, rs)
				continue
			}
			stepID := strings.TrimPrefix(st.RemoteUnit, sshx.UnitName(task.RemoteOpID, ""))
			r, err := sshx.CheckStep(ctx, c, sshx.StepSpec{Product: "vault", OpID: task.RemoteOpID, Step: stepID})
			if err != nil {
				rs.Status, rs.Error = "unknown", err.Error()
				running = true
			} else {
				rs.Status = r.Status
				if r.Status == "running" {
					running = true
				}
			}
			if !running {
				_, _ = c.Run(ctx, fmt.Sprintf(`if grep -q %s %s 2>/dev/null; then rm -f %s; fi`, sshx.Quote(task.RemoteOpID),
					sshx.Quote(OpLockFile), sshx.Quote(OpLockFile)), sshx.RunOptions{Sudo: true})
				_ = sshx.CleanupStep(ctx, c, "vault", task.RemoteOpID, stepID)
			}
			rep.Steps = append(rep.Steps, rs)
		}
		if running {
			rep.Resolved = false
			continue
		}
		if err := db.FinishTask(ctx, s.DB.Writer, task.ID, db.TaskFailed, "已核对：控制面重启时被中断，远端步骤已不在运行", s.DB.Now()); err != nil {
			return nil, err
		}
	}
	if rep.Resolved {
		if cl.MaintenanceMode && cl.MaintenanceReason == "needs_reconcile" {
			_ = db.SetClusterMaintenance(ctx, s.DB.Writer, clusterID, false, "", s.DB.Now())
		}
		rep.Message = "核对完成，集群已解锁"
	} else {
		rep.Message = "仍有远端步骤在运行或无法确认，集群保持维护态，请稍后再次核对"
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.reconcile", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"tasks": len(tasks), "resolved": rep.Resolved}})
	return rep, nil
}

// ---- Config generation rollback ----

// RollbackGeneration switches a node back to its previous config
// generation (configuration and TLS material together), restarts it through
// the quorum gate and unseals it.
func (s *Service) RollbackGeneration(ctx context.Context, actor audit.Actor, clusterID, nodeID string, confirmSingle bool) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	target, err := s.targets(members, []string{nodeID})
	if err != nil {
		return nil, err
	}
	m := target[0]
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.config_rollback", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "vault"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID},
		Run: func(ctx context.Context, t *ops.Task) (err error) {
			nc, err := s.openNode(ctx, t, m, "切回上一配置代际")
			if err != nil {
				return err
			}
			defer func() { nc.done(ctx, err) }()
			mc := memberConfig(m)
			out, err := s.run(ctx, nc, fmt.Sprintf(`ls -1 %s | grep -E '^[0-9]+$' | sort -n`, sshx.Quote(ReleasesDir)))
			if err != nil {
				return err
			}
			prev := 0
			for _, f := range strings.Fields(out) {
				if g, err := strconv.Atoi(f); err == nil && g < mc.ConfigGeneration && g > prev {
					prev = g
				}
			}
			if prev == 0 {
				return conflict("no_previous_generation", "节点上没有可切回的上一配置代际")
			}
			if err := s.gateFor(ctx, cl, m, confirmSingle, nc.step.Logf); err != nil {
				return err
			}
			dir := GenerationDir(prev)
			cert, err := s.run(ctx, nc, fmt.Sprintf(`set -e
test -f %[1]s/config.hcl
ln -sfn releases/%[2]d %[3]s.nd-tmp && mv -Tf %[3]s.nd-tmp %[3]s
cat %[1]s/tls/server.crt 2>/dev/null || true`, sshx.Quote(dir), prev, ConfigLink))
			if err != nil {
				return err
			}
			nc.step.Logf("vault.d 已切回配置代际 %d", prev)
			mc.ConfigGeneration = prev
			setMemberConfig(m, mc)
			if exp, err := pki.NotAfter(cert); err == nil {
				m.CertExpiresAt = exp
			}
			if err := db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now()); err != nil {
				return err
			}
			return s.restartAndRecover(ctx, t, cl, members, nc, "")
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.config_rollback", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node": m.NodeName}})
	return task, nil
}

// ---- Controlled reset of an in-doubt initialization ----

// ResetInDoubt wipes the Raft data of a cluster whose initialization result
// is unknown and whose keys were never obtained, so it can be initialized
// again. Only for clusters confirmed to carry no workload.
func (s *Service) ResetInDoubt(ctx context.Context, actor audit.Actor, clusterID, confirmName string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInDoubt || cu.SealGeneration != 0 {
		return nil, conflict("not_in_doubt", "只有处于 init_in_doubt 且没有保存密钥的集群可以重置")
	}
	if confirmName != cl.Name {
		return nil, badRequest("请输入集群名称以确认重置")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.init_reset", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			for _, m := range members {
				if err := func() (err error) {
					nc, err := s.openNode(ctx, t, m, "清空 Raft 数据")
					if err != nil {
						return err
					}
					defer func() { nc.done(ctx, err) }()
					if _, err := s.run(ctx, nc, "systemctl stop vault.service\nfind "+sshx.Quote(DataDir)+" -mindepth 1 -delete\n"); err != nil {
						return err
					}
					if err := s.service(ctx, t, nc, "start"); err != nil {
						return err
					}
					st, err := s.waitAPI(ctx, cl, m, "")
					if err == nil && st.Initialized {
						err = fmt.Errorf("%s 重置后仍报告已初始化", m.NodeName)
					}
					return err
				}(); err != nil {
					return err
				}
			}
			return db.SetClusterInitState(ctx, s.DB.Writer, clusterID, db.InitUninitialized, s.DB.Now())
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.init_reset", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}
