package nomad

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
)

// ---- Certificates ----

// reissueClientCert issues a new control plane client certificate from the
// signing CA.
func (s *Service) reissueClientCert(ctx context.Context, cl *nomadCluster, ca *pki.CA) error {
	cn := "cli." + cl.Region + ".nomad"
	cli, err := ca.Issue(pki.Request{CommonName: cn, Hosts: []string{cn, "localhost"}}, time.Now())
	if err != nil {
		return err
	}
	enc, err := s.Keys.EncryptString(cli.KeyPEM, db.ClusterClientKeyAAD(cl.ID))
	if err != nil {
		return err
	}
	cl.ClientCertPEM, cl.ClientKeyEncrypted, cl.ClientCertExpiresAt = cli.CertPEM, enc, cli.NotAfter
	return db.UpdateClusterTLS(ctx, s.DB.Writer, cl.Cluster, s.DB.Now())
}

// RenewCerts issues new node certificates and the control plane client
// certificate, rolled out member by member.
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
			if err := s.rolling(ctx, t, cl, "续期证书", confirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
				return s.applyAndVerify(ctx, cl, nc, gi, m)
			}); err != nil {
				return err
			}
			step, err := t.Step("续期控制面客户端证书", "")
			if err != nil {
				return err
			}
			err = s.reissueClientCert(ctx, cl, gi.ca)
			step.Finish(err, nil)
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.cert_renew", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

// RotateCA replaces the cluster CA with an overlap: the trust bundle first
// holds both CAs (and integrations receive it), every member and the
// control plane client get certificates from the new CA, then the old CA
// is dropped from the bundle everywhere.
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

func (s *Service) notifyCA(ctx context.Context, t *ops.Task, clusterID, title string) error {
	if s.OnCAChange == nil {
		return nil
	}
	step, err := t.Step(title, "")
	if err != nil {
		return err
	}
	err = s.OnCAChange(ctx, clusterID, step.Logf)
	step.Finish(err, nil)
	return err
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
		step, err := t.Step("生成新 CA 并组成双 CA 信任链", "")
		if err != nil {
			return err
		}
		err = func() error {
			caM, err := pki.NewCA("NomadDeck Nomad CA "+cl.Name, pki.CATTL, time.Now())
			if err != nil {
				return err
			}
			enc, err := s.Keys.EncryptString(caM.KeyPEM, db.ClusterCAKeyAAD(cl.ID))
			if err != nil {
				return err
			}
			cl.CACertPEM = strings.TrimSpace(cl.CACertPEM) + "\n" + caM.CertPEM
			cl.CAKeyEncrypted = enc
			cl.CAExpiresAt, _ = pki.EarliestExpiry(cl.CACertPEM)
			return db.UpdateClusterTLS(ctx, s.DB.Writer, cl.Cluster, s.DB.Now())
		}()
		step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	_ = t.Checkpoint(map[string]any{"phase": "overlap"})
	if err := s.notifyCA(ctx, t, clusterID, "向联动集群下发双 CA 信任链"); err != nil {
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
	// Every node must trust the new CA before any node presents a
	// certificate from it: first spread the dual bundle with unchanged
	// certificates, then reissue.
	gi.reuseLeaf = true
	if err := s.rolling(ctx, t, cl, "下发双 CA 信任链", confirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
		return s.applyAndVerify(ctx, cl, nc, gi, m)
	}); err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "reissue"})
	gi.reuseLeaf = false
	if err := s.rolling(ctx, t, cl, "签发新 CA 证书", confirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
		return s.applyAndVerify(ctx, cl, nc, gi, m)
	}); err != nil {
		return err
	}
	if err := s.reissueClientCert(ctx, cl, gi.ca); err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "drop_old"})
	cl.CACertPEM = pki.EncodeCert(gi.ca.Cert.Raw)
	cl.CAExpiresAt = gi.ca.Cert.NotAfter
	if err := db.UpdateClusterTLS(ctx, s.DB.Writer, cl.Cluster, s.DB.Now()); err != nil {
		return err
	}
	gi.caBundle = cl.CACertPEM
	if err := s.rolling(ctx, t, cl, "移除旧 CA", confirmSingle, func(nc *cluster.NodeCtx, m *db.ClusterNode, _ []*db.ClusterNode) error {
		return s.applyAndVerify(ctx, cl, nc, gi, m)
	}); err != nil {
		return err
	}
	return s.notifyCA(ctx, t, clusterID, "向联动集群下发新 CA 信任链")
}

// ---- Gossip key rotation ----

// RotateGossip rotates the gossip encryption key without restarting
// servers: the new key is stored as pending, installed on every server
// through the keyring API, made primary, verified on all servers, the old
// key removed, and the servers' configuration generations updated so later
// restarts use the new key. Each step is idempotent so an interrupted
// rotation resumes with the same pending key.
func (s *Service) RotateGossip(ctx context.Context, actor audit.Actor, clusterID string) (*db.OperationTask, error) {
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
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.gossip_rotate", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRotateGossip(ctx, t, clusterID)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.gossip_rotate", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

func (s *Service) runRotateGossip(ctx context.Context, t *ops.Task, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	step, err := t.Step("经 Keyring 接口轮换 Gossip 密钥", "")
	if err != nil {
		return err
	}
	var pending string
	err = func() error {
		old, err := s.gossipKey(cl)
		if err != nil {
			return err
		}
		encPending, err := db.GetClusterGossipPending(ctx, s.DB.Reader, cl.ID)
		if err != nil {
			return err
		}
		if encPending == "" {
			if pending, err = GenerateGossipKey(); err != nil {
				return err
			}
			if encPending, err = s.Keys.EncryptString(pending, db.ClusterGossipPendingAAD(cl.ID)); err != nil {
				return err
			}
			if err := db.SetClusterGossipKeys(ctx, s.DB.Writer, cl.ID, cl.GossipKeyEncrypted, encPending, s.DB.Now()); err != nil {
				return err
			}
			step.Logf("新密钥已加密暂存")
		} else {
			if pending, err = s.Keys.DecryptString(encPending, db.ClusterGossipPendingAAD(cl.ID)); err != nil {
				return err
			}
			step.Logf("继续上次未完成的轮换")
		}
		api, _, err := s.apiClient(ctx, cl, "")
		if err != nil {
			return err
		}
		if err := api.KeyringOp(ctx, "install", pending); err != nil {
			return fmt.Errorf("install: %w", err)
		}
		if err := api.KeyringOp(ctx, "use", pending); err != nil {
			return fmt.Errorf("use: %w", err)
		}
		keys, total, err := api.KeyringList(ctx)
		if err != nil {
			return err
		}
		if keys[pending] < total || total == 0 {
			return fmt.Errorf("新密钥只安装在 %d/%d 台 Server 上", keys[pending], total)
		}
		step.Logf("新密钥已在全部 %d 台 Server 上安装并设为主用", total)
		if old != "" && old != pending {
			if _, ok := keys[old]; ok {
				if err := api.KeyringOp(ctx, "remove", old); err != nil {
					return fmt.Errorf("remove old key: %w", err)
				}
			}
			step.Logf("旧密钥已从全部 Server 移除")
		}
		return nil
	}()
	step.Finish(err, nil)
	if err != nil {
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
	gi.gossip = pending
	for _, m := range servers(members) {
		if err := func() (err error) {
			nc, err := s.remote().Open(ctx, t, m.NodeID, "写入新 Gossip 密钥配置")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if err := s.applyGeneration(ctx, nc, gi, m); err != nil {
				return err
			}
			nc.Step.Logf("新配置代际已生效于下次重启（本次不重启）")
			return nil
		}(); err != nil {
			return err
		}
	}
	enc, err := s.Keys.EncryptString(pending, db.ClusterGossipKeyAAD(cl.ID))
	if err != nil {
		return err
	}
	return db.SetClusterGossipKeys(ctx, s.DB.Writer, cl.ID, enc, "", s.DB.Now())
}

// ---- Upgrade ----

// PlanUpgrade previews an upgrade.
func (s *Service) PlanUpgrade(ctx context.Context, clusterID, version string) (*cluster.UpgradePlan, error) {
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
	p := &cluster.UpgradePlan{Current: cl.Settings.Version, Target: version,
		Check: release.CheckUpgrade("nomad", cl.Settings.Version, version, db.IntSetting(ctx, s.DB.Reader, "upgrade.max_minor_skip", 2))}
	leader := s.leaderMember(ctx, cl, members)
	for _, m := range s.rollingOrder(ctx, cl, members) {
		label := m.Role
		if leader != nil && m.ID == leader.ID {
			label += "，Leader"
		}
		p.Order = append(p.Order, m.NodeName+"（"+label+"）")
	}
	return p, nil
}

// Upgrade performs the rolling upgrade: verified pre-upgrade snapshot,
// non-leader servers one by one, the leader, then clients in batches
// (optionally drained first). A node whose new binary never starts is
// switched back to the old binary; a node that started the new version but
// does not recover trips the circuit breaker without downgrading.
func (s *Service) Upgrade(ctx context.Context, actor audit.Actor, clusterID string, in cluster.UpgradeInput) (*db.OperationTask, error) {
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
	if len(servers(members)) == 1 && !in.ConfirmSingle {
		return nil, conflict("confirm_single_node", "单 Server 集群升级会中断调度与 API，需显式确认")
	}
	if in.ClientBatch <= 0 {
		in.ClientBatch = 1
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.upgrade", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Params: map[string]any{"from": cl.Settings.Version, "to": in.Version, "use_proxy": hc.UseProxy, "confirm": in.Confirm,
			"drain_clients": in.DrainClients, "client_batch": in.ClientBatch},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runUpgrade(ctx, t, cl.ID, in, hc)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.upgrade", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"from": cl.Settings.Version, "to": in.Version,
			"drain_clients": in.DrainClients}})
	return task, nil
}

func (s *Service) runUpgrade(ctx context.Context, t *ops.Task, clusterID string, in cluster.UpgradeInput, hc *cluster.HTTPClient) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	arts, err := s.fetchArtifacts(ctx, t, hc, cl, in.Version, members)
	if err != nil {
		return err
	}
	step, err := t.Step("升级前 Raft 快照", "")
	if err != nil {
		return err
	}
	snap, err := s.takeSnapshot(ctx, cl, "pre_upgrade", "system:upgrade")
	if err == nil {
		step.Logf("升级前快照 %s 已加密保存并回读校验通过", snap.ID)
	}
	step.Finish(err, nil)
	if err != nil {
		return fmt.Errorf("升级前快照失败，未改动任何节点：%w", err)
	}
	_ = t.Checkpoint(map[string]any{"phase": "snapshot", "snapshot_id": snap.ID, "to": in.Version})
	order := s.rollingOrder(ctx, cl, members)
	var batch []*db.ClusterNode
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		var wg sync.WaitGroup
		errs := make([]error, len(batch))
		for i, m := range batch {
			wg.Add(1)
			go func(i int, m *db.ClusterNode) {
				defer wg.Done()
				errs[i] = s.upgradeNode(ctx, t, cl, m, arts, in)
			}(i, m)
		}
		wg.Wait()
		batch = nil
		return errors.Join(errs...)
	}
	for _, m := range order {
		if m.InstallState != "installed" || m.InstalledVersion == in.Version {
			continue
		}
		if IsServer(m.Role) {
			if err := s.upgradeNode(ctx, t, cl, m, arts, in); err != nil {
				return err
			}
			_ = t.Checkpoint(map[string]any{"phase": "node_done", "node": m.NodeName, "snapshot_id": snap.ID, "to": in.Version})
			continue
		}
		batch = append(batch, m)
		if len(batch) >= in.ClientBatch {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}
	cl.Settings.Version = in.Version
	if err := s.saveSettings(ctx, cl); err != nil {
		return err
	}
	_, _ = s.StatusDetail(ctx, cl.ID)
	return nil
}

func (s *Service) upgradeNode(ctx context.Context, t *ops.Task, cl *nomadCluster, m *db.ClusterNode, arts *artifacts,
	in cluster.UpgradeInput) (err error) {
	nc, err := s.remote().Open(ctx, t, m.NodeID, "升级")
	if err != nil {
		return err
	}
	defer func() { nc.Done(ctx, err) }()
	art := arts.nomad[nc.Node.Arch]
	old := m.InstalledVersion
	if err := s.gateFor(ctx, cl, m, in.ConfirmSingle, nc.Step.Logf); err != nil {
		return err
	}
	drained := false
	if IsClient(m.Role) && !IsServer(m.Role) && in.DrainClients {
		if err := s.drainClient(ctx, cl, m, nc.Step.Logf); err != nil {
			return err
		}
		drained = true
	}
	if err := s.installBinary(ctx, t, nc, art); err != nil {
		return err
	}
	if err := s.service(ctx, nc, "restart"); err != nil {
		return err
	}
	if err := s.waitVersion(ctx, cl, m, in.Version); err != nil {
		// The new binary never served: nothing was migrated, switch back.
		nc.Step.Logf("新版本未能启动（%v），回切到 %s", err, old)
		if old == "" {
			return fmt.Errorf("%s 升级失败且无旧版本可回退：%w", m.NodeName, err)
		}
		if _, rerr := nc.Run(ctx, ActivateBinaryScript(old)); rerr != nil {
			return fmt.Errorf("%s 升级失败且回切旧版本 %s 失败（%v）：%w", m.NodeName, old, rerr, err)
		}
		if serr := s.service(ctx, nc, "restart"); serr != nil {
			return fmt.Errorf("%s 回切旧版本 %s 后重启失败（%v）：%w", m.NodeName, old, serr, err)
		}
		if recErr := s.recoverNode(ctx, cl, m, nc.Step.Logf); recErr != nil {
			return fmt.Errorf("%s 回切旧版本 %s 后未恢复健康（%v）：%w", m.NodeName, old, recErr, err)
		}
		return fmt.Errorf("%s 升级失败并已回切旧版本，后续节点未升级：%w", m.NodeName, ops.ErrRolledBack)
	}
	if err := s.recoverNode(ctx, cl, m, nc.Step.Logf); err != nil {
		return fmt.Errorf("熔断：%s 已运行新版本但未恢复健康，禁止自动降级，请检查后按升级前快照恢复：%w", m.NodeName, err)
	}
	if drained {
		if err := s.undrain(ctx, cl, m); err != nil {
			return fmt.Errorf("%s 已升级，但恢复调度失败：%w", m.NodeName, err)
		}
		nc.Step.Logf("已取消疏散并恢复调度")
	}
	m.InstalledVersion = in.Version
	m.KeptVersionsJSON = cluster.AddKept(m.KeptVersionsJSON, in.Version)
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

// waitVersion waits until the agent answers and reports the expected version.
func (s *Service) waitVersion(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, version string) error {
	tok, err := s.managementToken(cl)
	if err != nil {
		return err
	}
	c, err := s.client(cl, m, tok)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(90 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		self, err := c.Self(ctx)
		if err == nil {
			if self.Version == version {
				return nil
			}
			err = fmt.Errorf("节点报告的版本 %s 与期望的 %s 不一致", self.Version, version)
		}
		last = err
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
	return fmt.Errorf("等待 %s 以新版本启动超时：%v", m.NodeName, last)
}
