package vault

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
)

// RekeyInput starts or resumes a rekey.
type RekeyInput struct {
	KeyShares    int `json:"key_shares"`
	KeyThreshold int `json:"key_threshold"`
	// AuthorizeMaintenance allows sealing the only node of a single-node
	// cluster while reconciling an in-doubt verification.
	AuthorizeMaintenance bool `json:"authorize_maintenance_window"`
}

const reasonRekeyReconcile = "rekey_reconcile"

func pendingGeneration(gens []*db.KeyGeneration) *db.KeyGeneration {
	for _, g := range gens { // newest first
		if g.State == db.GenPendingVerification || g.State == db.GenVerificationInDoubt {
			return g
		}
	}
	return nil
}

// Rekey rotates the unseal keys with verification, or resumes/reconciles an
// unfinished rotation.
func (s *Service) Rekey(ctx context.Context, actor audit.Actor, clusterID string, in RekeyInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	if cl.MaintenanceMode && cl.MaintenanceReason != reasonRekeyReconcile {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	gens, err := db.ListKeyGenerations(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	pending := pendingGeneration(gens)
	if pending == nil {
		cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
		if err != nil {
			return nil, err
		}
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
	params := map[string]any{"key_shares": in.KeyShares, "key_threshold": in.KeyThreshold,
		"authorize_maintenance_window": in.AuthorizeMaintenance}
	if pending != nil {
		params["resume_generation"], params["resume_state"] = pending.Generation, pending.State
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "vault.rekey", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: params,
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRekey(ctx, t, clusterID, in)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.rekey", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: params})
	return task, nil
}

func (s *Service) runRekey(ctx context.Context, t *ops.Task, clusterID string, in RekeyInput) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	gens, err := db.ListKeyGenerations(ctx, s.DB.Reader, clusterID)
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
	// Newer Vault versions require a token on the rekey endpoints.
	tok, err := s.adminToken(ctx, clusterID)
	if err != nil {
		return err
	}
	c, err := s.client(cl, am, tok)
	if err != nil {
		return err
	}
	pending := pendingGeneration(gens)
	if pending == nil {
		if pending, err = s.startRekey(ctx, t, cl, c, in); err != nil {
			return err
		}
	}
	if pending.State == db.GenPendingVerification {
		return s.continueVerification(ctx, t, cl, c, pending)
	}
	return s.reconcileRekey(ctx, t, cl, c, members, pending, in)
}

func (s *Service) startRekey(ctx context.Context, t *ops.Task, cl *cluster, c *Client, in RekeyInput) (*db.KeyGeneration, error) {
	step, err := t.Step("生成新的 Unseal Key", "")
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*db.KeyGeneration, error) { step.Finish(err, nil); return nil, err }
	// A rekey left in Vault without stored keys never took effect: cancel it.
	if st, err := c.RekeyStatus(ctx); err == nil && st.Started {
		step.Logf("取消 Vault 中残留的、未保存新密钥的 Rekey")
		if err := c.RekeyCancel(ctx, st.Nonce); err != nil {
			return fail(fmt.Errorf("取消残留 Rekey：%w", err))
		}
	}
	oldKeys, oldGen, err := s.activeKeys(ctx, cl.ID)
	if err != nil {
		return fail(err)
	}
	init, err := c.RekeyInit(ctx, in.KeyShares, in.KeyThreshold)
	if err != nil {
		return fail(fmt.Errorf("rekey init：%w", err))
	}
	var upd *RekeyStatus
	for _, k := range oldKeys {
		if upd, err = c.RekeyUpdate(ctx, k, init.Nonce); err != nil {
			_ = c.RekeyCancel(ctx, init.Nonce)
			return fail(fmt.Errorf("提交第 %d 代密钥：%w", oldGen, err))
		}
		if upd.Complete {
			break
		}
	}
	if upd == nil || !upd.Complete || upd.VerificationNonce == "" {
		_ = c.RekeyCancel(ctx, init.Nonce)
		return fail(errors.New("rekey 未返回新密钥与验证 nonce"))
	}
	newKeys := upd.KeysBase64
	if len(newKeys) == 0 {
		newKeys = upd.Keys
	}
	var g *db.KeyGeneration
	store := func() error {
		return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
			max, err := db.MaxKeyGeneration(ctx, tx, cl.ID)
			if err != nil {
				return err
			}
			enc, err := s.encryptKeys(cl.ID, max+1, newKeys)
			if err != nil {
				return err
			}
			g = &db.KeyGeneration{ClusterID: cl.ID, Generation: max + 1, KeyShares: in.KeyShares, KeyThreshold: in.KeyThreshold,
				UnsealKeysEncrypted: enc, RekeyVerificationNonce: upd.VerificationNonce, State: db.GenPendingVerification,
				CreatedAt: s.DB.Now()}
			return db.InsertKeyGeneration(ctx, tx, g)
		})
	}
	for i := 0; i < 5; i++ {
		if err = store(); err == nil {
			break
		}
		time.Sleep(time.Duration(i+1) * 500 * time.Millisecond)
	}
	if err != nil {
		_ = c.RekeyCancel(ctx, init.Nonce) // the new keys were never verified, so nothing changed
		return fail(fmt.Errorf("新密钥未能落库，已取消本次 Rekey：%w", err))
	}
	_ = t.Checkpoint(map[string]any{"phase": "keys_stored", "generation": g.Generation})
	step.Logf("第 %d 代密钥已加密落库（pending_verification），Vault 仍使用第 %d 代密钥", g.Generation, oldGen)
	step.Finish(nil, nil)
	return g, nil
}

// continueVerification submits the new keys, marking the generation in
// doubt before the final key.
func (s *Service) continueVerification(ctx context.Context, t *ops.Task, cl *cluster, c *Client, g *db.KeyGeneration) error {
	step, err := t.Step(fmt.Sprintf("验证第 %d 代密钥", g.Generation), "")
	if err != nil {
		return err
	}
	err = s.verifyFrom(ctx, cl, c, g, step.Logf)
	step.Finish(err, nil)
	return err
}

func (s *Service) verifyFrom(ctx context.Context, cl *cluster, c *Client, g *db.KeyGeneration, log func(string, ...any)) error {
	keys, _, err := s.keysOf(ctx, s.DB.Reader, cl.ID, g.Generation)
	if err != nil {
		return err
	}
	vs, err := c.RekeyVerifyStatus(ctx)
	if IsNoRekeyInProgress(err) && g.State == db.GenPendingVerification {
		// The last key was never submitted, so the new keys never took effect.
		_ = db.SetKeyGenerationState(ctx, s.DB.Writer, cl.ID, g.Generation, db.GenAbandoned, "", s.DB.Now())
		return conflict("rekey_lost", "Vault 中已不存在进行中的 Rekey 验证（可能因 Active 节点切换而丢失）；第 %d 代密钥从未生效，已标记为 abandoned，请重新发起 Rekey", g.Generation)
	}
	if err != nil {
		return err
	}
	nonce := g.RekeyVerificationNonce
	if vs.Nonce != "" && vs.Nonce != nonce {
		nonce = vs.Nonce
		log("Vault 返回了新的验证 nonce，已同步保存")
		if err := db.SetKeyGenerationState(ctx, s.DB.Writer, cl.ID, g.Generation, g.State, nonce, s.DB.Now()); err != nil {
			return err
		}
	}
	threshold := g.KeyThreshold
	for i := vs.Progress; i < threshold; i++ {
		if i == threshold-1 && g.State != db.GenVerificationInDoubt {
			if err := db.SetKeyGenerationState(ctx, s.DB.Writer, cl.ID, g.Generation, db.GenVerificationInDoubt, nonce, s.DB.Now()); err != nil {
				return err
			}
			g.State = db.GenVerificationInDoubt
		}
		r, err := c.RekeyVerifyUpdate(ctx, keys[i], nonce)
		if err != nil {
			return fmt.Errorf("提交验证密钥失败（第 %d 代保持 %s）：%w", g.Generation, g.State, err)
		}
		if r.Complete {
			return s.activateGeneration(ctx, cl, g.Generation, log)
		}
	}
	return fmt.Errorf("提交阈值数量的验证密钥后 Vault 仍未确认完成")
}

func (s *Service) activateGeneration(ctx context.Context, cl *cluster, gen int, log func(string, ...any)) error {
	if err := s.DB.WithTx(ctx, func(tx *sql.Tx) error {
		return db.ActivateGeneration(ctx, tx, cl.ID, gen, s.DB.Now())
	}); err != nil {
		return err
	}
	log("第 %d 代密钥已生效，原生效代际已退役并继续保留", gen)
	return nil
}

// reconcileRekey resolves a generation left in verification_in_doubt.
func (s *Service) reconcileRekey(ctx context.Context, t *ops.Task, cl *cluster, c *Client, members []*db.ClusterNode,
	g *db.KeyGeneration, in RekeyInput) error {
	step, err := t.Step(fmt.Sprintf("核对第 %d 代密钥的验证结局", g.Generation), "")
	if err != nil {
		return err
	}
	err = s.reconcile(ctx, t, cl, c, members, g, in, step.Logf)
	step.Finish(err, nil)
	return err
}

func (s *Service) reconcile(ctx context.Context, t *ops.Task, cl *cluster, c *Client, members []*db.ClusterNode,
	g *db.KeyGeneration, in RekeyInput, log func(string, ...any)) error {
	if !cl.MaintenanceMode {
		if err := db.SetClusterMaintenance(ctx, s.DB.Writer, cl.ID, true, reasonRekeyReconcile, s.DB.Now()); err != nil {
			return err
		}
		log("集群进入维护态并暂停自动解封")
	}
	conclude := func() error {
		return db.SetClusterMaintenance(ctx, s.DB.Writer, cl.ID, false, "", s.DB.Now())
	}
	vs, err := c.RekeyVerifyStatus(ctx)
	switch {
	case err == nil && vs.Started:
		log("Vault 中验证流程仍在进行（已提交 %d/%d），继续提交", vs.Progress, g.KeyThreshold)
		if err := s.verifyFrom(ctx, cl, c, g, log); err != nil {
			return err
		}
		return conclude()
	case err != nil && !IsNoRekeyInProgress(err):
		return fmt.Errorf("无法查询验证状态，保持维护态：%w", err)
	}
	newKeys, _, err := s.keysOf(ctx, s.DB.Reader, cl.ID, g.Generation)
	if err != nil {
		return err
	}
	oldKeys, oldGen, err := s.activeKeys(ctx, cl.ID)
	if err != nil {
		return err
	}
	tok, err := s.adminToken(ctx, cl.ID)
	if err != nil {
		return err
	}
	admin := c.WithToken(tok)
	// Choose the node to seal for the evidence check.
	var check *db.ClusterNode
	if len(members) == 1 {
		if !in.AuthorizeMaintenance {
			return conflict("maintenance_window_required", "单节点集群核对需要封存唯一节点并中断服务，请确认维护窗口后重新发起（authorize_maintenance_window）")
		}
		check = members[0]
		log("单节点集群：管理员已授权维护窗口，封存唯一节点 %s", check.NodeName)
		if err := admin.Seal(ctx); err != nil {
			return fmt.Errorf("封存失败，保持维护态：%w", err)
		}
	} else {
		for _, m := range members {
			mc, err := s.client(cl, m, "")
			if err != nil {
				continue
			}
			h, err := mc.Health(ctx)
			if err != nil || h.Sealed || !h.Standby {
				continue
			}
			r, err := s.gate(ctx, admin, m, false)
			if err == nil && r.Allowed {
				check = m
				break
			}
		}
		if check == nil {
			return conflict("quorum_gate", "没有可以安全封存的 Standby 节点（仲裁门禁不允许），保持维护态")
		}
		log("通过重启封存 Standby 节点 %s 进行核对", check.NodeName)
		if err := s.sealByRestart(ctx, t, check); err != nil {
			return fmt.Errorf("封存核对节点失败，保持维护态：%w", err)
		}
	}
	cc, err := s.client(cl, check, "")
	if err != nil {
		return err
	}
	if _, err := s.waitAPI(ctx, cl, check, ""); err != nil {
		return err
	}
	sealed, err := unsealWith(ctx, cc, newKeys)
	if err == nil && !sealed {
		log("第 %d 代密钥解封成功：Vault 已切换到新密钥", g.Generation)
		if err := s.activateGeneration(ctx, cl, g.Generation, log); err != nil {
			return err
		}
		return conclude()
	}
	if !IsInvalidKey(err) {
		return fmt.Errorf("证据不足（新密钥解封结果：%v），两代密钥均保留，集群保持维护态", err)
	}
	log("第 %d 代密钥被 Vault 判定为无效，尝试第 %d 代密钥", g.Generation, oldGen)
	_ = cc.UnsealReset(ctx)
	sealed, err = unsealWith(ctx, cc, oldKeys)
	if err != nil || sealed {
		return fmt.Errorf("证据不足（原代际密钥解封结果：%v），两代密钥均保留，集群保持维护态", err)
	}
	if err := db.SetKeyGenerationState(ctx, s.DB.Writer, cl.ID, g.Generation, db.GenAbandoned, "", s.DB.Now()); err != nil {
		return err
	}
	log("第 %d 代密钥解封成功：Rekey 未生效，第 %d 代标记为 abandoned 保留备查", oldGen, g.Generation)
	return conclude()
}
