package nomad

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"nomad-deck/internal/sshx"
)

// ---- Preflight ----

func (s *Service) preflight(ctx context.Context, members []*db.ClusterNode) ([]cluster.PreflightIssue, error) {
	var out []cluster.PreflightIssue
	for _, m := range members {
		n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
		if err != nil {
			return nil, err
		}
		issues := cluster.HostIssues(n)
		out = append(out, issues...)
		if len(issues) > 0 && issues[0].Message == "主机尚未完成连通性测试与环境探测" {
			continue
		}
		add := func(sev, format string, args ...any) {
			out = append(out, cluster.PreflightIssue{NodeID: n.ID, Node: n.Name, Severity: sev, Message: fmt.Sprintf(format, args...)})
		}
		if IsClient(m.Role) {
			var probe struct {
				Tools map[string]bool `json:"tools"`
			}
			_ = json.Unmarshal([]byte(n.ProbeJSON), &probe)
			if probe.Tools != nil && !probe.Tools["ip"] {
				add("block", "缺少 ip 命令（iproute2），Nomad Client 无法完成网络指纹识别，请先安装 iproute2 并重新测试主机")
			}
			if n.SELinuxMode == "enforcing" {
				add("warn", "SELinux 处于 enforcing，请确认 Docker 与 CNI 的策略允许 Nomad 任务运行")
			}
			if n.DockerMode == "absent" || n.DockerMode == "" {
				add("warn", "主机未安装 Docker，Docker 任务驱动不可用（可在 Docker 管理中由控制面中转安装）")
			}
		}
	}
	return out, nil
}

// Preflight returns the deployment preflight report without changing anything.
func (s *Service) Preflight(ctx context.Context, clusterID string, _ bool) ([]cluster.PreflightIssue, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	return s.preflight(ctx, members)
}

func validVersion(v string) error {
	if err := sshx.ValidVersion(v); err != nil || strings.ContainsAny(v, "+-") {
		return badRequest("版本号 %q 无效（只支持 Community 正式版或 latest）", v)
	}
	if release.CompareVersions(v, release.MinVersions["nomad"]) < 0 {
		return badRequest("Nomad 版本需不低于 %s", release.MinVersions["nomad"])
	}
	return nil
}

func (s *Service) resolveVersion(ctx context.Context, hc *cluster.HTTPClient, raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" || strings.EqualFold(v, "latest") {
		if hc == nil {
			var err error
			hc, err = cluster.NewHTTPClient(ctx, s.Proxy, nil)
			if err != nil {
				return "", err
			}
		}
		latest, err := s.Releases.HashiCorp(ctx).LatestVersion(ctx, hc.Client, "nomad")
		if err != nil {
			return "", fmt.Errorf("获取 Nomad 最新版本失败：%w", err)
		}
		return latest, nil
	}
	if err := validVersion(v); err != nil {
		return "", err
	}
	return v, nil
}

// ---- Config generations ----

func (s *Service) caSigner(cl *nomadCluster) (*pki.CA, error) {
	key, err := s.Keys.DecryptString(cl.CAKeyEncrypted, db.ClusterCAKeyAAD(cl.ID))
	if err != nil {
		return nil, err
	}
	return pki.ParseCA(cl.CACertPEM, key)
}

func (s *Service) gossipKey(cl *nomadCluster) (string, error) {
	if cl.GossipKeyEncrypted == "" {
		return "", nil
	}
	return s.Keys.DecryptString(cl.GossipKeyEncrypted, db.ClusterGossipKeyAAD(cl.ID))
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// roleDNS lists the Nomad role names a node certificate carries; they are
// what verify_server_hostname checks.
func roleDNS(role, region string) []string {
	var out []string
	if IsServer(role) {
		out = append(out, "server."+region+".nomad")
	}
	if IsClient(role) {
		out = append(out, "client."+region+".nomad")
	}
	return out
}

// genInput is the cluster-wide context of a generation build.
type genInput struct {
	cl       *nomadCluster
	members  []*db.ClusterNode
	ca       *pki.CA
	caBundle string
	gossip   string
	// extra overrides the integration fragments of a member (nil = ask
	// the ExtraFiles hook).
	extra map[string]map[string]string
	// reuseLeaf keeps each member's current certificate and key (used to
	// spread a new trust bundle before any certificate changes issuer).
	reuseLeaf bool
}

func (s *Service) nodeConfig(gi *genInput, m *db.ClusterNode, gen int) NodeConfig {
	cl := gi.cl
	mc := memberConfig(m)
	var addrs []string
	for _, sv := range servers(gi.members) {
		addrs = append(addrs, sv.AdvertiseAddr)
	}
	return NodeConfig{Region: cl.Region, Datacenter: cl.Datacenter, NodeName: mc.NodeName, Role: m.Role, Advertise: m.AdvertiseAddr,
		HTTPPort: cl.Settings.HTTPPort, RPCPort: cl.Settings.RPCPort, SerfPort: cl.Settings.SerfPort, Generation: gen,
		Servers: addrs, BootstrapN: len(addrs), GossipKey: gi.gossip, TLS: cl.TLSEnabled, VerifyHTTPS: cl.Settings.VerifyHTTPSClient,
		UI: cl.Settings.UI, Telemetry: !cl.Settings.DisableTelemetry, JobGC: cl.Settings.JobGCThreshold, NodePool: mc.NodePool,
		Meta: mc.Meta, HostVolumes: mc.HostVolumes, Docker: mc.Docker, RawExec: mc.RawExec, Denylist: mc.Denylist, CNI: mc.CNI,
		CPUTotal: mc.CPUTotalCompute}
}

// buildGeneration renders a complete config generation for a node: the HCL
// fragments, integration fragments and (with TLS) a fresh node certificate
// and the CA bundle.
func (s *Service) buildGeneration(ctx context.Context, gi *genInput, m *db.ClusterNode, n *db.Node, gen int, current *pki.Material) ([]GenerationFile, *pki.Material, error) {
	nc := s.nodeConfig(gi, m, gen)
	if gi.extra != nil {
		nc.Extra = gi.extra[m.ID]
	} else if s.ExtraFiles != nil {
		extra, err := s.ExtraFiles(ctx, gi.cl.Cluster, m, gen)
		if err != nil {
			return nil, nil, err
		}
		nc.Extra = extra
	}
	files, err := RenderFiles(nc)
	if err != nil {
		return nil, nil, err
	}
	var leaf *pki.Material
	if gi.cl.TLSEnabled {
		now := time.Now()
		mc := memberConfig(m)
		names := cluster.NodeHosts(n, m.AdvertiseAddr, gi.cl.PublicAPIURL, append(roleDNS(m.Role, gi.cl.Region), mc.ExtraSANs...))
		cn := roleDNS(m.Role, gi.cl.Region)[0]
		if current != nil {
			leaf = current
		} else if leaf, err = gi.ca.Issue(pki.Request{CommonName: cn, Hosts: names}, now); err != nil {
			return nil, nil, err
		}
		if err := pki.Verify(leaf.CertPEM, leaf.KeyPEM, gi.caBundle, names, now, 24*time.Hour); err != nil {
			return nil, nil, fmt.Errorf("issued certificate failed verification: %w", err)
		}
		files = append(files,
			GenerationFile{Name: "tls/ca.pem", Content: []byte(gi.caBundle), Mode: "0640"},
			GenerationFile{Name: "tls/agent.pem", Content: []byte(leaf.CertPEM), Mode: "0640"},
			GenerationFile{Name: "tls/agent-key.pem", Content: []byte(leaf.KeyPEM), Mode: "0640"})
	}
	for i := range files {
		files[i].SHA256 = sum(files[i].Content)
	}
	return files, leaf, nil
}

// pushGeneration uploads a candidate generation, verifies it on the node
// (SHA-256 and nomad config validate) and atomically switches nomad.d.
func (s *Service) pushGeneration(ctx context.Context, nc *cluster.NodeCtx, role string, gen int, files []GenerationFile) error {
	dir := GenerationDir(gen)
	if _, err := nc.Run(ctx, "rm -rf -- "+sshx.Quote(dir)); err != nil {
		return err
	}
	owner := "root:" + RunUser(role)
	for _, f := range files {
		if err := sshx.PutFile(ctx, nc.SSH, dir+"/"+f.Name, f.Content, f.Mode, owner, "0750"); err != nil {
			return fmt.Errorf("upload %s: %w", f.Name, err)
		}
	}
	out, err := nc.Run(ctx, SwitchGenerationScript(gen, role, files))
	if err != nil {
		return fmt.Errorf("verify and switch generation %d: %w", gen, err)
	}
	nc.Step.Logf("配置代际 %d 通过 SHA256 复核与 nomad config validate 并已生效（%s）", gen, strings.TrimSpace(out))
	return nil
}

// applyGeneration renders, ships and activates the next config generation
// of a member and records it (with the certificate expiry).
func (s *Service) applyGeneration(ctx context.Context, nc *cluster.NodeCtx, gi *genInput, m *db.ClusterNode) error {
	mc := memberConfig(m)
	gen := mc.ConfigGeneration + 1
	var current *pki.Material
	if gi.reuseLeaf && gi.cl.TLSEnabled && mc.ConfigGeneration > 0 {
		dir := GenerationDir(mc.ConfigGeneration)
		cert, err := nc.Run(ctx, "cat "+sshx.Quote(dir+"/tls/agent.pem"))
		if err != nil {
			return fmt.Errorf("read current certificate: %w", err)
		}
		key, err := nc.Run(ctx, "cat "+sshx.Quote(dir+"/tls/agent-key.pem"))
		if err != nil {
			return fmt.Errorf("read current key: %w", err)
		}
		exp, err := pki.NotAfter(cert)
		if err != nil {
			return err
		}
		current = &pki.Material{CertPEM: cert, KeyPEM: key, NotAfter: exp}
	}
	files, leaf, err := s.buildGeneration(ctx, gi, m, nc.Node, gen, current)
	if err != nil {
		return err
	}
	if err := s.pushGeneration(ctx, nc, m.Role, gen, files); err != nil {
		return err
	}
	mc.ConfigGeneration = gen
	setMemberConfig(m, mc)
	if leaf != nil {
		m.CertExpiresAt = leaf.NotAfter
	}
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

func (s *Service) genInput(ctx context.Context, cl *nomadCluster, members []*db.ClusterNode) (*genInput, error) {
	gi := &genInput{cl: cl, members: members, caBundle: cl.CACertPEM}
	var err error
	if cl.TLSEnabled {
		if gi.ca, err = s.caSigner(cl); err != nil {
			return nil, err
		}
	}
	if gi.gossip, err = s.gossipKey(cl); err != nil {
		return nil, err
	}
	return gi, nil
}

// ---- Binaries ----

func (s *Service) installBinary(ctx context.Context, t *ops.Task, nc *cluster.NodeCtx, art *release.Artifact) error {
	rate := int64(db.IntSetting(ctx, s.DB.Reader, "release.transfer_rate_limit", 0))
	nc.Step.Logf("分发 Nomad %s 二进制（%d 字节，gzip 压缩传输）", art.Version, art.PayloadSize)
	if err := s.Hosts.InstallArtifact(ctx, nc.SSH, t.RemoteOpID, art, VersionBinary(art.Version), "0755", rate); err != nil {
		return err
	}
	out, err := nc.Run(ctx, ActivateBinaryScript(art.Version))
	if err != nil {
		return fmt.Errorf("activate binary: %w", err)
	}
	if strings.Contains(out, "+ent") {
		return conflict("enterprise_rejected", "检测到 Nomad Enterprise 版本，NomadDeck 只支持 Community 版")
	}
	nc.Step.Logf("已切换到 %s", strings.TrimSpace(out))
	return nil
}

func (s *Service) installCNI(ctx context.Context, t *ops.Task, nc *cluster.NodeCtx, art *release.Artifact) error {
	rate := int64(db.IntSetting(ctx, s.DB.Reader, "release.transfer_rate_limit", 0))
	staged := fmt.Sprintf("/opt/nomad-deck/.staging/%s/%s", t.RemoteOpID, art.PayloadName)
	nc.Step.Logf("分发 CNI 插件 %s（%d 字节）", art.Version, art.PayloadSize)
	if err := s.Hosts.InstallArtifact(ctx, nc.SSH, t.RemoteOpID, art, staged, "0600", rate); err != nil {
		return err
	}
	out, err := nc.Run(ctx, CNIInstallScript(sshx.Quote(staged)))
	if err != nil {
		return fmt.Errorf("install CNI plugins: %w", err)
	}
	nc.Step.Logf("CNI 插件已安装：%s", strings.TrimSpace(out))
	return nil
}

// artifacts are the verified downloads of a task, per architecture.
type artifacts struct {
	nomad map[string]*release.Artifact
	cni   map[string]*release.Artifact
	// docker holds the Docker packages for clients that get Docker
	// installed automatically, by member ID.
	docker map[string][]*release.Artifact
	// dockerVersion is the version those packages belong to.
	dockerVersion string
}

// autoDocker returns the cluster default Docker version when clients
// without Docker get it installed automatically ("" otherwise).
func autoDocker(cl *nomadCluster) string {
	var dc DockerConfig
	_ = json.Unmarshal(cl.Settings.DockerDefaults, &dc)
	if dc.AutoInstall {
		return dc.Version
	}
	return ""
}

// dockerLocksFor adds exclusive Docker host locks for clients that will
// get Docker installed automatically.
func (s *Service) dockerLocksFor(ctx context.Context, cl *nomadCluster, ms []*db.ClusterNode) []ops.LockReq {
	if autoDocker(cl) == "" {
		return nil
	}
	var out []ops.LockReq
	for _, m := range clients(ms) {
		if n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID); err == nil && (n.DockerMode == "absent" || n.DockerMode == "") {
			out = append(out, ops.LockReq{Key: ops.HostLock(m.NodeID, "docker"), Mode: ops.Exclusive})
		}
	}
	return out
}

func needsCNI(ms []*db.ClusterNode) bool {
	for _, m := range ms {
		if IsClient(m.Role) && memberConfig(m).CNI {
			return true
		}
	}
	return false
}

// fetchArtifacts downloads and verifies Nomad (and CNI when needed) for
// every architecture in use.
func (s *Service) fetchArtifacts(ctx context.Context, t *ops.Task, hc *cluster.HTTPClient, cl *nomadCluster, version string,
	members []*db.ClusterNode) (*artifacts, error) {
	stepTitle := "下载并校验 Nomad " + version
	if version == "" {
		stepTitle = "下载并校验 CNI 插件"
	}
	step, err := t.Step(stepTitle, "")
	if err != nil {
		return nil, err
	}
	if hc.UseProxy {
		step.Logf("经系统代理 %s 下载", hc.ProxyAddr)
	}
	a := &artifacts{nomad: map[string]*release.Artifact{}, cni: map[string]*release.Artifact{}, docker: map[string][]*release.Artifact{},
		dockerVersion: autoDocker(cl)}
	err = func() error {
		for _, m := range members {
			n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
			if err != nil {
				return err
			}
			if version != "" && a.nomad[n.Arch] == nil {
				art, err := s.Releases.HashiCorp(ctx).Fetch(ctx, hc.Client, "nomad", version, "linux", n.Arch, step.Log())
				if err != nil {
					return err
				}
				a.nomad[n.Arch] = art
			}
			if IsClient(m.Role) && memberConfig(m).CNI && a.cni[n.Arch] == nil {
				if cl.Settings.CNIVersion == "" {
					return conflict("no_cni_version", "节点启用了 CNI，但集群未选择 CNI 版本")
				}
				art, err := s.Releases.CNI(ctx).Fetch(ctx, hc.Client, cl.Settings.CNIVersion, n.Arch, step.Log())
				if err != nil {
					return err
				}
				a.cni[n.Arch] = art
			}
			if version != "" && IsClient(m.Role) && a.dockerVersion != "" && (n.DockerMode == "absent" || n.DockerMode == "") {
				if _, err := dockerTarget(n); err != nil {
					step.Logf("%s：%v，跳过自动安装 Docker", n.Name, err)
					continue
				}
				arts, err := s.fetchDocker(ctx, step, hc, n, a.dockerVersion)
				if err != nil {
					return err
				}
				a.docker[m.ID] = arts
			}
		}
		return nil
	}()
	step.Finish(err, nil)
	return a, err
}

// ---- Service helpers ----

func (s *Service) service(ctx context.Context, nc *cluster.NodeCtx, action string) error {
	script, err := ServiceScript(action)
	if err != nil {
		return err
	}
	nc.Step.Logf("systemctl %s nomad.service", action)
	return nc.Remote(ctx, "svc-"+action, script)
}

// waitAgent waits until a node's agent answers its health endpoint.
func (s *Service) waitAgent(ctx context.Context, cl *nomadCluster, m *db.ClusterNode) error {
	c, err := s.client(cl, m, "")
	if err != nil {
		return err
	}
	deadline := time.Now().Add(90 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		if _, err := c.Health(ctx); err == nil {
			return nil
		} else {
			last = err
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
	return fmt.Errorf("等待 %s 的 Nomad API 超时：%v", m.APIAddr, last)
}

func sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// waitLeader waits until a leader is elected among the servers.
func (s *Service) waitLeader(ctx context.Context, cl *nomadCluster, members []*db.ClusterNode, log func(string, ...any)) (*db.ClusterNode, error) {
	deadline := time.Now().Add(s.joinTimeout())
	var last error
	for time.Now().Before(deadline) {
		for _, m := range servers(members) {
			c, err := s.client(cl, m, "")
			if err != nil {
				last = err
				continue
			}
			leader, err := c.Leader(ctx)
			if err != nil {
				last = err
				continue
			}
			if leader != "" {
				log("Leader 已选出：%s", leader)
				return m, nil
			}
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("等待 Leader 选举超时：%v", last)
}

// waitClientReady waits until a client is registered and ready, and
// records its Nomad node ID.
func (s *Service) waitClientReady(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, log func(string, ...any)) error {
	name := memberConfig(m).NodeName
	deadline := time.Now().Add(s.joinTimeout())
	var last error
	for time.Now().Before(deadline) {
		api, _, err := s.apiClient(ctx, cl, "")
		if err == nil {
			var nodes []NodeStub
			if nodes, err = api.Nodes(ctx); err == nil {
				for _, n := range nodes {
					if n.Name == name && n.Status == "ready" {
						log("Client %s 已就绪（%s）", name, n.ID)
						mc := memberConfig(m)
						mc.ClientNodeID = n.ID
						setMemberConfig(m, mc)
						return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
					}
				}
				err = fmt.Errorf("client %s not ready yet", name)
			}
		}
		last = err
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
	return fmt.Errorf("等待 Client %s 就绪超时：%v", name, last)
}

// ---- Deploy ----

func memberLocks(clusterID string, members []*db.ClusterNode) []ops.LockReq {
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Exclusive}}
	for _, m := range members {
		locks = append(locks, ops.LockReq{Key: ops.HostLock(m.NodeID, "nomad"), Mode: ops.Exclusive})
	}
	return locks
}

// Deploy installs Nomad on every member, starts the servers, bootstraps
// ACLs with a pre-generated secret and starts the clients.
func (s *Service) Deploy(ctx context.Context, actor audit.Actor, clusterID string, in cluster.DeployInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitUninitialized {
		return nil, conflict("cluster_initialized", "集群已部署（%s），不能重新部署；新增节点请使用扩容（Join）", cl.InitState)
	}
	if cl.MaintenanceMode {
		return nil, conflict("maintenance", "集群处于维护模式（%s）", cl.MaintenanceReason)
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	rawVer := strings.TrimSpace(in.Version)
	isLatest := rawVer == "" || strings.EqualFold(rawVer, "latest")
	if !isLatest {
		if err := validVersion(rawVer); err != nil {
			return nil, err
		}
		in.Version = rawVer
	} else {
		in.Version = "latest"
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if len(servers(members)) == 0 {
		return nil, badRequest("集群没有 Server 节点")
	}
	issues, err := s.preflight(ctx, members)
	if err != nil {
		return nil, err
	}
	if err := cluster.Blocking(issues); err != nil {
		return nil, err
	}
	if in.UseProxy != nil {
		v := hc.UseProxy
		cl.Settings.UseProxy = &v
		_ = s.saveSettings(ctx, cl)
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.deploy", TargetType: "cluster", TargetID: cl.ID,
		Locks: append(memberLocks(cl.ID, members), s.dockerLocksFor(ctx, cl, members)...), TriggeredBy: actor.Name,
		Params: map[string]any{"version": in.Version, "use_proxy": hc.UseProxy, "proxy": hc.ProxyAddr},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runDeploy(ctx, t, cl.ID, in.Version, hc)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.deploy", ResourceType: "cluster", ResourceID: cl.ID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"version": in.Version, "use_proxy": hc.UseProxy,
			"nodes": len(members)}})
	return task, nil
}

func (s *Service) runDeploy(ctx context.Context, t *ops.Task, clusterID, version string, hc *cluster.HTTPClient) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if strings.EqualFold(strings.TrimSpace(version), "latest") || strings.TrimSpace(version) == "" {
		st, err := t.Step("解析目标版本", "")
		if err != nil {
			return err
		}
		resolved, rerr := s.resolveVersion(ctx, hc, "latest")
		if rerr != nil {
			st.Finish(rerr, nil)
			return rerr
		}
		version = resolved
		st.Logf("已解析 Nomad 目标版本：%s", version)
		st.Finish(nil, nil)
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "install", "version": version})
	arts, err := s.fetchArtifacts(ctx, t, hc, cl, version, members)
	if err != nil {
		return err
	}
	gi, err := s.genInput(ctx, cl, members)
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	errs := make([]error, len(members))
	for i, m := range members {
		wg.Add(1)
		go func(i int, m *db.ClusterNode) {
			defer wg.Done()
			errs[i] = s.installNode(ctx, t, gi, m, arts)
		}(i, m)
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	cl.Settings.Version = version
	if err := s.saveSettings(ctx, cl); err != nil {
		return err
	}
	if err := s.startAll(ctx, t, cl, servers(members), "启动 Server"); err != nil {
		return err
	}
	step, err := t.Step("等待 Leader 选举", "")
	if err != nil {
		return err
	}
	_, err = s.waitLeader(ctx, cl, members, step.Logf)
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	_ = t.Checkpoint(map[string]any{"phase": "bootstrap", "version": version})
	if err := s.bootstrapStep(ctx, t, cl.ID); err != nil {
		return err
	}
	return s.finishDeploy(ctx, t, cl.ID)
}

// installNode prepares a host, installs the binary (and CNI), creates host
// volume directories and activates the first config generation. The
// service is not started.
func (s *Service) installNode(ctx context.Context, t *ops.Task, gi *genInput, m *db.ClusterNode, arts *artifacts) (err error) {
	nc, err := s.remote().Open(ctx, t, m.NodeID, "安装 Nomad 到")
	if err != nil {
		return err
	}
	defer func() { nc.Done(ctx, err) }()
	art := arts.nomad[nc.Node.Arch]
	if art == nil {
		return fmt.Errorf("no artifact for %s", nc.Node.Arch)
	}
	nc.Step.Logf("准备主机目录与 systemd 单元（角色 %s，运行用户 %s）", m.Role, RunUser(m.Role))
	if err := nc.Remote(ctx, "prepare", PrepareScript(m.Role)); err != nil {
		return err
	}
	if err := s.installBinary(ctx, t, nc, art); err != nil {
		return err
	}
	mc := memberConfig(m)
	if IsClient(m.Role) && mc.CNI {
		if err := s.installCNI(ctx, t, nc, arts.cni[nc.Node.Arch]); err != nil {
			return err
		}
	}
	if arts := arts.docker[m.ID]; len(arts) > 0 {
		nc.Step.Logf("主机未安装 Docker，按集群默认配置自动安装 Docker %s", artsVersion(arts))
		d, err := s.loadDockerHost(ctx, m.NodeID)
		if err != nil {
			return err
		}
		if err := s.installDockerOn(ctx, t, nc, d, arts, artsVersion(arts)); err != nil {
			return fmt.Errorf("自动安装 Docker 失败：%w", err)
		}
	}
	if IsClient(m.Role) && len(mc.HostVolumes) > 0 {
		if _, err := nc.Run(ctx, HostVolumeScript(mc.HostVolumes)); err != nil {
			return fmt.Errorf("create host volume directories: %w", err)
		}
	}
	if err := s.applyGeneration(ctx, nc, gi, m); err != nil {
		return err
	}
	m.InstallState, m.InstalledVersion = "installed", art.Version
	m.KeptVersionsJSON = cluster.AddKept(m.KeptVersionsJSON, art.Version)
	return db.UpdateClusterNodeInstall(ctx, s.DB.Writer, m, s.DB.Now())
}

// startAll starts the service on members in parallel and waits for their
// agents to answer.
func (s *Service) startAll(ctx context.Context, t *ops.Task, cl *nomadCluster, ms []*db.ClusterNode, title string) error {
	var wg sync.WaitGroup
	errs := make([]error, len(ms))
	for i, m := range ms {
		wg.Add(1)
		go func(i int, m *db.ClusterNode) {
			defer wg.Done()
			errs[i] = func() (err error) {
				nc, err := s.remote().Open(ctx, t, m.NodeID, title)
				if err != nil {
					return err
				}
				defer func() { nc.Done(ctx, err) }()
				if err := s.service(ctx, nc, "start"); err != nil {
					return err
				}
				return s.waitAgent(ctx, cl, m)
			}()
		}(i, m)
	}
	wg.Wait()
	return errors.Join(errs...)
}

// finishDeploy starts the clients of an ACL-initialized cluster, waits for
// them to be ready and checks the default namespace.
func (s *Service) finishDeploy(ctx context.Context, t *ops.Task, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	var pure []*db.ClusterNode
	for _, m := range clients(members) {
		if !IsServer(m.Role) {
			pure = append(pure, m)
		}
	}
	if len(pure) > 0 {
		if err := s.startAll(ctx, t, cl, pure, "启动 Client"); err != nil {
			return err
		}
	}
	if cs := clients(members); len(cs) > 0 {
		step, err := t.Step("等待 Client 就绪", "")
		if err != nil {
			return err
		}
		var errs []error
		for _, m := range cs {
			errs = append(errs, s.waitClientReady(ctx, cl, m, step.Logf))
		}
		err = errors.Join(errs...)
		step.Finish(err, nil)
		if err != nil {
			return err
		}
	}
	if api, _, err := s.apiClient(ctx, cl, ""); err == nil {
		var ns map[string]any
		if err := api.Request(ctx, "GET", "namespace/default", nil, &ns); err != nil {
			return fmt.Errorf("default namespace check: %w", err)
		}
	}
	_, _ = s.StatusDetail(ctx, clusterID)
	return nil
}

// artsVersion returns the Docker Engine version of a package set.
func artsVersion(arts []*release.Artifact) string {
	for _, a := range arts {
		if a.Product == "docker-ce" {
			return reVersionIn.FindString(a.Version)
		}
	}
	return ""
}
