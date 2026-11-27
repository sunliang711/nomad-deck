package nomad

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/sshx"
)

func (s *Service) requireOperable(cl *nomadCluster) error {
	if cl.InitState != db.InitInitialized {
		return conflict("not_initialized", "集群尚未完成部署与 ACL Bootstrap")
	}
	if cl.MaintenanceMode {
		return conflict("maintenance", "集群处于维护模式（%s），请先处理后再操作", cl.MaintenanceReason)
	}
	return nil
}

func memberByNode(ms []*db.ClusterNode, nodeID string) (*db.ClusterNode, error) {
	for _, m := range ms {
		if m.NodeID == nodeID {
			return m, nil
		}
	}
	return nil, badRequest("主机不是该集群的成员")
}

// leaderMember returns the member that currently leads Raft (nil if unknown).
func (s *Service) leaderMember(ctx context.Context, cl *nomadCluster, members []*db.ClusterNode) *db.ClusterNode {
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return nil
	}
	raft, err := api.RaftConfiguration(ctx)
	if err != nil {
		return nil
	}
	for _, m := range servers(members) {
		if sv, ok := raftServerOf(cl, m, raft); ok && sv.Leader {
			return m
		}
	}
	return nil
}

// rollingOrder puts non-leader servers first, then the leader, then clients.
func (s *Service) rollingOrder(ctx context.Context, cl *nomadCluster, members []*db.ClusterNode) []*db.ClusterNode {
	leader := s.leaderMember(ctx, cl, members)
	var head, tail, rest []*db.ClusterNode
	for _, m := range members {
		switch {
		case !IsServer(m.Role):
			rest = append(rest, m)
		case leader != nil && m.ID == leader.ID:
			tail = append(tail, m)
		default:
			head = append(head, m)
		}
	}
	return append(append(head, tail...), rest...)
}

// waitHealthyServer waits until autopilot reports the server as a healthy voter.
func (s *Service) waitHealthyServer(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, log func(string, ...any)) error {
	deadline := time.Now().Add(s.joinTimeout())
	var last error
	for {
		api, _, err := s.apiClient(ctx, cl, "")
		if err == nil {
			var raft []RaftServer
			var ap *AutopilotHealth
			if raft, err = api.RaftConfiguration(ctx); err == nil {
				if ap, err = api.Autopilot(ctx); err == nil {
					sv, ok := raftServerOf(cl, m, raft)
					err = fmt.Errorf("%s 尚未成为健康投票成员", m.NodeName)
					for _, h := range ap.Servers {
						if ok && h.ID == sv.ID && h.Healthy && h.Voter {
							log("%s 健康（voter，last_index=%d）", m.NodeName, h.LastIndex)
							return nil
						}
					}
				}
			}
		}
		last = err
		if time.Now().After(deadline) {
			return fmt.Errorf("%s 未在超时内恢复为健康投票成员（%v）", m.NodeName, last)
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
}

// recoverNode waits until a restarted member serves again: servers back as
// healthy voters, clients registered and ready.
func (s *Service) recoverNode(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, log func(string, ...any)) error {
	if err := s.waitAgent(ctx, cl, m); err != nil {
		return err
	}
	if IsServer(m.Role) {
		members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
		if err != nil {
			return err
		}
		if _, err := s.waitLeader(ctx, cl, members, log); err != nil {
			return err
		}
		if err := s.waitHealthyServer(ctx, cl, m, log); err != nil {
			return err
		}
	}
	if IsClient(m.Role) {
		return s.waitClientReady(ctx, cl, m, log)
	}
	return nil
}

func (s *Service) restartAndRecover(ctx context.Context, cl *nomadCluster, nc *cluster.NodeCtx, m *db.ClusterNode) error {
	if err := s.service(ctx, nc, "restart"); err != nil {
		return err
	}
	return s.recoverNode(ctx, cl, m, nc.Step.Logf)
}

// switchGeneration points nomad.d at an existing generation directory.
func (s *Service) switchGeneration(ctx context.Context, nc *cluster.NodeCtx, m *db.ClusterNode, gen int) error {
	dir := GenerationDir(gen)
	cert, err := nc.Run(ctx, fmt.Sprintf(`set -e
test -f %[1]s/10-base.hcl
ln -sfn releases/%[2]d %[3]s.nd-tmp && mv -Tf %[3]s.nd-tmp %[3]s
cat %[1]s/tls/agent.pem 2>/dev/null || true`, sshx.Quote(dir), gen, ConfigLink))
	if err != nil {
		return err
	}
	mc := memberConfig(m)
	mc.ConfigGeneration = gen
	setMemberConfig(m, mc)
	if exp, err := pki.NotAfter(cert); err == nil {
		m.CertExpiresAt = exp
	}
	nc.Step.Logf("nomad.d 已切换到配置代际 %d", gen)
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

// applyAndVerify activates a new config generation, restarts the member
// and verifies it; if verification fails the previous generation is
// switched back atomically and the member restarted again.
func (s *Service) applyAndVerify(ctx context.Context, cl *nomadCluster, nc *cluster.NodeCtx, gi *genInput, m *db.ClusterNode) error {
	prev := memberConfig(m)
	if err := s.applyGeneration(ctx, nc, gi, m); err != nil {
		return err
	}
	err := s.restartAndRecover(ctx, cl, nc, m)
	if err == nil || prev.ConfigGeneration == 0 {
		return err
	}
	nc.Step.Logf("验活失败（%v），切回配置代际 %d", err, prev.ConfigGeneration)
	if rerr := s.switchGeneration(ctx, nc, m, prev.ConfigGeneration); rerr != nil {
		return fmt.Errorf("验活失败且切回上一代际失败：%v；原因：%w", rerr, err)
	}
	newer := memberConfig(m)
	prev.ConfigGeneration = newer.ConfigGeneration
	setMemberConfig(m, prev)
	_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
	if rerr := s.restartAndRecover(ctx, cl, nc, m); rerr != nil {
		return fmt.Errorf("验活失败，已切回上一代际但节点仍未恢复：%v；原因：%w", rerr, err)
	}
	return fmt.Errorf("%s 验活失败，已切回上一配置代际：%w", m.NodeName, err)
}

// rolling applies change to every member in rolling order: gate, change,
// restart, verify. Clients may be drained first.
func (s *Service) rolling(ctx context.Context, t *ops.Task, cl *nomadCluster, title string, confirmSingle bool,
	change func(nc *cluster.NodeCtx, m *db.ClusterNode, members []*db.ClusterNode) error) error {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	for _, m := range s.rollingOrder(ctx, cl, members) {
		if m.InstallState != "installed" {
			continue
		}
		if err := func() (err error) {
			nc, err := s.remote().Open(ctx, t, m.NodeID, title)
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if err := s.gateFor(ctx, cl, m, confirmSingle, nc.Step.Logf); err != nil {
				return err
			}
			return change(nc, m, members)
		}(); err != nil {
			return fmt.Errorf("滚动执行在 %s 处停止：%w", m.NodeName, err)
		}
	}
	return nil
}

// refreshPeers writes a new config generation (retry_join and
// bootstrap_expect) to members other than except without restarting them;
// it takes effect at their next restart.
func (s *Service) refreshPeers(ctx context.Context, t *ops.Task, cl *nomadCluster, except string) error {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	gi, err := s.genInput(ctx, cl, members)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.ID == except || m.InstallState != "installed" {
			continue
		}
		if err := func() (err error) {
			nc, err := s.remote().Open(ctx, t, m.NodeID, "刷新 retry_join")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if err := s.applyGeneration(ctx, nc, gi, m); err != nil {
				return err
			}
			nc.Step.Logf("Server 列表已写入新配置代际，下次重启生效（本次不重启）")
			return nil
		}(); err != nil {
			return err
		}
	}
	return nil
}

// ---- Scale out ----

// NodeJoin installs Nomad on a new host and joins it to a running cluster.
func (s *Service) NodeJoin(ctx context.Context, actor audit.Actor, clusterID, nodeID string, in cluster.JoinInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	if in.Role == "" {
		in.Role = RoleClient
	}
	if !validRole(in.Role) {
		return nil, badRequest("角色需为 server、client 或 server_client")
	}
	if cl.Mode == "single" && IsServer(in.Role) {
		return nil, conflict("single_mode", "单机模式集群只能扩容 Client 节点")
	}
	if err := validVersion(cl.Settings.Version); err != nil {
		return nil, conflict("no_version", "集群版本未知，无法扩容")
	}
	issues, err := s.preflight(ctx, []*db.ClusterNode{{NodeID: nodeID, Role: in.Role}})
	if err != nil {
		return nil, badRequest("主机不存在")
	}
	if err := cluster.Blocking(issues); err != nil {
		return nil, err
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	if in.UseProxy != nil {
		v := hc.UseProxy
		cl.Settings.UseProxy = &v
		_ = s.saveSettings(ctx, cl)
	}
	defaults := ClientSettings{}
	for _, m := range clients(mustMembers(ctx, s, clusterID)) {
		defaults = memberConfig(m).ClientSettings // new clients inherit the settings of an existing client
		defaults.HostVolumes = nil
		break
	}
	var m *db.ClusterNode
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		m, err = s.insertMember(ctx, tx, cl.Cluster, cl.Settings, cluster.MemberInput{NodeID: nodeID, AdvertiseAddr: in.AdvertiseAddr,
			Role: in.Role}, defaults, s.DB.Now())
		return err
	}); err != nil {
		return nil, err
	}
	members := mustMembers(ctx, s, clusterID)
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_join", TargetType: "cluster", TargetID: clusterID,
		Locks: append(memberLocks(clusterID, members), s.dockerLocksFor(ctx, cl, []*db.ClusterNode{m})...), TriggeredBy: actor.Name,
		Params: map[string]any{"node_id": nodeID, "role": in.Role, "use_proxy": hc.UseProxy, "version": cl.Settings.Version},
		Run: func(ctx context.Context, t *ops.Task) error {
			err := s.runJoin(ctx, t, cl.ID, m.ID, hc)
			if err != nil {
				if mm, e := db.GetClusterNode(ctx, s.DB.Reader, clusterID, nodeID); e == nil {
					mm.InstallState = "failed"
					_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, mm, s.DB.Now())
				}
			}
			return err
		}})
	if err != nil {
		_ = db.DeleteClusterNode(ctx, s.DB.Writer, m.ID)
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_join", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node_id": nodeID, "role": in.Role, "use_proxy": hc.UseProxy}})
	return task, nil
}

func mustMembers(ctx context.Context, s *Service, clusterID string) []*db.ClusterNode {
	ms, _ := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	return ms
}

func (s *Service) runJoin(ctx context.Context, t *ops.Task, clusterID, memberID string, hc *cluster.HTTPClient) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
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
	arts, err := s.fetchArtifacts(ctx, t, hc, cl, cl.Settings.Version, []*db.ClusterNode{m})
	if err != nil {
		return err
	}
	gi, err := s.genInput(ctx, cl, members)
	if err != nil {
		return err
	}
	if err := s.installNode(ctx, t, gi, m, arts); err != nil {
		return err
	}
	if err := s.startAll(ctx, t, cl, []*db.ClusterNode{m}, "启动并加入"); err != nil {
		return err
	}
	step, err := t.Step("确认 "+m.NodeName+" 已加入", m.NodeID)
	if err != nil {
		return err
	}
	err = s.recoverNode(ctx, cl, m, step.Logf)
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	if IsServer(m.Role) {
		if err := s.refreshPeers(ctx, t, cl, m.ID); err != nil {
			return fmt.Errorf("新节点已加入，但刷新其他节点的 retry_join 失败：%w", err)
		}
	}
	_, _ = s.StatusDetail(ctx, clusterID)
	return nil
}

// ---- Scale in ----

// NodeRemove safely removes a member: clients are marked ineligible and
// drained to completion; servers pass the quorum gate, hand over
// leadership if they lead, stop and are removed from Raft and gossip. A
// server_client member runs both flows in that order. The host is then
// wiped so retry_join cannot bring it back. When force is true,
// unreachable hosts skip SSH stop/wipe and dead client drain waits while
// still cleaning Raft, gossip, client purge and membership records.
func (s *Service) NodeRemove(ctx context.Context, actor audit.Actor, clusterID, nodeID string, force bool) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	m, err := memberByNode(members, nodeID)
	if err != nil {
		return nil, err
	}
	if len(members) <= 1 {
		return nil, conflict("last_node", "不能移除集群的最后一个节点，请使用卸载")
	}
	if IsServer(m.Role) && len(servers(members)) <= 1 {
		return nil, conflict("last_server", "不能移除集群的最后一台 Server")
	}
	if cl.InitState == db.InitInitialized && cl.MaintenanceMode {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_remove", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID, "role": m.Role, "force": force},
		Run: func(ctx context.Context, t *ops.Task) error {
			freshCl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			freshMembers, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			freshM, err := memberByNode(freshMembers, nodeID)
			if err != nil {
				return err
			}
			return s.runRemove(ctx, t, freshCl, freshM, force)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_remove", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node_id": nodeID, "node": m.NodeName, "role": m.Role, "force": force}})
	return task, nil
}

// drainClient marks a client ineligible, drains it and waits until the
// drain has finished.
func (s *Service) drainClient(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, log func(string, ...any)) error {
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return err
	}
	id := memberConfig(m).ClientNodeID
	if id == "" {
		log("%s 没有登记的 Nomad 节点 ID，跳过疏散", m.NodeName)
		return nil
	}
	if err := api.SetEligibility(ctx, id, false); err != nil {
		return fmt.Errorf("标记不可调度失败：%w", err)
	}
	if err := api.DrainNode(ctx, id, s.drainDeadline(), false, map[string]string{"by": "nomad-deck"}); err != nil {
		return fmt.Errorf("发起疏散失败：%w", err)
	}
	log("已标记 %s 不可调度并发起疏散（期限 %s）", m.NodeName, s.drainDeadline())
	deadline := time.Now().Add(s.drainDeadline() + 5*time.Minute)
	for time.Now().Before(deadline) {
		n, err := api.Node(ctx, id)
		if err == nil && n.DrainStrategy == nil {
			status := "complete"
			if n.LastDrain != nil {
				status = n.LastDrain.Status
			}
			log("%s 疏散结束（%s）", m.NodeName, status)
			if status == "failed" || status == "canceled" {
				return fmt.Errorf("%s 疏散未完成（%s）", m.NodeName, status)
			}
			return nil
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
	return fmt.Errorf("等待 %s 疏散结束超时", m.NodeName)
}

// undrain cancels a drain and makes the client schedulable again.
func (s *Service) undrain(ctx context.Context, cl *nomadCluster, m *db.ClusterNode) error {
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return err
	}
	id := memberConfig(m).ClientNodeID
	if id == "" {
		return nil
	}
	if err := api.CancelDrain(ctx, id, true); err != nil {
		return err
	}
	return api.SetEligibility(ctx, id, true)
}

func (s *Service) forceDrainClient(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, log func(string, ...any)) {
	id := memberConfig(m).ClientNodeID
	if id == "" {
		log("%s 没有登记的 Nomad 节点 ID，跳过疏散", m.NodeName)
		return
	}
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		log("读取 Nomad Server API 失败（%v），按强制移出模式跳过 Client 疏散", err)
		return
	}
	nd, err := api.Node(ctx, id)
	if err != nil || nd.Status == "down" {
		_ = api.SetEligibility(ctx, id, false)
		log("Client %s 当前已失联或不可达，跳过等待疏散，后续直接 Purge", m.NodeName)
		return
	}
	if err := s.drainClient(ctx, cl, m, log); err != nil {
		log("疏散 Client 失败（%v），按强制移出模式继续移出", err)
	}
}

func (s *Service) runRemove(ctx context.Context, t *ops.Task, cl *nomadCluster, m *db.ClusterNode, force bool) error {
	initialized := cl.InitState == db.InitInitialized
	if initialized && IsClient(m.Role) {
		step, err := t.Step("疏散 Client "+m.NodeName, m.NodeID)
		if err != nil {
			return err
		}
		if force {
			s.forceDrainClient(ctx, cl, m, step.Logf)
			step.Finish(nil, nil)
		} else {
			err = s.drainClient(ctx, cl, m, step.Logf)
			step.Finish(err, nil)
			if err != nil {
				return err
			}
		}
	}
	nc, sshErr := s.remote().Open(ctx, t, m.NodeID, "停服并移出")
	if sshErr != nil {
		if !force {
			return sshErr
		}
		step, err := t.Step("强制移出失联节点 "+m.NodeName, m.NodeID)
		if err != nil {
			return err
		}
		step.Logf("无法连接主机（%v），按强制移出模式跳过远端停服与擦除", sshErr)
		var remErr error
		if initialized && IsServer(m.Role) {
			remErr = s.removeServer(ctx, cl, nil, step.Logf, m, true)
		}
		step.Finish(remErr, nil)
		if remErr != nil {
			return remErr
		}
	} else {
		err := func() error {
			if initialized && IsServer(m.Role) {
				if err := s.removeServer(ctx, cl, nc, nc.Step.Logf, m, force); err != nil {
					return err
				}
			} else if err := s.service(ctx, nc, "stop"); err != nil && !force {
				return err
			} else if err != nil {
				nc.Step.Logf("停服失败（%v），按强制移出模式继续", err)
			}
			if err := s.wipe(ctx, nc); err != nil {
				if !force {
					return err
				}
				nc.Step.Logf("远端擦除失败（%v），按强制移出模式继续移除成员记录", err)
			}
			return nil
		}()
		nc.Step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	if initialized && IsClient(m.Role) {
		if api, _, err := s.apiClient(ctx, cl, m.ID); err == nil {
			if id := memberConfig(m).ClientNodeID; id != "" {
				_ = api.PurgeNode(ctx, id)
			}
		}
	}
	if err := db.DeleteClusterNode(ctx, s.DB.Writer, m.ID); err != nil {
		return err
	}
	if initialized && IsServer(m.Role) {
		if err := s.refreshPeers(ctx, t, cl, ""); err != nil {
			if !force {
				return fmt.Errorf("节点已移除，但刷新其余节点的 retry_join 失败：%w", err)
			}
			if warnStep, stepErr := t.Step("刷新其余节点 retry_join", ""); stepErr == nil {
				warnStep.Logf("刷新其余节点 retry_join 失败（%v），节点已从集群移除，请稍后同步配置", err)
				warnStep.Finish(nil, nil)
			}
		}
	}
	_, _ = s.StatusDetail(ctx, cl.ID)
	return nil
}

// removeServer hands over leadership if needed, stops the server and
// removes it from Raft and the gossip pool.
func (s *Service) removeServer(ctx context.Context, cl *nomadCluster, nc *cluster.NodeCtx, log func(string, ...any), m *db.ClusterNode, force bool) error {
	if err := s.gateFor(ctx, cl, m, false, log); err != nil {
		return err
	}
	api, _, err := s.apiClient(ctx, cl, m.ID)
	if err != nil {
		return err
	}
	raft, err := api.RaftConfiguration(ctx)
	if err != nil {
		return err
	}
	sv, inRaft := raftServerOf(cl, m, raft)
	if nc != nil {
		if inRaft && sv.Leader {
			for _, other := range raft {
				if other.ID != sv.ID && other.Voter {
					if err := api.TransferLeadership(ctx, other.ID); err != nil {
						log("移交 Leader 失败（%v），停服后由其余节点重新选举", err)
					} else {
						log("Leader 已移交给 %s", other.Node)
					}
					break
				}
			}
		}
		if err := s.service(ctx, nc, "stop"); err != nil {
			if !force {
				return err
			}
			log("停止 Nomad 服务失败（%v），按强制移出模式继续从 Raft 移除", err)
		}
	}
	members, _ := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	var rest []*db.ClusterNode
	for _, x := range members {
		if x.ID != m.ID {
			rest = append(rest, x)
		}
	}
	if _, err := s.waitLeader(ctx, cl, rest, log); err != nil {
		return err
	}
	if api, _, err = s.apiClient(ctx, cl, m.ID); err != nil {
		return err
	}
	if inRaft {
		if err := api.RemovePeer(ctx, sv.ID); err != nil {
			if StatusOf(err) != 404 {
				rc, rcErr := api.RaftConfiguration(ctx)
				stillPresent := rcErr != nil
				if rcErr == nil {
					stillPresent = false
					for _, p := range rc {
						if p.ID == sv.ID {
							stillPresent = true
							break
						}
					}
				}
				if stillPresent {
					return fmt.Errorf("remove-peer: %w", err)
				}
			}
		}
		log("已从 Raft 成员中移除 %s", sv.Node)
	}
	_ = api.ForceLeave(ctx, memberConfig(m).NodeName+"."+cl.Region)
	return nil
}

// wipeScript stops Nomad, releases mounts under the data directory left by
// allocations and removes the managed layout.
const wipeScript = `systemctl disable --now nomad.service >/dev/null 2>&1 || true
awk '{print $2}' /proc/mounts | grep -E '^` + DataDir + `/' | sort -r | while read -r mp; do umount -l "$mp" 2>/dev/null || true; done
rm -f ` + UnitFile + ` ` + SystemLink + ` ` + SysctlFile + `
rm -rf -- ` + Base + `
systemctl daemon-reload
echo "nomad removed from host"
`

// wipe removes Nomad from a host. It runs as a direct command because it
// deletes the directory holding detached step results.
func (s *Service) wipe(ctx context.Context, nc *cluster.NodeCtx) error {
	out, err := nc.Run(ctx, wipeScript)
	if err == nil {
		nc.Step.Logf("%s", strings.TrimSpace(out))
	}
	return err
}

// ---- Single-node service actions ----

// NodeService starts, stops or restarts one member through the quorum gate.
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
	m, err := memberByNode(members, nodeID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_service", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "nomad"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID, "action": action, "confirm_single": confirmSingle},
		Run: func(ctx context.Context, t *ops.Task) (err error) {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			m, err := memberByNode(members, nodeID)
			if err != nil {
				return err
			}
			nc, err := s.remote().Open(ctx, t, m.NodeID, action)
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			initialized := cl.InitState == db.InitInitialized
			if initialized && action != "start" {
				if err := s.gateFor(ctx, cl, m, confirmSingle, nc.Step.Logf); err != nil {
					return err
				}
			}
			if err := s.service(ctx, nc, action); err != nil {
				return err
			}
			if action == "stop" || !initialized {
				return nil
			}
			return s.recoverNode(ctx, cl, m, nc.Step.Logf)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_" + action, ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node": m.NodeName}})
	return task, nil
}

// ---- Managed configuration ----

// NodeConfigInput updates the managed client configuration of a member.
type NodeConfigInput struct {
	ClientSettings
	ExtraSANs     []string `json:"extra_sans"`
	ReinstallCNI  bool     `json:"reinstall_cni"`
	UseProxy      *bool    `json:"use_proxy"`
	ConfirmSingle bool     `json:"confirm_single_node"`
}

// UpdateNodeConfig stores a member's managed configuration and, when the
// member is installed, rolls it out as a new config generation (validated
// on the node, restarted through the quorum gate, switched back if the
// node does not come back healthy).
func (s *Service) UpdateNodeConfig(ctx context.Context, actor audit.Actor, clusterID, nodeID string, in NodeConfigInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	m, err := memberByNode(members, nodeID)
	if err != nil {
		return nil, err
	}
	if !IsClient(m.Role) && (in.CNI || in.RawExec || len(in.HostVolumes) > 0 || len(in.HostNetworks) > 0 || len(in.Meta) > 0 || in.NodePool != "") {
		return nil, badRequest("纯 Server 节点不支持 Client 配置")
	}
	if err := validateClient(&in.ClientSettings); err != nil {
		return nil, err
	}
	for _, h := range in.ExtraSANs {
		if !validAddr(h) {
			return nil, badRequest("证书附加 SAN %q 不合法", h)
		}
	}
	if in.CNI && cl.Settings.CNIVersion == "" {
		return nil, badRequest("集群未选择 CNI 版本，不能启用 CNI")
	}
	if in.UseProxy != nil && *in.UseProxy {
		configured, err := s.Proxy.Configured(ctx)
		if err != nil {
			return nil, err
		}
		if !configured {
			return nil, badRequest("已选择使用系统代理，但尚未配置系统代理")
		}
	}
	old := memberConfig(m)
	next := old
	next.ClientSettings, next.ExtraSANs = in.ClientSettings, in.ExtraSANs
	if m.InstallState != "installed" {
		setMemberConfig(m, next)
		if err := db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now()); err != nil {
			return nil, err
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_config", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"node": m.NodeName, "deployed": false}})
		return nil, nil
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	var hc *cluster.HTTPClient
	if in.CNI && (!old.CNI || in.ReinstallCNI) {
		if hc, err = cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy); err != nil {
			return nil, err
		}
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.node_config", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "nomad"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID},
		Run: func(ctx context.Context, t *ops.Task) (err error) {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			if err := s.requireOperable(cl); err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			m, err := memberByNode(members, nodeID)
			if err != nil {
				return err
			}
			var arts *artifacts
			setMemberConfig(m, next)
			defer func() {
				if err != nil {
					// The node runs the previous generation again: keep the
					// stored settings in line with it.
					restored := old
					restored.ConfigGeneration = memberConfig(m).ConfigGeneration
					setMemberConfig(m, restored)
					_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
				}
			}()
			if hc != nil {
				if arts, err = s.fetchArtifacts(ctx, t, hc, cl, "", []*db.ClusterNode{m}); err != nil {
					return err
				}
			}
			nc, err := s.remote().Open(ctx, t, m.NodeID, "更新托管配置")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if arts != nil && arts.cni[nc.Node.Arch] != nil {
				if err := s.installCNI(ctx, t, nc, arts.cni[nc.Node.Arch]); err != nil {
					return err
				}
			}
			if len(next.HostVolumes) > 0 {
				if _, err := nc.Run(ctx, HostVolumeScript(next.HostVolumes)); err != nil {
					return err
				}
			}
			if err := s.gateFor(ctx, cl, m, in.ConfirmSingle, nc.Step.Logf); err != nil {
				return err
			}
			gi, err := s.genInput(ctx, cl, members)
			if err != nil {
				return err
			}
			return s.applyAndVerify(ctx, cl, nc, gi, m)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.node_config", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node": m.NodeName}})
	return task, nil
}

// AddHostVolumeInput adds one host volume to selected client members.
type AddHostVolumeInput struct {
	Volume        HostVolume `json:"volume"`
	NodeIDs       []string   `json:"node_ids"`
	ConfirmSingle bool       `json:"confirm_single_node"`
}

func hasHostVolume(vols []HostVolume, name string) bool {
	for _, v := range vols {
		if v.Name == name {
			return true
		}
	}
	return false
}

// AddHostVolume appends a host volume to the selected client members' managed
// configuration, creating the host directory and rolling out a new config
// generation to already-installed members so it becomes immediately available to jobs.
func (s *Service) AddHostVolume(ctx context.Context, actor audit.Actor, clusterID string, in AddHostVolumeInput) (*db.OperationTask, error) {
	in.Volume.Name = strings.TrimSpace(in.Volume.Name)
	in.Volume.Path = strings.TrimSpace(in.Volume.Path)
	if err := validateHostVolumes([]HostVolume{in.Volume}); err != nil {
		return nil, err
	}
	if len(in.NodeIDs) == 0 {
		return nil, badRequest("请至少选择一个目标 Client 节点")
	}
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	var pending, installed []*db.ClusterNode
	seen := map[string]bool{}
	for _, rawID := range in.NodeIDs {
		nid := strings.TrimSpace(rawID)
		if nid == "" || seen[nid] {
			continue
		}
		seen[nid] = true
		m, err := memberByNode(members, nid)
		if err != nil {
			return nil, err
		}
		if !IsClient(m.Role) {
			return nil, badRequest("节点 %s 为纯 Server 节点，不支持配置 Host Volume", m.NodeName)
		}
		if hasHostVolume(memberConfig(m).HostVolumes, in.Volume.Name) {
			return nil, conflict("host_volume_exists", "节点 %s 已配置同名 Host Volume %q", m.NodeName, in.Volume.Name)
		}
		if m.InstallState == "installed" {
			installed = append(installed, m)
		} else {
			pending = append(pending, m)
		}
	}
	if len(pending)+len(installed) == 0 {
		return nil, badRequest("请至少选择一个目标 Client 节点")
	}
	if len(installed) > 0 {
		if err := s.requireOperable(cl); err != nil {
			return nil, err
		}
		if cl.Mode == "single" && !in.ConfirmSingle {
			for _, m := range installed {
				if IsServer(m.Role) {
					return nil, conflict("quorum_gate", "单 Server 集群更新节点配置会重启唯一节点并短时中断调度与 API，请勾选单机维护确认")
				}
			}
		}
	}
	for _, m := range pending {
		next := memberConfig(m)
		next.HostVolumes = append(append([]HostVolume(nil), next.HostVolumes...), in.Volume)
		setMemberConfig(m, next)
		if err := db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now()); err != nil {
			return nil, err
		}
	}
	if len(installed) == 0 {
		names := make([]string, 0, len(pending))
		for _, m := range pending {
			names = append(names, m.NodeName)
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.host_volume_add", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"volume": in.Volume.Name, "nodes": names, "deployed": false}})
		return nil, nil
	}
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}}
	installedIDs := make([]string, 0, len(installed))
	installedSet := map[string]bool{}
	for _, m := range installed {
		locks = append(locks, ops.LockReq{Key: ops.HostLock(m.NodeID, "nomad"), Mode: ops.Exclusive})
		installedIDs = append(installedIDs, m.NodeID)
		installedSet[m.NodeID] = true
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{
		Action:      "cluster.host_volume_add",
		TargetType:  "cluster",
		TargetID:    clusterID,
		Locks:       locks,
		TriggeredBy: actor.Name,
		Params:      map[string]any{"volume": in.Volume.Name, "node_ids": installedIDs},
		Run: func(ctx context.Context, t *ops.Task) error {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			if err := s.requireOperable(cl); err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			var targets []*db.ClusterNode
			for _, m := range members {
				if installedSet[m.NodeID] && m.InstallState == "installed" {
					targets = append(targets, m)
				}
			}
			for _, m := range s.rollingOrder(ctx, cl, targets) {
				if err := s.addHostVolumeToMember(ctx, t, cl, members, m, in.Volume, in.ConfirmSingle); err != nil {
					return err
				}
			}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.host_volume_add", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"volume": in.Volume.Name, "node_ids": installedIDs}})
	return task, nil
}

func (s *Service) addHostVolumeToMember(ctx context.Context, t *ops.Task, cl *nomadCluster, members []*db.ClusterNode, m *db.ClusterNode, vol HostVolume, confirmSingle bool) (err error) {
	old := memberConfig(m)
	if hasHostVolume(old.HostVolumes, vol.Name) {
		return conflict("host_volume_exists", "节点 %s 已配置同名 Host Volume %q", m.NodeName, vol.Name)
	}
	next := old
	next.HostVolumes = append(append([]HostVolume(nil), old.HostVolumes...), vol)
	setMemberConfig(m, next)
	defer func() {
		if err != nil {
			restored := old
			restored.ConfigGeneration = memberConfig(m).ConfigGeneration
			setMemberConfig(m, restored)
			_ = db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
		}
	}()
	nc, err := s.remote().Open(ctx, t, m.NodeID, fmt.Sprintf("创建 Host Volume %s", vol.Name))
	if err != nil {
		return err
	}
	defer func() { nc.Done(ctx, err) }()
	if vol.Create {
		if _, err := nc.Run(ctx, HostVolumeScript([]HostVolume{vol})); err != nil {
			return err
		}
	}
	if err := s.gateFor(ctx, cl, m, confirmSingle, nc.Step.Logf); err != nil {
		return err
	}
	gi, err := s.genInput(ctx, cl, members)
	if err != nil {
		return err
	}
	return s.applyAndVerify(ctx, cl, nc, gi, m)
}

// SettingsInput updates cluster-level settings.
type SettingsInput struct {
	PublicAPIURL     *string            `json:"public_api_url"`
	UI               *UISettings        `json:"ui"`
	DisableTelemetry *bool              `json:"disable_telemetry"`
	Telemetry        *TelemetrySettings `json:"telemetry"`
	JobGCThreshold   *string            `json:"job_gc_threshold"`
	ExecEnabled      *bool              `json:"exec_enabled"`
	CNIVersion       *string            `json:"cni_version"`
	UseProxy         *bool              `json:"use_proxy"`
	ConfirmSingle    bool               `json:"confirm_single_node"`
}

// UpdateSettings stores cluster settings. Settings rendered into node
// configuration (UI, telemetry, job GC, public API host in certificates)
// are rolled out to every member; control-plane-only settings apply at once.
func (s *Service) UpdateSettings(ctx context.Context, actor audit.Actor, clusterID string, in SettingsInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	rollout := false
	cniChanged := false
	if in.PublicAPIURL != nil && *in.PublicAPIURL != cl.PublicAPIURL {
		if *in.PublicAPIURL != "" {
			if err := validURL(*in.PublicAPIURL); err != nil {
				return nil, err
			}
		}
		cl.PublicAPIURL, rollout = strings.TrimRight(*in.PublicAPIURL, "/"), true
	}
	if in.UI != nil {
		cl.Settings.UI, rollout = *in.UI, true
	}
	if in.DisableTelemetry != nil && *in.DisableTelemetry != cl.Settings.DisableTelemetry {
		cl.Settings.DisableTelemetry, rollout = *in.DisableTelemetry, true
		if in.Telemetry == nil {
			cl.Settings.Telemetry.PrometheusMetrics = nil
			cl.Settings.Telemetry.PublishAllocationMetrics = nil
			cl.Settings.Telemetry.PublishNodeMetrics = nil
		}
	}
	if in.Telemetry != nil {
		if err := validateTelemetry(in.Telemetry); err != nil {
			return nil, err
		}
		if !reflect.DeepEqual(*in.Telemetry, cl.Settings.Telemetry) {
			cl.Settings.Telemetry, rollout = *in.Telemetry, true
		}
		if in.DisableTelemetry == nil && in.Telemetry.PrometheusMetrics != nil && in.Telemetry.PublishAllocationMetrics != nil && in.Telemetry.PublishNodeMetrics != nil {
			disabled := !(*in.Telemetry.PrometheusMetrics || *in.Telemetry.PublishAllocationMetrics || *in.Telemetry.PublishNodeMetrics)
			if disabled != cl.Settings.DisableTelemetry {
				cl.Settings.DisableTelemetry, rollout = disabled, true
			}
		}
	}
	if in.JobGCThreshold != nil {
		trimmed := strings.TrimSpace(*in.JobGCThreshold)
		if trimmed != cl.Settings.JobGCThreshold {
			if trimmed != "" {
				if d, err := time.ParseDuration(trimmed); err != nil || d < 0 {
					return nil, badRequest("job_gc_threshold 格式不正确")
				}
			}
			cl.Settings.JobGCThreshold, rollout = trimmed, true
		}
	}
	if in.ExecEnabled != nil {
		v := *in.ExecEnabled
		cl.Settings.ExecEnabled = &v
	}
	if in.CNIVersion != nil && *in.CNIVersion != cl.Settings.CNIVersion {
		if *in.CNIVersion == "" {
			if needsCNI(members) {
				return nil, badRequest("仍有 Client 节点启用了 CNI，请先关闭节点 CNI 后再清空集群 CNI 版本")
			}
		} else if !contains(s.Releases.CNI(ctx).Versions(), *in.CNIVersion) {
			return nil, badRequest("CNI 版本 %s 没有登记的 SHA256", *in.CNIVersion)
		}
		cl.Settings.CNIVersion = *in.CNIVersion
		if *in.CNIVersion != "" && needsCNI(members) {
			cniChanged, rollout = true, true
		}
	}
	if in.UseProxy != nil && *in.UseProxy {
		configured, err := s.Proxy.Configured(ctx)
		if err != nil {
			return nil, err
		}
		if !configured {
			return nil, badRequest("已选择使用系统代理，但尚未配置系统代理")
		}
	}
	deployed := cl.InitState == db.InitInitialized
	var hc *cluster.HTTPClient
	if rollout && deployed {
		if err := s.requireOperable(cl); err != nil {
			return nil, err
		}
		if cniChanged {
			if hc, err = cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy); err != nil {
				return nil, err
			}
		}
	}
	if err := s.saveSettings(ctx, cl); err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.settings", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"rollout": rollout && deployed}})
	if !rollout || !deployed {
		return nil, nil
	}
	return s.Ops.Submit(ctx, ops.Spec{Action: "cluster.settings_rollout", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			var arts *artifacts
			if hc != nil {
				if arts, err = s.fetchArtifacts(ctx, t, hc, cl, "", members); err != nil {
					return err
				}
			}
			gi, err := s.genInput(ctx, cl, members)
			if err != nil {
				return err
			}
			return s.rolling(ctx, t, cl, "下发集群配置", in.ConfirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
				if arts != nil && IsClient(m.Role) && memberConfig(m).CNI && arts.cni[nc.Node.Arch] != nil {
					if err := s.installCNI(ctx, t, nc, arts.cni[nc.Node.Arch]); err != nil {
						return err
					}
				}
				return s.applyAndVerify(ctx, cl, nc, gi, m)
			})
		}})
}

// ---- Config generation rollback ----

// RollbackGeneration switches a member back to its previous config
// generation (configuration and TLS material together) and restarts it
// through the quorum gate.
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
	m, err := memberByNode(members, nodeID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.config_rollback", TargetType: "cluster", TargetID: clusterID,
		Locks:       []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}, {Key: ops.HostLock(nodeID, "nomad"), Mode: ops.Exclusive}},
		TriggeredBy: actor.Name, Params: map[string]any{"node_id": nodeID},
		Run: func(ctx context.Context, t *ops.Task) (err error) {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			if err := s.requireOperable(cl); err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			m, err := memberByNode(members, nodeID)
			if err != nil {
				return err
			}
			nc, err := s.remote().Open(ctx, t, m.NodeID, "切回上一配置代际")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			cur := memberConfig(m).ConfigGeneration
			out, err := nc.Run(ctx, fmt.Sprintf(`ls -1 %s | grep -E '^[0-9]+$' | sort -n`, sshx.Quote(ReleasesDir)))
			if err != nil {
				return err
			}
			prev := 0
			for _, f := range strings.Fields(out) {
				if g, err := strconv.Atoi(f); err == nil && g < cur && g > prev {
					prev = g
				}
			}
			if prev == 0 {
				return conflict("no_previous_generation", "节点上没有可切回的上一配置代际")
			}
			if err := s.gateFor(ctx, cl, m, confirmSingle, nc.Step.Logf); err != nil {
				return err
			}
			if err := s.switchGeneration(ctx, nc, m, prev); err != nil {
				return err
			}
			return s.restartAndRecover(ctx, cl, nc, m)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.config_rollback", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"node": m.NodeName}})
	return task, nil
}

// ---- Uninstall ----

// PlanUninstall previews an uninstall.
func (s *Service) PlanUninstall(ctx context.Context, clusterID string) (*cluster.UninstallPlan, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	snaps, _ := db.ListSnapshots(ctx, s.DB.Reader, clusterID)
	p := &cluster.UninstallPlan{Snapshots: len(snaps), Warnings: []string{
		"所有节点上的 Nomad 服务、配置、TLS 材料与 Raft 数据将被删除，数据不可恢复",
		"Client 上运行中的全部 Allocation 会随服务停止而终止",
		"控制面保存的 Management Token、CA 与该集群的快照将被删除；Docker 与 CNI 插件保留在主机上",
	}}
	for _, m := range members {
		p.Nodes = append(p.Nodes, m.NodeName)
		unreachable := m.ServiceStatus == "unreachable" || (m.InstallState != "pending" && m.ServiceStatus == "unknown")
		if !unreachable {
			if n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID); err == nil && n.Status == "offline" {
				unreachable = true
			}
		}
		if unreachable {
			p.UnreachableNodes = append(p.UnreachableNodes, m.NodeName)
		}
	}
	return p, nil
}

// Uninstall removes Nomad from every member and deletes the cluster.
// When force is true, unreachable nodes or failed remote wipes are skipped.
func (s *Service) Uninstall(ctx context.Context, actor audit.Actor, clusterID, confirmName string, force bool) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if confirmName != cl.Name {
		return nil, badRequest("请输入集群名称以确认卸载")
	}
	if s.InUse != nil {
		if why := s.InUse(ctx, clusterID); why != "" {
			return nil, conflict("cluster_in_use", "%s", why)
		}
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.uninstall", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: map[string]any{"name": cl.Name, "force": force},
		Run: func(ctx context.Context, t *ops.Task) error {
			var errs []error
			for _, m := range members {
				if m.InstallState == "pending" {
					continue
				}
				nc, err := s.remote().Open(ctx, t, m.NodeID, "卸载")
				if err != nil {
					if force {
						if skipStep, stepErr := t.Step("跳过失联节点 "+m.NodeName, m.NodeID); stepErr == nil {
							skipStep.Logf("无法连接主机（%v），按强制卸载模式跳过远端清理", err)
							skipStep.Finish(nil, nil)
						}
						continue
					}
					errs = append(errs, err)
					continue
				}
				err = s.wipe(ctx, nc)
				if err != nil && force {
					nc.Step.Logf("远端清理失败（%v），按强制卸载模式忽略并继续清理控制面记录", err)
					nc.Step.Finish(nil, nil)
					continue
				}
				nc.Step.Finish(err, nil)
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
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"force": force}})
	return task, nil
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

// Reconcile inspects remote steps of tasks interrupted by a control plane
// restart (op lock markers and persisted step results) and unlocks the
// cluster when nothing is still running.
func (s *Service) Reconcile(ctx context.Context, actor audit.Actor, clusterID string) (*cluster.ReconcileReport, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	rep, n, err := s.remote().ReconcileTasks(ctx, "cluster", clusterID)
	if err != nil {
		return nil, err
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
		ResourceName: cl.Name, Summary: map[string]any{"tasks": n, "resolved": rep.Resolved}})
	return rep, nil
}

// ---- Hooks for integrations ----

// Rollout writes a new config generation to every member in rolling order
// (quorum gate, nomad config validate, restart, verify, switch back on
// failure). Integrations call it after the fragments returned by ExtraFiles
// changed.
func (s *Service) Rollout(ctx context.Context, t *ops.Task, clusterID, title string, confirmSingle bool) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if err := s.requireOperable(cl); err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	gi, err := s.genInput(ctx, cl, members)
	if err != nil {
		return err
	}
	return s.rolling(ctx, t, cl, title, confirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
		return s.applyAndVerify(ctx, cl, nc, gi, m)
	})
}

// RolloutLocks are the locks a rollout of a cluster needs.
func (s *Service) RolloutLocks(ctx context.Context, clusterID string) ([]ops.LockReq, error) {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	return memberLocks(clusterID, members), nil
}

// API returns a management client for an initialized cluster.
func (s *Service) API(ctx context.Context, clusterID string) (*Client, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "Nomad 集群 %s 尚未完成部署与 ACL Bootstrap", cl.Name)
	}
	c, _, err := s.apiClient(ctx, cl, "")
	return c, err
}

// AnonClient returns an unauthenticated client to one member (e.g. for
// the public JWKS endpoint), presenting the control plane client
// certificate when the cluster requires one.
func (s *Service) AnonClient(ctx context.Context, clusterID string, m *db.ClusterNode) (*Client, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	return s.client(cl, m, "")
}
