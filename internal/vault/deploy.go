package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

// ---- Preflight ----

func (s *Service) preflight(ctx context.Context, members []*db.ClusterNode, confirmSwap bool) ([]PreflightIssue, error) {
	var out []PreflightIssue
	for _, m := range members {
		n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
		if err != nil {
			return nil, err
		}
		add := func(sev, format string, args ...any) {
			out = append(out, PreflightIssue{NodeID: n.ID, Node: n.Name, Severity: sev, Message: fmt.Sprintf(format, args...)})
		}
		if n.MachineID == "" || n.LastCheckedAt.IsZero() {
			add("block", "主机尚未完成连通性测试与环境探测")
			continue
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
		if abs(n.ClockSkewMS) > hosts.MaxClockSkew.Milliseconds() {
			add("block", "与控制面的时钟偏差 %d 毫秒，超过 30 秒", n.ClockSkewMS)
		}
		var probeSwap struct {
			SwapEncrypted bool `json:"swap_encrypted"`
		}
		_ = json.Unmarshal([]byte(n.ProbeJSON), &probeSwap)
		if n.SwapEnabled && !probeSwap.SwapEncrypted {
			if confirmSwap {
				add("warn", "已启用未加密的 Swap（管理员已确认）")
			} else {
				add("confirm", "已启用未加密的 Swap：Vault 使用 disable_mlock，内存中的密钥可能被换出到磁盘。请禁用 Swap，或在确认风险后勾选“确认 Swap 风险”")
			}
		}
		if n.SELinuxMode == "enforcing" {
			add("warn", "SELinux 处于 enforcing，请确认 Vault 的端口与目录上下文策略")
		}
	}
	return out, nil
}

func blocking(issues []PreflightIssue) error {
	var msgs []string
	for _, i := range issues {
		if i.Severity == "block" || i.Severity == "confirm" {
			msgs = append(msgs, i.Node+"："+i.Message)
		}
	}
	if len(msgs) == 0 {
		return nil
	}
	return conflict("preflight_failed", "部署前检查未通过：\n%s", strings.Join(msgs, "\n"))
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// ---- Remote helpers ----

type nodeCtx struct {
	m    *db.ClusterNode
	node *db.Node
	ssh  *sshx.Client
	step *ops.Step
	seq  int
}

func (s *Service) connect(ctx context.Context, m *db.ClusterNode) (*db.Node, *sshx.Client, error) {
	n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
	if err != nil {
		return nil, nil, err
	}
	if s.Hosts == nil {
		return nil, nil, errors.New("SSH is not available")
	}
	c, err := s.Hosts.Connect(ctx, n)
	if err != nil {
		return nil, nil, fmt.Errorf("SSH %s: %w", n.Name, err)
	}
	return n, c, nil
}

func (s *Service) openNode(ctx context.Context, t *ops.Task, m *db.ClusterNode, title string) (*nodeCtx, error) {
	n, c, err := s.connect(ctx, m)
	if err != nil {
		return nil, err
	}
	step, err := t.Step(title+" "+n.Name, n.ID)
	if err != nil {
		return nil, err
	}
	nc := &nodeCtx{m: m, node: n, ssh: c, step: step}
	if err := s.writeOpLock(ctx, nc, t); err != nil {
		step.Finish(err, nil)
		return nil, err
	}
	return nc, nil
}

func (nc *nodeCtx) done(ctx context.Context, err error) {
	if err == nil {
		_, _ = nc.ssh.Run(ctx, "rm -f "+sshx.Quote(OpLockFile), sshx.RunOptions{Sudo: true})
	}
	nc.step.Finish(err, nil)
}

func (s *Service) writeOpLock(ctx context.Context, nc *nodeCtx, t *ops.Task) error {
	b, _ := json.Marshal(map[string]any{"remote_op_id": t.RemoteOpID, "task_id": t.ID, "product": "vault",
		"unit_prefix": sshx.UnitName(t.RemoteOpID, ""), "started_at": time.Now().UTC().Format(time.RFC3339)})
	return sshx.PutFile(ctx, nc.ssh, OpLockFile, b, "0600", "root:root", "0755")
}

// remote runs a script as a detached transient unit and follows its log.
func (s *Service) remote(ctx context.Context, t *ops.Task, nc *nodeCtx, name, script string) error {
	nc.seq++
	stepID := fmt.Sprintf("%s-%d", name, nc.seq)
	nc.step.SetRemoteUnit(sshx.UnitName(t.RemoteOpID, stepID))
	r, err := sshx.RunStep(ctx, nc.ssh, sshx.StepSpec{Product: "vault", OpID: t.RemoteOpID, Step: stepID, Script: script,
		Log: nc.step.Log(), Poll: 500 * time.Millisecond})
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	_ = sshx.CleanupStep(ctx, nc.ssh, "vault", t.RemoteOpID, stepID)
	if r.Status != "success" {
		return fmt.Errorf("%s 在 %s 上失败（状态 %s，退出码 %d）", name, nc.node.Name, r.Status, r.ExitCode)
	}
	return nil
}

func (s *Service) run(ctx context.Context, nc *nodeCtx, script string) (string, error) {
	r, err := nc.ssh.Run(ctx, script, sshx.RunOptions{Sudo: true})
	if err != nil {
		return "", err
	}
	return string(r.Stdout), nil
}

func (s *Service) service(ctx context.Context, t *ops.Task, nc *nodeCtx, action string) error {
	script, err := ServiceScript(action)
	if err != nil {
		return err
	}
	nc.step.Logf("systemctl %s vault.service", action)
	return s.remote(ctx, t, nc, "svc-"+action, script)
}

// sansFor lists the hosts a node certificate must cover.
func sansFor(cl *cluster, m *db.ClusterNode, n *db.Node) []string {
	hostsList := []string{"localhost", "127.0.0.1", "::1", m.AdvertiseAddr, n.Host}
	var aliases []string
	_ = json.Unmarshal([]byte(n.AddressAliasesJSON), &aliases)
	hostsList = append(hostsList, aliases...)
	if cl.PublicAPIURL != "" {
		if u, err := url.Parse(cl.PublicAPIURL); err == nil && u.Hostname() != "" {
			hostsList = append(hostsList, u.Hostname())
		}
	}
	hostsList = append(hostsList, memberConfig(m).ExtraSANs...)
	return hostsList
}

func (s *Service) caSigner(cl *cluster) (*pki.CA, error) {
	key, err := s.Keys.DecryptString(cl.CAKeyEncrypted, db.ClusterCAKeyAAD(cl.ID))
	if err != nil {
		return nil, err
	}
	return pki.ParseCA(cl.CACertPEM, key)
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// buildGeneration renders a complete config generation for a node: a new
// certificate (when TLS is on), the CA bundle and config.hcl.
func (s *Service) buildGeneration(cl *cluster, m *db.ClusterNode, n *db.Node, peers []string, gen int,
	ca *pki.CA, caBundle string, current *pki.Material) ([]GenerationFile, *pki.Material, error) {
	mc := memberConfig(m)
	cfg := RenderConfig(NodeConfig{ClusterName: cl.Name, RaftNodeID: mc.RaftNodeID, Advertise: m.AdvertiseAddr,
		APIPort: cl.Settings.APIPort, ClusterPort: cl.Settings.ClusterPort, TLS: cl.TLSEnabled, Generation: gen, Peers: peers,
		Version: cl.Settings.Version})
	if err := ValidateHCL("config.hcl", cfg); err != nil {
		return nil, nil, err
	}
	files := []GenerationFile{{Name: "config.hcl", Content: []byte(cfg), Mode: "0640"}}
	var leaf *pki.Material
	if cl.TLSEnabled {
		if current != nil {
			leaf = current
		} else {
			now := time.Now()
			sans := sansFor(cl, m, n)
			var err error
			leaf, err = ca.Issue(pki.Request{CommonName: mc.RaftNodeID + "." + cl.Name + ".vault", Hosts: sans}, now)
			if err != nil {
				return nil, nil, err
			}
			if err := pki.Verify(leaf.CertPEM, leaf.KeyPEM, caBundle, sans, now, 24*time.Hour); err != nil {
				return nil, nil, fmt.Errorf("issued certificate failed verification: %w", err)
			}
		}
		files = append(files,
			GenerationFile{Name: "tls/ca.crt", Content: []byte(caBundle), Mode: "0640"},
			GenerationFile{Name: "tls/server.crt", Content: []byte(leaf.CertPEM), Mode: "0640"},
			GenerationFile{Name: "tls/server.key", Content: []byte(leaf.KeyPEM), Mode: "0640"})
	}
	for i := range files {
		files[i].SHA256 = sum(files[i].Content)
	}
	return files, leaf, nil
}

// pushGeneration uploads a candidate generation, verifies it on the node
// and atomically switches vault.d to it.
func (s *Service) pushGeneration(ctx context.Context, nc *nodeCtx, gen int, files []GenerationFile) error {
	dir := GenerationDir(gen)
	if _, err := s.run(ctx, nc, "rm -rf -- "+sshx.Quote(dir)); err != nil {
		return err
	}
	for _, f := range files {
		if err := sshx.PutFile(ctx, nc.ssh, dir+"/"+f.Name, f.Content, f.Mode, "root:vault", "0750"); err != nil {
			return fmt.Errorf("upload %s: %w", f.Name, err)
		}
	}
	out, err := s.run(ctx, nc, SwitchGenerationScript(gen, files))
	if err != nil {
		return fmt.Errorf("verify and switch generation %d: %w", gen, err)
	}
	nc.step.Logf("配置代际 %d 校验通过并已生效（%s）", gen, strings.TrimSpace(out))
	return nil
}

func peersOf(members []*db.ClusterNode, self *db.ClusterNode) []string {
	var out []string
	for _, p := range members {
		if p.ID != self.ID {
			out = append(out, p.APIAddr)
		}
	}
	return out
}

// installBinary relays a verified release and activates it.
func (s *Service) installBinary(ctx context.Context, t *ops.Task, nc *nodeCtx, art *release.Artifact) error {
	rate := int64(db.IntSetting(ctx, s.DB.Reader, "release.transfer_rate_limit", 0))
	nc.step.Logf("分发 Vault %s 二进制（%d 字节，gzip 压缩传输）", art.Version, art.PayloadSize)
	if err := s.Hosts.InstallArtifact(ctx, nc.ssh, t.RemoteOpID, art, VersionBinary(art.Version), "0755", rate); err != nil {
		return err
	}
	out, err := s.run(ctx, nc, ActivateBinaryScript(art.Version))
	if err != nil {
		return fmt.Errorf("activate binary: %w", err)
	}
	if IsEnterprise(out) {
		return conflict("enterprise_rejected", "检测到 Vault Enterprise 版本，NomadDeck 只支持 Community 版")
	}
	nc.step.Logf("已切换到 %s", strings.TrimSpace(out))
	return nil
}

// waitAPI waits until a node answers seal-status and checks its edition and version.
func (s *Service) waitAPI(ctx context.Context, cl *cluster, m *db.ClusterNode, version string) (*SealStatus, error) {
	c, err := s.client(cl, m, "")
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(90 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		st, err := c.SealStatus(ctx)
		if err == nil {
			if IsEnterprise(st.Version) {
				return nil, conflict("enterprise_rejected", "节点运行的是 Vault Enterprise（%s），NomadDeck 只支持 Community 版", st.Version)
			}
			if version != "" && st.Version != version {
				return nil, fmt.Errorf("节点报告的版本 %s 与期望的 %s 不一致", st.Version, version)
			}
			return st, nil
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(s.poll()):
		}
	}
	return nil, fmt.Errorf("等待 %s 的 Vault API 超时：%v", m.APIAddr, last)
}

func (s *Service) httpClient(ctx context.Context, useProxy *bool) (*httpClientResult, error) {
	use := s.Proxy.UseByDefault(ctx, netx.SettingUseForReleases)
	if useProxy != nil {
		use = *useProxy
	}
	c, addr, err := s.Proxy.Client(ctx, use, 30*time.Minute)
	if errors.Is(err, netx.ErrProxyNotConfigured) {
		return nil, badRequest("已选择使用系统代理，但尚未配置系统代理")
	}
	if err != nil {
		return nil, err
	}
	return &httpClientResult{client: c, useProxy: use, proxyAddr: addr}, nil
}

func validVersion(v string) error {
	if err := sshx.ValidVersion(v); err != nil || IsEnterprise(v) || strings.ContainsAny(v, "+-") {
		return badRequest("版本号 %q 无效（只支持 Community 正式版）", v)
	}
	if release.CompareVersions(v, release.MinVersions["vault"]) < 0 {
		return badRequest("Vault 版本需不低于 %s", release.MinVersions["vault"])
	}
	return nil
}

// fetchArtifacts downloads and verifies the release for every architecture in use.
func (s *Service) fetchArtifacts(ctx context.Context, t *ops.Task, hc *httpClientResult, version string, members []*db.ClusterNode) (map[string]*release.Artifact, error) {
	step, err := t.Step("下载并校验 Vault "+version, "")
	if err != nil {
		return nil, err
	}
	if hc.useProxy {
		step.Logf("经系统代理 %s 下载", hc.proxyAddr)
	}
	arts := map[string]*release.Artifact{}
	for _, m := range members {
		n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
		if err != nil {
			step.Finish(err, nil)
			return nil, err
		}
		if arts[n.Arch] != nil {
			continue
		}
		a, err := s.Releases.HashiCorp(ctx).Fetch(ctx, hc.client, "vault", version, "linux", n.Arch, step.Log())
		if err != nil {
			step.Finish(err, nil)
			return nil, err
		}
		arts[n.Arch] = a
	}
	step.Finish(nil, nil)
	return arts, nil
}

// ---- Deploy ----

// Preflight returns the deployment preflight report without changing anything.
func (s *Service) Preflight(ctx context.Context, clusterID string, confirmSwap bool) ([]PreflightIssue, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	return s.preflight(ctx, members, confirmSwap)
}

func memberLocks(clusterID string, members []*db.ClusterNode) []ops.LockReq {
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}}
	for _, m := range members {
		locks = append(locks, ops.LockReq{Key: ops.HostLock(m.NodeID, "vault"), Mode: ops.Exclusive})
	}
	return locks
}

// Deploy installs Vault on every member, writes the first config generation
// and starts the services. Nodes come up uninitialized and sealed.
func (s *Service) Deploy(ctx context.Context, actor audit.Actor, clusterID string, in DeployInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitUninitialized {
		return nil, conflict("cluster_initialized", "集群已初始化，不能重新部署；新增节点请使用扩容（Join）")
	}
	if cl.MaintenanceMode {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	if err := validVersion(in.Version); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, badRequest("集群没有成员节点")
	}
	issues, err := s.preflight(ctx, members, in.ConfirmSwap)
	if err != nil {
		return nil, err
	}
	if err := blocking(issues); err != nil {
		return nil, err
	}
	hc, err := s.httpClient(ctx, in.UseProxy)
	if err != nil {
		return nil, err
	}
	members = sortedMembers(members)
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.deploy", TargetType: "cluster", TargetID: cl.ID,
		Locks: memberLocks(cl.ID, members), TriggeredBy: actor.Name,
		Params: map[string]any{"version": in.Version, "use_proxy": hc.useProxy, "proxy": hc.proxyAddr, "confirm_swap": in.ConfirmSwap},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runDeploy(ctx, t, cl.ID, in.Version, hc)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.deploy", ResourceType: "cluster", ResourceID: cl.ID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"version": in.Version, "use_proxy": hc.useProxy,
			"nodes": len(members), "confirm_swap": in.ConfirmSwap}})
	return task, nil
}

func (s *Service) runDeploy(ctx context.Context, t *ops.Task, clusterID, version string, hc *httpClientResult) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	cl.Settings.Version = version // the config is rendered for the version being deployed
	_ = t.Checkpoint(map[string]any{"phase": "deploy", "version": version})
	arts, err := s.fetchArtifacts(ctx, t, hc, version, members)
	if err != nil {
		return err
	}
	var ca *pki.CA
	if cl.TLSEnabled {
		if ca, err = s.caSigner(cl); err != nil {
			return err
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, len(members))
	for i, m := range members {
		wg.Add(1)
		go func(i int, m *db.ClusterNode) {
			defer wg.Done()
			errs[i] = s.deployNode(ctx, t, cl, members, m, arts, ca)
		}(i, m)
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	cl.Settings.Version = version
	b, _ := json.Marshal(cl.Settings)
	cl.ConfigJSON = string(b)
	if err := db.UpdateClusterSettings(ctx, s.DB.Writer, cl.Cluster, s.DB.Now()); err != nil {
		return err
	}
	_, _, _ = s.SyncStatus(ctx, cl.ID)
	return nil
}

func (s *Service) deployNode(ctx context.Context, t *ops.Task, cl *cluster, members []*db.ClusterNode, m *db.ClusterNode,
	arts map[string]*release.Artifact, ca *pki.CA) (err error) {
	nc, err := s.openNode(ctx, t, m, "部署 Vault 到")
	if err != nil {
		return err
	}
	defer func() { nc.done(ctx, err) }()
	art := arts[nc.node.Arch]
	if art == nil {
		return fmt.Errorf("no artifact for %s", nc.node.Arch)
	}
	nc.step.Logf("准备主机目录、vault 用户、systemd 单元与 logrotate")
	if err := s.remote(ctx, t, nc, "prepare", PrepareScript(UnitContent, LogrotateContent(cl.Settings.AuditMaxMB, cl.Settings.AuditKeep))); err != nil {
		return err
	}
	if err := s.installBinary(ctx, t, nc, art); err != nil {
		return err
	}
	if err := s.applyGeneration(ctx, nc, cl, members, ca, cl.CACertPEM); err != nil {
		return err
	}
	if err := s.service(ctx, t, nc, "start"); err != nil {
		return err
	}
	st, err := s.waitAPI(ctx, cl, m, art.Version)
	if err != nil {
		return err
	}
	nc.step.Logf("Vault %s 已启动（initialized=%v sealed=%v）", st.Version, st.Initialized, st.Sealed)
	m.InstallState, m.InstalledVersion = "installed", art.Version
	m.KeptVersionsJSON = addKept(m.KeptVersionsJSON, art.Version)
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

// applyGeneration renders, ships and activates the next config generation
// of a node and records it (with the certificate expiry) on the member.
func (s *Service) applyGeneration(ctx context.Context, nc *nodeCtx, cl *cluster, members []*db.ClusterNode, ca *pki.CA, caBundle string) error {
	return s.applyGenerationOpts(ctx, nc, cl, members, ca, caBundle, false)
}

func (s *Service) applyGenerationOpts(ctx context.Context, nc *nodeCtx, cl *cluster, members []*db.ClusterNode, ca *pki.CA, caBundle string, reuseLeaf bool) error {
	mc := memberConfig(nc.m)
	gen := mc.ConfigGeneration + 1
	var current *pki.Material
	if reuseLeaf && cl.TLSEnabled && mc.ConfigGeneration > 0 {
		dir := GenerationDir(mc.ConfigGeneration)
		cert, err := s.run(ctx, nc, "cat "+sshx.Quote(dir+"/tls/server.crt"))
		if err != nil {
			return fmt.Errorf("read current certificate: %w", err)
		}
		key, err := s.run(ctx, nc, "cat "+sshx.Quote(dir+"/tls/server.key"))
		if err != nil {
			return fmt.Errorf("read current key: %w", err)
		}
		exp, err := pki.NotAfter(cert)
		if err != nil {
			return err
		}
		current = &pki.Material{CertPEM: cert, KeyPEM: key, NotAfter: exp}
	}
	files, leaf, err := s.buildGeneration(cl, nc.m, nc.node, peersOf(members, nc.m), gen, ca, caBundle, current)
	if err != nil {
		return err
	}
	if err := s.pushGeneration(ctx, nc, gen, files); err != nil {
		return err
	}
	mc.ConfigGeneration = gen
	setMemberConfig(nc.m, mc)
	if leaf != nil {
		nc.m.CertExpiresAt = leaf.NotAfter
	}
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, nc.m, s.DB.Now())
}

func addKept(js, version string) string {
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

type httpClientResult struct {
	client    *http.Client
	useProxy  bool
	proxyAddr string
}
