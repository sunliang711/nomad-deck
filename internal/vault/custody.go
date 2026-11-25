package vault

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/vaultbackup"
)

// ---- Unseal primitives ----

// unsealWith submits keys until the node is unsealed. Stale progress left
// by another party is reset first so keys of different generations never mix.
func unsealWith(ctx context.Context, c *Client, keys []string) (bool, error) {
	st, err := c.SealStatus(ctx)
	if err != nil {
		return true, err
	}
	if !st.Sealed {
		return false, nil
	}
	if st.Progress > 0 {
		if err := c.UnsealReset(ctx); err != nil {
			return true, err
		}
	}
	for _, k := range keys {
		st, err = c.Unseal(ctx, k)
		if err != nil {
			return true, err
		}
		if !st.Sealed {
			return false, nil
		}
	}
	return st.Sealed, nil
}

// waitActive waits until the node reports itself as the active node.
func (s *Service) waitActive(ctx context.Context, c *Client, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		h, err := c.Health(ctx)
		if err == nil && h.HTTPStatus == http.StatusOK && !h.Sealed && !h.Standby {
			return nil
		}
		last = err
		if err == nil {
			last = fmt.Errorf("HTTP %d sealed=%v standby=%v", h.HTTPStatus, h.Sealed, h.Standby)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
	return fmt.Errorf("等待节点成为 Active 超时：%v", last)
}

// joinMember completes the two-phase Shamir Raft join of a node that runs
// with retry_join: it submits the cluster's unseal keys to the joiner until
// it is unsealed, then waits for it to be a healthy voter.
func (s *Service) joinMember(ctx context.Context, cl *cluster, m *db.ClusterNode, keys []string, admin *Client, log func(string, ...any)) error {
	c, err := s.client(cl, m, "")
	if err != nil {
		return err
	}
	raftID := memberConfig(m).RaftNodeID
	deadline := time.Now().Add(s.joinTimeout())
	for {
		sealed, err := unsealWith(ctx, c, keys)
		if err == nil && !sealed {
			break
		}
		if err != nil && IsInvalidKey(err) {
			return fmt.Errorf("%s 拒绝了当前代际的 Unseal Key：%w", m.NodeName, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s 未能完成 Raft 加入与解封：%v", m.NodeName, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
	log("%s 已完成 Join 挑战并解封，等待成为健康的投票成员", m.NodeName)
	for {
		ap, err := admin.AutopilotState(ctx)
		if err == nil {
			if sv, ok := ap.Servers[raftID]; ok && sv.Healthy && (sv.Status == "voter" || sv.Status == "leader") {
				log("%s 已作为健康 Voter 加入 Raft（last_index=%d）", m.NodeName, sv.LastIndex)
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s 未在超时内成为健康 Voter（%v）", m.NodeName, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
}

// ---- Init ----

// InitInput starts (or resumes) initialization.
type InitInput struct {
	KeyShares    int `json:"key_shares"`
	KeyThreshold int `json:"key_threshold"`
}

// Init initializes the cluster on its first node, or resumes an
// initialization that stopped after the keys were stored.
func (s *Service) Init(ctx context.Context, actor audit.Actor, clusterID string, in InitInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	switch cl.InitState {
	case db.InitInitialized:
		return nil, conflict("cluster_initialized", "集群已初始化")
	case db.InitInDoubt:
		if cu.SealGeneration == 0 {
			return nil, conflict("init_in_doubt", "上一次初始化结果未知且没有保存到密钥：禁止重试初始化。请补录已取得的 Unseal Key，或确认集群无业务后执行受控重置")
		}
	default:
		if in.KeyShares == 0 {
			in.KeyShares, in.KeyThreshold = cu.KeyShares, cu.KeyThreshold
		}
		if err := validateShares(in.KeyShares, in.KeyThreshold); err != nil {
			return nil, err
		}
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if m.InstallState != "installed" {
			return nil, conflict("not_deployed", "节点 %s 尚未部署完成", m.NodeName)
		}
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.init", TargetType: "cluster", TargetID: cl.ID,
		Locks: memberLocks(cl.ID, members), TriggeredBy: actor.Name,
		Params: map[string]any{"key_shares": in.KeyShares, "key_threshold": in.KeyThreshold, "resume": cl.InitState == db.InitInDoubt},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runInit(ctx, t, actor, clusterID, in)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.init", ResourceType: "cluster", ResourceID: cl.ID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"key_shares": in.KeyShares,
			"key_threshold": in.KeyThreshold, "resume": cl.InitState == db.InitInDoubt}})
	return task, nil
}

func (s *Service) runInit(ctx context.Context, t *ops.Task, actor audit.Actor, clusterID string, in InitInput) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members = sortedMembers(members)
	if cl.InitState == db.InitUninitialized {
		if err := s.initFirst(ctx, t, cl, members[0], in); err != nil {
			return err
		}
	}
	return s.finishInit(ctx, t, actor, clusterID)
}

func (s *Service) initFirst(ctx context.Context, t *ops.Task, cl *cluster, first *db.ClusterNode, in InitInput) error {
	step, err := t.Step("初始化首节点 "+first.NodeName, first.NodeID)
	if err != nil {
		return err
	}
	c, err := s.client(cl, first, "")
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	st, err := c.SealStatus(ctx)
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	if st.Initialized {
		err := conflict("already_initialized", "节点 %s 已被初始化（并非由本控制面完成），拒绝继续", first.NodeName)
		step.Finish(err, nil)
		return err
	}
	now := s.DB.Now()
	// The window that cannot be made atomic: mark in doubt before calling init.
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cu, err := db.GetCustody(ctx, tx, cl.ID)
		if err != nil {
			return err
		}
		cu.KeyShares, cu.KeyThreshold = in.KeyShares, in.KeyThreshold
		if err := db.SaveCustody(ctx, tx, cu, now); err != nil {
			return err
		}
		return db.SetClusterInitState(ctx, tx, cl.ID, db.InitInDoubt, now)
	}); err != nil {
		step.Finish(err, nil)
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "init_called", "node": first.NodeName})
	step.Logf("调用 /sys/init（分片 %d，阈值 %d）", in.KeyShares, in.KeyThreshold)
	resp, err := c.Init(ctx, in.KeyShares, in.KeyThreshold)
	if err != nil {
		err = fmt.Errorf("初始化请求失败，集群保持 init_in_doubt：%w", err)
		step.Finish(err, nil)
		return err
	}
	keys := resp.KeysBase64
	if len(keys) == 0 {
		keys = resp.Keys
	}
	encKeys, err := s.encryptKeys(cl.ID, 1, keys)
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	encRoot, err := s.Keys.EncryptString(resp.RootToken, db.VaultRootTokenAAD(cl.ID))
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	store := func() error {
		return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
			now := s.DB.Now()
			if err := db.InsertKeyGeneration(ctx, tx, &db.KeyGeneration{ClusterID: cl.ID, Generation: 1, KeyShares: in.KeyShares,
				KeyThreshold: in.KeyThreshold, UnsealKeysEncrypted: encKeys, State: db.GenActive, CreatedAt: now, ActivatedAt: now}); err != nil {
				return err
			}
			cu, err := db.GetCustody(ctx, tx, cl.ID)
			if err != nil {
				return err
			}
			cu.Initialized, cu.SealGeneration, cu.InitializedAt, cu.BootstrapRootTokenEncrypted = true, 1, now, encRoot
			return db.SaveCustody(ctx, tx, cu, now)
		})
	}
	// The keys exist only in memory now: retry the write before giving up.
	for i := 0; i < 5; i++ {
		if err = store(); err == nil {
			break
		}
		time.Sleep(time.Duration(i+1) * 500 * time.Millisecond)
	}
	if err != nil {
		err = fmt.Errorf("Unseal Key 未能写入数据库，集群保持 init_in_doubt：%w", err)
		step.Finish(err, nil)
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "keys_stored", "generation": 1})
	step.Logf("第 1 代 Unseal Key 与 Root Token 已加密托管")
	step.Finish(nil, nil)
	return nil
}

// finishInit converges credentials and joins the remaining nodes; every
// step is idempotent so an interrupted initialization resumes here.
func (s *Service) finishInit(ctx context.Context, t *ops.Task, actor audit.Actor, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members = sortedMembers(members)
	keys, gen, err := s.activeKeys(ctx, clusterID)
	if err != nil {
		return err
	}
	// Leader: an initialized member (the first node unless resuming elsewhere).
	var leader *db.ClusterNode
	for _, m := range members {
		c, err := s.client(cl, m, "")
		if err != nil {
			continue
		}
		if st, err := c.SealStatus(ctx); err == nil && st.Initialized {
			leader = m
			break
		}
	}
	if leader == nil {
		return conflict("no_initialized_node", "没有找到已初始化的节点")
	}
	step, err := t.Step("解封首节点 "+leader.NodeName, leader.NodeID)
	if err != nil {
		return err
	}
	lc, err := s.client(cl, leader, "")
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	if sealed, err := unsealWith(ctx, lc, keys); err != nil || sealed {
		err = fmt.Errorf("解封首节点失败：%v", err)
		step.Finish(err, nil)
		return err
	}
	if err := s.waitActive(ctx, lc, 2*time.Minute); err != nil {
		step.Finish(err, nil)
		return err
	}
	step.Logf("首节点已使用第 %d 代密钥解封并成为 Active", gen)
	step.Finish(nil, nil)

	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	rootTok := ""
	if cu.BootstrapRootTokenEncrypted != "" {
		if rootTok, err = s.Keys.DecryptString(cu.BootstrapRootTokenEncrypted, db.VaultRootTokenAAD(clusterID)); err != nil {
			return err
		}
	}
	step, err = t.Step("派生专用运维 Token", "")
	if err != nil {
		return err
	}
	adminOK := false
	if cu.AdminTokenEncrypted != "" {
		if tok, err := s.adminToken(ctx, clusterID); err == nil {
			if _, err := lc.WithToken(tok).LookupSelf(ctx); err == nil {
				adminOK = true
			}
		}
	}
	if !adminOK {
		if rootTok == "" {
			err := conflict("no_root_token", "Root Token 已不存在且没有可用的运维 Token，请使用应急恢复重新签发")
			step.Finish(err, nil)
			return err
		}
		if err := s.issueAdminToken(ctx, cl, lc.WithToken(rootTok)); err != nil {
			step.Finish(err, nil)
			return err
		}
		step.Logf("已写入运维 Policy 并签发 orphan 周期性运维 Token（period %s）", cl.Settings.TokenPeriod)
	} else {
		step.Logf("运维 Token 已存在且有效")
	}
	tok, err := s.adminToken(ctx, clusterID)
	if err != nil {
		step.Finish(err, nil)
		return err
	}
	admin := lc.WithToken(tok)
	if _, err := admin.LookupSelf(ctx); err != nil {
		err = fmt.Errorf("运维 Token 校验失败：%w", err)
		step.Finish(err, nil)
		return err
	}
	step.Finish(nil, nil)

	if rootTok != "" {
		step, err = t.Step("吊销 Root Token", "")
		if err != nil {
			return err
		}
		if err := lc.WithToken(rootTok).RevokeSelf(ctx); err != nil && StatusOf(err) != http.StatusForbidden {
			step.Finish(err, nil)
			return err
		}
		cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
		if err != nil {
			step.Finish(err, nil)
			return err
		}
		cu.BootstrapRootTokenEncrypted = ""
		if err := db.SaveCustody(ctx, s.DB.Writer, cu, s.DB.Now()); err != nil {
			step.Finish(err, nil)
			return err
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.root_token_revoke", ResourceType: "cluster",
			ResourceID: cl.ID, ResourceName: cl.Name, OperationTaskID: t.ID})
		step.Logf("Root Token 已吊销，库内不再保存")
		step.Finish(nil, nil)
	}

	step, err = t.Step("启用文件审计设备", "")
	if err != nil {
		return err
	}
	if err := s.ensureAudit(ctx, admin); err != nil {
		step.Finish(err, nil)
		return err
	}
	step.Logf("审计设备 %s 写入 %s", AuditDeviceName, AuditLog)
	step.Finish(nil, nil)

	for _, m := range members {
		if m.ID == leader.ID {
			continue
		}
		step, err := t.Step("Raft 两阶段加入 "+m.NodeName, m.NodeID)
		if err != nil {
			return err
		}
		err = s.joinMember(ctx, cl, m, keys, admin, step.Logf)
		step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	now := s.DB.Now()
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cu, err := db.GetCustody(ctx, tx, clusterID)
		if err != nil {
			return err
		}
		cu.LastUnsealedAt = now
		if err := db.SaveCustody(ctx, tx, cu, now); err != nil {
			return err
		}
		return db.SetClusterInitState(ctx, tx, clusterID, db.InitInitialized, now)
	}); err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "initialized"})
	_, _, _ = s.SyncStatus(ctx, clusterID)
	return nil
}

func (s *Service) issueAdminToken(ctx context.Context, cl *cluster, privileged *Client) error {
	if err := privileged.PutPolicy(ctx, AdminPolicyName, AdminPolicy); err != nil {
		return fmt.Errorf("写入运维 Policy：%w", err)
	}
	tok, ttl, err := privileged.CreateOrphanToken(ctx, []string{AdminPolicyName}, cl.Settings.TokenPeriod, "nomad-deck-admin")
	if err != nil {
		return fmt.Errorf("签发运维 Token：%w", err)
	}
	enc, err := s.Keys.EncryptString(tok, db.VaultAdminTokenAAD(cl.ID))
	if err != nil {
		return err
	}
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cu, err := db.GetCustody(ctx, tx, cl.ID)
		if err != nil {
			return err
		}
		cu.AdminTokenEncrypted, cu.AdminTokenExpiresAt = enc, s.DB.Now().Add(ttl)
		return db.SaveCustody(ctx, tx, cu, s.DB.Now())
	})
}

func (s *Service) ensureAudit(ctx context.Context, admin *Client) error {
	devs, err := admin.ListAudit(ctx)
	if err != nil {
		return err
	}
	if _, ok := devs[AuditDeviceName+"/"]; ok {
		return nil
	}
	path := AuditLog
	if s.AuditPath != "" {
		path = s.AuditPath
	}
	return admin.EnableAudit(ctx, AuditDeviceName, "file", map[string]string{"file_path": path, "mode": "0600"})
}

// ---- Credentials recovery for init_in_doubt ----

// CredentialsInput supplies keys obtained outside the control plane after
// an initialization whose response was lost.
type CredentialsInput struct {
	UnsealKeys []string `json:"unseal_keys"`
	RootToken  string   `json:"root_token"`
}

// SupplyCredentials stores keys for a cluster stuck in init_in_doubt so
// that Init can resume.
func (s *Service) SupplyCredentials(ctx context.Context, actor audit.Actor, clusterID string, in CredentialsInput) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if cl.InitState != db.InitInDoubt || cu.SealGeneration != 0 {
		return conflict("not_in_doubt", "只有处于 init_in_doubt 且没有保存密钥的集群可以补录密钥")
	}
	if len(in.UnsealKeys) < cu.KeyThreshold {
		return badRequest("至少需要 %d 把 Unseal Key", cu.KeyThreshold)
	}
	for _, k := range in.UnsealKeys {
		if strings.TrimSpace(k) == "" || len(k) > 256 {
			return badRequest("Unseal Key 格式不正确")
		}
	}
	enc, err := s.encryptKeys(clusterID, 1, in.UnsealKeys)
	if err != nil {
		return err
	}
	var encRoot string
	if in.RootToken != "" {
		if encRoot, err = s.Keys.EncryptString(in.RootToken, db.VaultRootTokenAAD(clusterID)); err != nil {
			return err
		}
	}
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		now := s.DB.Now()
		if err := db.InsertKeyGeneration(ctx, tx, &db.KeyGeneration{ClusterID: clusterID, Generation: 1, KeyShares: len(in.UnsealKeys),
			KeyThreshold: cu.KeyThreshold, UnsealKeysEncrypted: enc, State: db.GenActive, CreatedAt: now, ActivatedAt: now}); err != nil {
			return err
		}
		cu.Initialized, cu.SealGeneration, cu.InitializedAt, cu.BootstrapRootTokenEncrypted = true, 1, now, encRoot
		if err := db.SaveCustody(ctx, tx, cu, now); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "cluster.credentials_supply", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"unseal_keys": len(in.UnsealKeys), "root_token": in.RootToken != ""}})
	})
}

// ---- Unseal / seal ----

// UnsealInput selects the nodes to unseal (all when empty).
type UnsealInput struct {
	NodeIDs []string `json:"node_ids"`
}

func (s *Service) targets(members []*db.ClusterNode, ids []string) ([]*db.ClusterNode, error) {
	if len(ids) == 0 {
		return members, nil
	}
	var out []*db.ClusterNode
	for _, id := range ids {
		found := false
		for _, m := range members {
			if m.NodeID == id {
				out = append(out, m)
				found = true
			}
		}
		if !found {
			return nil, badRequest("主机 %s 不是该集群的成员", id)
		}
	}
	return out, nil
}

// Unseal unseals nodes with the active key generation. It takes the cluster
// lock in shared mode so it can run during snapshots or Doctor checks.
func (s *Service) Unseal(ctx context.Context, actor audit.Actor, clusterID string, in UnsealInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	targets, err := s.targets(members, in.NodeIDs)
	if err != nil {
		return nil, err
	}
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}
	for _, m := range targets {
		locks = append(locks, ops.LockReq{Key: ops.HostLock(m.NodeID, "vault"), Mode: ops.Exclusive})
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.unseal", TargetType: "cluster", TargetID: clusterID, Locks: locks,
		TriggeredBy: actor.Name, Params: map[string]any{"nodes": len(targets)},
		Run: func(ctx context.Context, t *ops.Task) error {
			keys, gen, err := s.activeKeys(ctx, clusterID)
			if err != nil {
				return err
			}
			var errs []error
			for _, m := range targets {
				step, err := t.Step("解封 "+m.NodeName, m.NodeID)
				if err != nil {
					return err
				}
				err = s.unsealMember(ctx, cl, m, keys)
				if err == nil {
					step.Logf("已使用第 %d 代密钥解封（或节点本就未密封）", gen)
				}
				step.Finish(err, nil)
				errs = append(errs, err)
			}
			_, _, _ = s.SyncStatus(ctx, clusterID)
			return errors.Join(errs...)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.unseal", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"nodes": len(targets)}})
	return task, nil
}

func (s *Service) unsealMember(ctx context.Context, cl *cluster, m *db.ClusterNode, keys []string) error {
	c, err := s.client(cl, m, "")
	if err != nil {
		return err
	}
	sealed, err := unsealWith(ctx, c, keys)
	if err != nil {
		return fmt.Errorf("解封 %s 失败：%w", m.NodeName, err)
	}
	if sealed {
		return fmt.Errorf("%s 提交全部密钥后仍处于密封状态", m.NodeName)
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, cl.ID)
	if err == nil {
		cu.LastUnsealedAt = s.DB.Now()
		_ = db.SaveCustody(ctx, s.DB.Writer, cu, s.DB.Now())
	}
	return nil
}

// SealInput selects nodes to seal (all when empty).
type SealInput struct {
	NodeIDs []string `json:"node_ids"`
	Reason  string   `json:"reason"` // manual_seal (default) or incident_lock
}

// Seal performs a manual safety seal. The auto-unseal suppression is
// written before any node is touched. Vault only seals the active node via
// the API; standby nodes are sealed by restarting their service.
func (s *Service) Seal(ctx context.Context, actor audit.Actor, clusterID string, in SealInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	if in.Reason == "" {
		in.Reason = "manual_seal"
	}
	if in.Reason != "manual_seal" && in.Reason != "incident_lock" {
		return nil, badRequest("reason 需为 manual_seal 或 incident_lock")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	targets, err := s.targets(members, in.NodeIDs)
	if err != nil {
		return nil, err
	}
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cu, err := db.GetCustody(ctx, tx, clusterID)
		if err != nil {
			return err
		}
		cu.UnsealSuppressedReason = in.Reason
		return db.SaveCustody(ctx, tx, cu, s.DB.Now())
	}); err != nil {
		return nil, err
	}
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}
	for _, m := range targets {
		locks = append(locks, ops.LockReq{Key: ops.HostLock(m.NodeID, "vault"), Mode: ops.Exclusive})
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.seal", TargetType: "cluster", TargetID: clusterID, Locks: locks,
		TriggeredBy: actor.Name, Params: map[string]any{"nodes": len(targets), "reason": in.Reason},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runSeal(ctx, t, cl, targets)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.seal", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"nodes": len(targets), "reason": in.Reason}})
	return task, nil
}

func (s *Service) runSeal(ctx context.Context, t *ops.Task, cl *cluster, targets []*db.ClusterNode) error {
	tok, _ := s.adminToken(ctx, cl.ID)
	var active *db.ClusterNode
	var errs []error
	for _, m := range targets {
		c, err := s.client(cl, m, tok)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		h, err := c.Health(ctx)
		if err == nil && !h.Sealed && !h.Standby && h.Initialized {
			active = m // sealed last so the standbys do not take over meanwhile
			continue
		}
		if err == nil && h.Sealed {
			continue
		}
		errs = append(errs, s.sealByRestart(ctx, t, m))
	}
	if active != nil {
		step, err := t.Step("封存 Active 节点 "+active.NodeName, active.NodeID)
		if err != nil {
			return err
		}
		c, cerr := s.client(cl, active, tok)
		if cerr != nil {
			step.Finish(cerr, nil)
			errs = append(errs, cerr)
		} else {
			err = c.Seal(ctx)
			step.Finish(err, nil)
			errs = append(errs, err)
		}
	}
	_, _, _ = s.SyncStatus(ctx, cl.ID)
	return errors.Join(errs...)
}

// sealByRestart seals a standby node by restarting its service.
func (s *Service) sealByRestart(ctx context.Context, t *ops.Task, m *db.ClusterNode) (err error) {
	if s.RestartNode != nil {
		return s.RestartNode(ctx, m)
	}
	nc, err := s.openNode(ctx, t, m, "重启以封存")
	if err != nil {
		return err
	}
	defer func() { nc.done(ctx, err) }()
	return s.service(ctx, t, nc, "restart")
}

// CustodyInput changes custody switches.
type CustodyInput struct {
	AutoUnseal       *bool `json:"auto_unseal_by_deck"`
	ClearSuppression bool  `json:"clear_suppression"`
}

// UpdateCustody toggles auto-unseal and clears the suppression.
func (s *Service) UpdateCustody(ctx context.Context, actor audit.Actor, clusterID string, in CustodyInput) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if in.AutoUnseal != nil && *in.AutoUnseal && !cl.TLSEnabled {
		return badRequest("明文 HTTP 集群禁止启用托管自动解封")
	}
	return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		cu, err := db.GetCustody(ctx, tx, clusterID)
		if err != nil {
			return err
		}
		summary := map[string]any{}
		if in.AutoUnseal != nil {
			cu.AutoUnsealByDeck = *in.AutoUnseal
			summary["auto_unseal_by_deck"] = *in.AutoUnseal
		}
		if in.ClearSuppression {
			summary["cleared_suppression"] = cu.UnsealSuppressedReason
			cu.UnsealSuppressedReason = ""
		}
		if err := db.SaveCustody(ctx, tx, cu, s.DB.Now()); err != nil {
			return err
		}
		return s.Audit.Record(ctx, tx, audit.Event{Actor: actor, Action: "vault.custody_update", ResourceType: "cluster",
			ResourceID: clusterID, ResourceName: cl.Name, Summary: summary})
	})
}

// AutoUnsealSweep submits unseal tasks for sealed nodes of clusters with
// auto-unseal enabled, not in maintenance and without suppression.
func (s *Service) AutoUnsealSweep(ctx context.Context) (int, error) {
	clusters, err := db.ListClusters(ctx, s.DB.Reader, "vault")
	if err != nil {
		return 0, err
	}
	unfinished, _ := db.ListUnfinishedTasks(ctx, s.DB.Reader)
	busyUnseal := map[string]bool{}
	for _, ut := range unfinished {
		if ut.TargetType == "cluster" && ut.Action == "vault.unseal" {
			busyUnseal[ut.TargetID] = true
		}
	}
	submitted := 0
	for _, c := range clusters {
		if c.InitState != db.InitInitialized || c.MaintenanceMode || !c.TLSEnabled || busyUnseal[c.ID] {
			continue
		}
		cu, err := db.GetCustody(ctx, s.DB.Reader, c.ID)
		if err != nil || !cu.AutoUnsealByDeck || cu.UnsealSuppressedReason != "" {
			continue
		}
		cl, err := s.loadCluster(ctx, s.DB.Reader, c.ID)
		if err != nil {
			continue
		}
		members, err := db.ListClusterNodes(ctx, s.DB.Reader, c.ID)
		if err != nil {
			continue
		}
		var sealed []string
		for _, m := range members {
			cli, err := s.client(cl, m, "")
			if err != nil {
				continue
			}
			if st, err := cli.SealStatus(ctx); err == nil && st.Initialized && st.Sealed {
				sealed = append(sealed, m.NodeID)
			}
		}
		if len(sealed) == 0 {
			continue
		}
		if _, err := s.Unseal(ctx, audit.ActorCron, c.ID, UnsealInput{NodeIDs: sealed}); err == nil {
			submitted++
		}
	}
	return submitted, nil
}

// ---- Admin token lifecycle ----

// RenewTokens renews every cluster's admin token and records its expiry.
// Failures are audited; no emergency recovery happens automatically.
func (s *Service) RenewTokens(ctx context.Context) error {
	clusters, err := db.ListClusters(ctx, s.DB.Reader, "vault")
	if err != nil {
		return err
	}
	var errs []error
	for _, c := range clusters {
		if c.InitState != db.InitInitialized || c.MaintenanceMode {
			continue
		}
		cl, err := s.loadCluster(ctx, s.DB.Reader, c.ID)
		if err != nil {
			continue
		}
		err = func() error {
			admin, _, err := s.adminClient(ctx, cl)
			if err != nil {
				return err
			}
			ttl, err := admin.RenewSelf(ctx)
			if err != nil {
				return err
			}
			cu, err := db.GetCustody(ctx, s.DB.Reader, c.ID)
			if err != nil {
				return err
			}
			cu.AdminTokenExpiresAt = s.DB.Now().Add(ttl)
			return db.SaveCustody(ctx, s.DB.Writer, cu, s.DB.Now())
		}()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", c.Name, err))
			_ = s.Audit.Record(ctx, nil, audit.Event{Actor: audit.ActorCron, Action: "vault.token_renew", ResourceType: "cluster",
				ResourceID: c.ID, ResourceName: c.Name, Err: err})
		}
	}
	return errors.Join(errs...)
}

// generateRoot produces a temporary root token from unseal keys.
func generateRoot(ctx context.Context, c *Client, keys []string) (string, error) {
	_ = c.GenerateRootCancel(ctx)
	st, err := c.GenerateRootInit(ctx)
	if err != nil {
		return "", err
	}
	if st.OTP == "" {
		return "", errors.New("vault did not return an OTP")
	}
	for _, k := range keys {
		r, err := c.GenerateRootUpdate(ctx, k, st.Nonce)
		if err != nil {
			_ = c.GenerateRootCancel(ctx)
			return "", err
		}
		if r.Complete {
			enc := r.EncodedToken
			if enc == "" {
				enc = r.EncodedRoot
			}
			return DecodeRootToken(enc, st.OTP)
		}
	}
	_ = c.GenerateRootCancel(ctx)
	return "", errors.New("generate-root did not complete with the available keys")
}

// reissueAdminToken uses keys to obtain a temporary root token, issues a
// new admin token and revokes the temporary root token.
func (s *Service) reissueAdminToken(ctx context.Context, cl *cluster, c *Client, keys []string, log func(string, ...any)) error {
	root, err := generateRoot(ctx, c, keys)
	if err != nil {
		return fmt.Errorf("generate-root：%w", err)
	}
	log("已通过 generate-root 取得临时 Root Token")
	rc := c.WithToken(root)
	issueErr := s.issueAdminToken(ctx, cl, rc)
	if err := rc.RevokeSelf(ctx); err != nil {
		return errors.Join(issueErr, fmt.Errorf("吊销临时 Root Token 失败：%w", err))
	}
	log("临时 Root Token 已吊销")
	return issueErr
}

// RecoverToken is the emergency path when the admin token no longer works.
func (s *Service) RecoverToken(ctx context.Context, actor audit.Actor, clusterID string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	am, err := s.activeMember(ctx, cl, members)
	if err != nil {
		return nil, err
	}
	if tok, err := s.adminToken(ctx, clusterID); err == nil {
		if c, cerr := s.client(cl, am, tok); cerr == nil {
			if _, err := c.LookupSelf(ctx); err == nil {
				return nil, conflict("token_valid", "运维 Token 仍然有效，无需应急恢复")
			}
		}
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.recover_token", TargetType: "cluster", TargetID: clusterID,
		Locks: []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}}, TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			am, err := s.activeMember(ctx, cl, members)
			if err != nil {
				return err
			}
			step, err := t.Step("经 generate-root 重签运维 Token", am.NodeID)
			if err != nil {
				return err
			}
			keys, _, err := s.activeKeys(ctx, clusterID)
			if err == nil {
				var c *Client
				c, err = s.client(cl, am, "")
				if err == nil {
					err = s.reissueAdminToken(ctx, cl, c, keys, step.Logf)
				}
			}
			step.Finish(err, nil)
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.recover_token", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

// ---- Offline backup ----

// ExportBackup builds the offline emergency backup file.
func (s *Service) ExportBackup(ctx context.Context, actor audit.Actor, clusterID, passphrase string, includeHistory bool) ([]byte, string, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, "", err
	}
	if len(passphrase) < vaultbackup.MinPassphrase {
		return nil, "", badRequest("备份口令至少 %d 个字符", vaultbackup.MinPassphrase)
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, "", err
	}
	if cu.SealGeneration == 0 {
		return nil, "", conflict("not_initialized", "集群尚无托管的 Unseal Key")
	}
	gens, err := db.ListKeyGenerations(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, "", err
	}
	p := &vaultbackup.Payload{ClusterID: cl.ID, ClusterName: cl.Name, CreatedAt: time.Now().UTC(), ActiveGeneration: cu.SealGeneration}
	var exported []int
	for _, g := range gens {
		if !includeHistory && g.Generation != cu.SealGeneration {
			continue
		}
		if g.State == db.GenAbandoned {
			continue
		}
		keys, _, err := s.keysOf(ctx, s.DB.Reader, clusterID, g.Generation)
		if err != nil {
			return nil, "", err
		}
		p.Generations = append(p.Generations, vaultbackup.Generation{Generation: g.Generation, State: g.State,
			KeyShares: g.KeyShares, KeyThreshold: g.KeyThreshold, UnsealKeys: keys})
		exported = append(exported, g.Generation)
	}
	data, err := vaultbackup.Encrypt(p, passphrase)
	if err != nil {
		return nil, "", err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.custody_backup", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"generations": exported, "include_history": includeHistory}})
	name := fmt.Sprintf("%s-unseal-keys-gen%d-%s.ndvkb", cl.Name, cu.SealGeneration, time.Now().UTC().Format("20060102T150405Z"))
	return data, name, nil
}

// ---- Views ----

// CustodyView is the custody state without secrets.
type CustodyView struct {
	Initialized          bool       `json:"initialized"`
	KeyShares            int        `json:"key_shares"`
	KeyThreshold         int        `json:"key_threshold"`
	SealGeneration       int        `json:"seal_generation"`
	AdminTokenConfigured bool       `json:"admin_token_configured"`
	AdminTokenExpiresAt  *time.Time `json:"admin_token_expires_at"`
	RootTokenPresent     bool       `json:"root_token_present"`
	AutoUnsealByDeck     bool       `json:"auto_unseal_by_deck"`
	SuppressedReason     string     `json:"unseal_suppressed_reason"`
	InitializedAt        *time.Time `json:"initialized_at"`
	LastUnsealedAt       *time.Time `json:"last_unsealed_at"`
}

func tp(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// Custody returns the custody view.
func (s *Service) Custody(ctx context.Context, clusterID string) (*CustodyView, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	return &CustodyView{Initialized: cu.Initialized, KeyShares: cu.KeyShares, KeyThreshold: cu.KeyThreshold,
		SealGeneration: cu.SealGeneration, AdminTokenConfigured: cu.AdminTokenEncrypted != "",
		AdminTokenExpiresAt: tp(cu.AdminTokenExpiresAt), RootTokenPresent: cu.BootstrapRootTokenEncrypted != "",
		AutoUnsealByDeck: cu.AutoUnsealByDeck, SuppressedReason: cu.UnsealSuppressedReason,
		InitializedAt: tp(cu.InitializedAt), LastUnsealedAt: tp(cu.LastUnsealedAt)}, nil
}

// GenerationView is a key generation without keys.
type GenerationView struct {
	Generation   int        `json:"generation"`
	State        string     `json:"state"`
	KeyShares    int        `json:"key_shares"`
	KeyThreshold int        `json:"key_threshold"`
	CreatedAt    time.Time  `json:"created_at"`
	ActivatedAt  *time.Time `json:"activated_at"`
	RetiredAt    *time.Time `json:"retired_at"`
}

// Generations lists key generations without key material.
func (s *Service) Generations(ctx context.Context, clusterID string) ([]GenerationView, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	gens, err := db.ListKeyGenerations(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	out := []GenerationView{}
	for _, g := range gens {
		out = append(out, GenerationView{Generation: g.Generation, State: g.State, KeyShares: g.KeyShares,
			KeyThreshold: g.KeyThreshold, CreatedAt: g.CreatedAt, ActivatedAt: tp(g.ActivatedAt), RetiredAt: tp(g.RetiredAt)})
	}
	return out, nil
}
