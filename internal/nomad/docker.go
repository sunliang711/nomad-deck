package nomad

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

// Docker Engine is a host-level component. A host is in one of three
// modes: managed (installed and configured by NomadDeck from the official
// repository), external (installed by someone else; only its image pull
// proxy may be managed) or absent.

// Docker host layout.
const (
	DockerDaemonJSON  = "/etc/docker/daemon.json"
	DockerMarker      = "/etc/docker/daemon.json.managed-by-nomad-deck"
	DockerProxyDropIn = "/etc/systemd/system/docker.service.d/nomad-deck-proxy.conf"
	DockerOpLock      = "/opt/nomad-deck/docker/.op.lock"
	DockerKeyFile     = "/opt/nomad-deck/docker/docker-rpm.asc"
	DefaultTestImage  = "busybox:1.36"
)

// PullProxy is the proxy the Docker daemon uses to pull images.
type PullProxy struct {
	// Mode is none, system (reuse the system proxy) or custom.
	Mode     string   `json:"mode"`
	URL      string   `json:"url,omitempty"` // custom: http(s)://host:port
	Username string   `json:"username,omitempty"`
	NoProxy  []string `json:"no_proxy,omitempty"`
	// PasswordEncrypted holds the custom proxy password (master key).
	PasswordEncrypted string `json:"password_encrypted,omitempty"`
}

// DockerConfig is a Docker Engine configuration: the cluster defaults
// (clusters.config_json.docker_defaults) or a host's overrides
// (nodes.docker_config_json). Zero fields inherit.
type DockerConfig struct {
	Version         string     `json:"version,omitempty"`
	AutoInstall     bool       `json:"auto_install,omitempty"`
	RegistryMirrors []string   `json:"registry_mirrors,omitempty"`
	DataRoot        string     `json:"data_root,omitempty"`
	LogMaxSize      string     `json:"log_max_size,omitempty"`
	LogMaxFile      int        `json:"log_max_file,omitempty"`
	PullProxy       *PullProxy `json:"pull_proxy,omitempty"`
}

func init() {
	db.EncryptedFields = append(db.EncryptedFields,
		db.EncryptedField{Name: "nodes.docker_config_json.pull_proxy.password_encrypted",
			Query: `SELECT id, json_extract(docker_config_json, '$.pull_proxy.password_encrypted') FROM nodes
				WHERE COALESCE(json_extract(docker_config_json, '$.pull_proxy.password_encrypted'), '') != ''`},
		db.EncryptedField{Name: "clusters.config_json.docker_defaults.pull_proxy.password_encrypted",
			Query: `SELECT id, json_extract(config_json, '$.docker_defaults.pull_proxy.password_encrypted') FROM clusters
				WHERE COALESCE(json_extract(config_json, '$.docker_defaults.pull_proxy.password_encrypted'), '') != ''`},
	)
}

func nodeProxyAAD(nodeID string) string { return "nodes.docker_config_json.pull_proxy:" + nodeID }
func clusterProxyAAD(clusterID string) string {
	return "clusters.config_json.docker_defaults.pull_proxy:" + clusterID
}

var (
	reLogSize  = regexp.MustCompile(`^[1-9][0-9]{0,5}[kmg]$`)
	reDockerID = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
	reNoProxy  = regexp.MustCompile(`^[A-Za-z0-9.*:/\[\]-]{1,253}$`)
)

func validDockerVersion(v string) error {
	if err := sshx.ValidVersion(v); err != nil || strings.ContainsAny(v, "+-") {
		return badRequest("Docker 版本号 %q 无效", v)
	}
	return nil
}

// validate checks a configuration (custom proxy password excluded).
func (c *DockerConfig) validate() error {
	if c.Version != "" {
		if err := validDockerVersion(c.Version); err != nil {
			return err
		}
	}
	for _, m := range c.RegistryMirrors {
		u, err := url.Parse(m)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return badRequest("镜像加速地址 %q 不合法", m)
		}
	}
	if c.DataRoot != "" && (!reHostPath.MatchString(c.DataRoot) || strings.Contains(c.DataRoot, "..")) {
		return badRequest("data-root 路径不合法")
	}
	if c.LogMaxSize != "" && !reLogSize.MatchString(c.LogMaxSize) {
		return badRequest("日志 max-size 格式不正确（如 50m）")
	}
	if c.LogMaxFile < 0 || c.LogMaxFile > 100 {
		return badRequest("日志 max-file 需在 1～100 之间")
	}
	if p := c.PullProxy; p != nil {
		switch p.Mode {
		case "none", "system":
		case "custom":
			u, err := url.Parse(p.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" && u.Path != "/" {
				return badRequest("镜像拉取代理地址需为 http(s)://主机:端口，认证信息单独填写")
			}
		default:
			return badRequest("镜像拉取代理模式需为 none、system 或 custom")
		}
		for _, h := range p.NoProxy {
			if !reNoProxy.MatchString(h) {
				return badRequest("no-proxy 条目 %q 不合法", h)
			}
		}
	}
	return nil
}

// merge overlays a host's overrides on the cluster defaults.
func mergeDocker(defaults, host DockerConfig) DockerConfig {
	out := defaults
	if host.Version != "" {
		out.Version = host.Version
	}
	if len(host.RegistryMirrors) > 0 {
		out.RegistryMirrors = host.RegistryMirrors
	}
	if host.DataRoot != "" {
		out.DataRoot = host.DataRoot
	}
	if host.LogMaxSize != "" {
		out.LogMaxSize = host.LogMaxSize
	}
	if host.LogMaxFile != 0 {
		out.LogMaxFile = host.LogMaxFile
	}
	if host.PullProxy != nil {
		out.PullProxy = host.PullProxy
	}
	return out
}

// dockerHost bundles a host with its Docker context.
type dockerHost struct {
	node      *db.Node
	clusterID string // Nomad cluster of the host ("" if none)
	cl        *nomadCluster
	member    *db.ClusterNode
	host      DockerConfig // host overrides
	defaults  DockerConfig
	// proxyOwner says whose password the effective pull proxy uses.
	proxyAAD string
}

func (d *dockerHost) effective() DockerConfig {
	eff := mergeDocker(d.defaults, d.host)
	if eff.LogMaxSize == "" {
		eff.LogMaxSize = "50m"
	}
	if eff.LogMaxFile == 0 {
		eff.LogMaxFile = 3
	}
	return eff
}

func (s *Service) loadDockerHost(ctx context.Context, nodeID string) (*dockerHost, error) {
	n, err := db.GetNode(ctx, s.DB.Reader, nodeID)
	if errors.Is(err, db.ErrNotFound) {
		return nil, badRequest("主机不存在")
	}
	if err != nil {
		return nil, err
	}
	d := &dockerHost{node: n, proxyAAD: nodeProxyAAD(n.ID)}
	_ = json.Unmarshal([]byte(n.DockerConfigJSON), &d.host)
	if d.clusterID, err = db.NomadClusterOfNode(ctx, s.DB.Reader, nodeID); err != nil {
		return nil, err
	}
	if d.clusterID != "" {
		if d.cl, err = s.loadCluster(ctx, s.DB.Reader, d.clusterID); err != nil {
			return nil, err
		}
		if len(d.cl.Settings.DockerDefaults) > 0 {
			_ = json.Unmarshal(d.cl.Settings.DockerDefaults, &d.defaults)
		}
		d.member, _ = db.GetClusterNode(ctx, s.DB.Reader, d.clusterID, nodeID)
		if d.host.PullProxy == nil && d.defaults.PullProxy != nil {
			d.proxyAAD = clusterProxyAAD(d.clusterID)
		}
	}
	return d, nil
}

func dockerTarget(n *db.Node) (release.DockerTarget, error) {
	var probe struct {
		Raw map[string]string `json:"raw"`
	}
	_ = json.Unmarshal([]byte(n.ProbeJSON), &probe)
	if len(probe.Raw) == 0 {
		return release.DockerTarget{}, conflict("node_not_probed", "主机尚未完成连通性测试，无法确定 Docker 仓库")
	}
	t, err := release.DockerTargetFromProbe(probe.Raw, n.Arch)
	if err != nil {
		return t, conflict("docker_unsupported", "%v", err)
	}
	if t.Format == "rpm" && n.PackageManager != "dnf" {
		return t, conflict("docker_unsupported", "托管 Docker 需要 dnf，主机的包管理器为 %s", n.PackageManager)
	}
	return t, nil
}

// pullProxyURL resolves the effective pull proxy to a URL with credentials
// ("" for none).
func (s *Service) pullProxyURL(ctx context.Context, d *dockerHost, p *PullProxy) (string, []string, error) {
	if p == nil || p.Mode == "" || p.Mode == "none" {
		return "", nil, nil
	}
	if p.Mode == "system" {
		cfg, pass, err := s.Proxy.Load(ctx)
		if err != nil {
			return "", nil, err
		}
		if cfg == nil || cfg.Host == "" {
			return "", nil, badRequest("镜像拉取代理选择了沿用系统代理，但尚未配置系统代理")
		}
		if cfg.Type == "socks5" {
			return "", nil, badRequest("系统代理为 SOCKS5，Docker 镜像拉取代理需要 HTTP(S) 代理")
		}
		return cfg.URL(pass).String(), p.NoProxy, nil
	}
	u, err := url.Parse(p.URL)
	if err != nil {
		return "", nil, err
	}
	if p.Username != "" {
		pass := ""
		if p.PasswordEncrypted != "" {
			if pass, err = s.Keys.DecryptString(p.PasswordEncrypted, d.proxyAAD); err != nil {
				return "", nil, err
			}
		}
		u.User = url.UserPassword(p.Username, pass)
	}
	return strings.TrimRight(u.String(), "/"), p.NoProxy, nil
}

// noProxyList is the no-proxy list: loopback, the Nomad cluster members
// and the configured entries.
func (s *Service) noProxyList(ctx context.Context, d *dockerHost, extra []string) []string {
	set := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}
	if d.clusterID != "" {
		ms, _ := db.ListClusterNodes(ctx, s.DB.Reader, d.clusterID)
		for _, m := range ms {
			set[m.AdvertiseAddr] = true
		}
	}
	for _, e := range extra {
		set[e] = true
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// RenderDaemonJSON renders the managed daemon.json.
func RenderDaemonJSON(c DockerConfig, proxyURL string, noProxy []string, includeDataRoot bool) ([]byte, error) {
	m := map[string]any{
		"live-restore": true,
		"log-driver":   "json-file",
		"log-opts":     map[string]string{"max-size": c.LogMaxSize, "max-file": strconv.Itoa(c.LogMaxFile)},
	}
	if len(c.RegistryMirrors) > 0 {
		m["registry-mirrors"] = c.RegistryMirrors
	}
	if includeDataRoot && c.DataRoot != "" {
		m["data-root"] = c.DataRoot
	}
	if proxyURL != "" {
		m["proxies"] = map[string]string{"http-proxy": proxyURL, "https-proxy": proxyURL, "no-proxy": strings.Join(noProxy, ",")}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// RenderProxyDropIn renders the systemd drop-in carrying the pull proxy of
// an external Docker installation.
func RenderProxyDropIn(proxyURL string, noProxy []string) string {
	q := func(k, v string) string { return strconv.Quote(k + "=" + v) }
	return fmt.Sprintf("%s\n[Service]\nEnvironment=%s %s %s\n", ManagedMark, q("HTTP_PROXY", proxyURL), q("HTTPS_PROXY", proxyURL),
		q("NO_PROXY", strings.Join(noProxy, ",")))
}

// ---- Scripts ----

func pkgNames() string { return strings.Join(release.DockerPackages, " ") }

// dockerPrecheckScript checks that installing the staged packages only
// needs dependencies available from the host's configured repositories.
func dockerPrecheckScript(format, dir string) string {
	if format == "deb" {
		return fmt.Sprintf(`set -e
cd %s
DEBIAN_FRONTEND=noninteractive apt-get install --simulate -y --allow-change-held-packages ./*.deb >/tmp/nd-docker-sim.log 2>&1 || { cat /tmp/nd-docker-sim.log; echo "依赖预检失败：上面列出的系统依赖无法从已配置的软件源获得"; exit 1; }
grep -E '^Inst ' /tmp/nd-docker-sim.log | awk '{print $2}' | tr '\n' ' '
rm -f /tmp/nd-docker-sim.log
`, sshx.Quote(dir))
	}
	return fmt.Sprintf(`cd %s || exit 1
out=$(dnf install --assumeno ./*.rpm 2>&1)
echo "$out" | tail -n 40
if echo "$out" | grep -Eq 'nothing provides|Problem:|conflicting requests|^Error:'; then
  echo "依赖预检失败：上面列出的系统依赖无法从已配置的软件源获得"; exit 1
fi
`, sshx.Quote(dir))
}

// dockerInstallScript installs (or upgrades/downgrades) the staged packages
// and pins their versions against routine system upgrades.
func dockerInstallScript(format, dir string, downgrade bool) string {
	if format == "deb" {
		return fmt.Sprintf(`set -e
cd %[1]s
apt-mark unhold %[2]s >/dev/null 2>&1 || true
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades -o Dpkg::Options::=--force-confold ./*.deb
apt-mark hold %[2]s >/dev/null
echo "已安装并锁定版本：$(dpkg-query -W -f='${Package}=${Version} ' %[2]s)"
`, sshx.Quote(dir), pkgNames())
	}
	verb := "install"
	if downgrade {
		verb = "downgrade"
	}
	return fmt.Sprintf(`set -e
cd %[1]s
rpm --import %[3]s
for f in ./*.rpm; do
  rpm -K "$f" | grep -q 'signatures OK' || { echo "RPM 签名校验失败：$f"; rpm -K "$f"; exit 1; }
done
echo "全部 RPM 安装包的 Docker GPG 签名校验通过"
if dnf versionlock list >/dev/null 2>&1; then dnf versionlock delete %[2]s >/dev/null 2>&1 || true; fi
dnf %[4]s -y --disableexcludes=main ./*.rpm
if dnf versionlock list >/dev/null 2>&1; then
  dnf versionlock add %[2]s >/dev/null
else
  grep -q '^excludepkgs=.*docker-ce' /etc/dnf/dnf.conf || sed -i '/^\[main\]/a excludepkgs=%[5]s' /etc/dnf/dnf.conf
fi
echo "已安装并锁定版本：$(rpm -q %[2]s | tr '\n' ' ')"
`, sshx.Quote(dir), pkgNames(), DockerKeyFile, verb, strings.Join(release.DockerPackages, ","))
}

// dockerWriteConfigScript validates a staged daemon.json, swaps it in
// atomically, restarts Docker and verifies it; on failure the previous
// file is restored and Docker restarted again.
func dockerWriteConfigScript(staged string, start bool) string {
	return fmt.Sprintf(`set -e
dockerd --validate --config-file %[1]s
[ -f %[2]s ] && cp -p %[2]s %[2]s.nd-prev || rm -f %[2]s.nd-prev
mv -f %[1]s %[2]s
printf '%%s\n' %[4]s > %[3]s
if ! { systemctl enable containerd docker >/dev/null 2>&1; systemctl restart docker && timeout 60 docker info >/dev/null 2>&1; }; then
  echo "新配置下 Docker 未能就绪，恢复原配置"
  if [ -f %[2]s.nd-prev ]; then mv -f %[2]s.nd-prev %[2]s; else rm -f %[2]s; fi
  systemctl restart docker || true
  exit 1
fi
rm -f %[2]s.nd-prev
docker version --format '{{.Server.Version}}'
`, staged, DockerDaemonJSON, DockerMarker, sshx.Quote(ManagedMark+" (daemon.json)"))
}

const dockerUninstallExternalScript = `set -e
running=$(docker ps -q 2>/dev/null | wc -l)
if [ "$running" -gt 0 ]; then echo "主机上有 $running 个运行中的容器，拒绝转为托管"; exit 1; fi
if command -v apt-get >/dev/null 2>&1; then
  for p in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg -s "$p" >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get remove -y "$p"; fi
  done
else
  dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman-docker moby-engine || true
fi
rm -f ` + DockerProxyDropIn + `
systemctl daemon-reload
echo "原有 Docker 安装包已卸载（镜像与数据目录保留）"
`

var reVersionIn = regexp.MustCompile(`([0-9]+\.[0-9]+\.[0-9]+)`)

// ---- Views ----

// DockerView is the Docker state of a host.
type DockerView struct {
	NodeID      string            `json:"node_id"`
	Mode        string            `json:"mode"`
	Status      string            `json:"status"`
	Version     string            `json:"version"`
	ClusterID   string            `json:"cluster_id,omitempty"`
	Repository  string            `json:"repository,omitempty"`
	Unsupported string            `json:"unsupported_reason,omitempty"`
	HostConfig  DockerConfigView  `json:"host_config"`
	Effective   DockerConfigView  `json:"effective"`
	Defaults    *DockerConfigView `json:"cluster_defaults,omitempty"`
}

// DockerConfigView is a configuration without the encrypted password.
type DockerConfigView struct {
	DockerConfig
	PasswordSet bool `json:"pull_proxy_password_set"`
}

func viewOf(c DockerConfig) DockerConfigView {
	v := DockerConfigView{DockerConfig: c}
	if c.PullProxy != nil {
		p := *c.PullProxy
		v.PasswordSet = p.PasswordEncrypted != ""
		p.PasswordEncrypted = ""
		v.PullProxy = &p
	}
	return v
}

// GetDocker returns a host's Docker mode, version and configuration.
func (s *Service) GetDocker(ctx context.Context, nodeID string) (*DockerView, error) {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	v := &DockerView{NodeID: d.node.ID, Mode: d.node.DockerMode, Status: d.node.DockerStatus, Version: d.node.DockerVersion,
		ClusterID: d.clusterID, HostConfig: viewOf(d.host), Effective: viewOf(d.effective())}
	if d.clusterID != "" {
		dv := viewOf(d.defaults)
		v.Defaults = &dv
	}
	if t, err := dockerTarget(d.node); err == nil {
		v.Repository = t.String()
	} else {
		v.Unsupported = err.Error()
	}
	return v, nil
}

// ---- Tasks ----

// DockerInstallInput installs, adopts or upgrades Docker on a host.
type DockerInstallInput struct {
	Version  string `json:"version"`
	UseProxy *bool  `json:"use_proxy"`
	// Confirm accepts a major version change.
	Confirm bool `json:"confirm"`
	// Drain forces a drain even when an in-place upgrade is allowed.
	Drain bool `json:"drain"`
	// AllowInterruption accepts container interruption for upgrades that
	// cannot run in place on hosts that cannot be drained.
	AllowInterruption bool `json:"allow_interruption"`
}

func (s *Service) dockerLocks(d *dockerHost) []ops.LockReq {
	locks := []ops.LockReq{{Key: ops.HostLock(d.node.ID, "docker"), Mode: ops.Exclusive}}
	if d.clusterID != "" {
		locks = append(locks, ops.LockReq{Key: ops.ClusterLock(d.clusterID), Mode: ops.Shared})
	}
	return locks
}

func (s *Service) dockerRemote() *cluster.Remote {
	return &cluster.Remote{DB: s.DB, Hosts: s.Hosts, Product: "docker", OpLock: DockerOpLock}
}

// fetchDocker downloads and verifies the package set of a version for a host.
func (s *Service) fetchDocker(ctx context.Context, step *ops.Step, hc *cluster.HTTPClient, n *db.Node, version string) ([]*release.Artifact, error) {
	t, err := dockerTarget(n)
	if err != nil {
		return nil, err
	}
	if hc.UseProxy {
		step.Logf("经系统代理 %s 下载", hc.ProxyAddr)
	}
	step.Logf("Docker 仓库 %s，目标版本 %s", t, version)
	return s.Releases.Docker(ctx).Fetch(ctx, hc.Client, t, version, step.Log())
}

// stageDocker relays verified packages to the host's staging directory
// (SHA-256 re-checked on the host) and returns the directory.
func (s *Service) stageDocker(ctx context.Context, t *ops.Task, nc *cluster.NodeCtx, arts []*release.Artifact, sub string) (string, error) {
	rate := int64(db.IntSetting(ctx, s.DB.Reader, "release.transfer_rate_limit", 0))
	dir := fmt.Sprintf("/opt/nomad-deck/.staging/%s/docker-%s", t.RemoteOpID, sub)
	for _, a := range arts {
		nc.Step.Logf("分发 %s（%d 字节）", a.PayloadName, a.PayloadSize)
		// Package file names carry "~" and ":"; stage them as <package>.<ext>.
		dest := dir + "/" + a.Product + filepathExt(a.PayloadName)
		if err := s.Hosts.InstallArtifact(ctx, nc.SSH, t.RemoteOpID, a, dest, "0644", rate); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func filepathExt(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		return name[i:]
	}
	return ""
}

// installDockerPackages runs the dependency precheck and installs the
// staged packages.
func (s *Service) installDockerPackages(ctx context.Context, nc *cluster.NodeCtx, format, dir string, downgrade bool) error {
	if format == "rpm" {
		kr, err := s.Releases.Docker(ctx).ArmoredRPMKey()
		if err != nil {
			return err
		}
		if err := sshx.PutFile(ctx, nc.SSH, DockerKeyFile, []byte(kr), "0644", "root:root", "0755"); err != nil {
			return err
		}
	}
	if !downgrade {
		nc.Step.Logf("依赖预检")
		if err := nc.Remote(ctx, "docker-precheck", dockerPrecheckScript(format, dir)); err != nil {
			return err
		}
	}
	if err := nc.Remote(ctx, "docker-install", dockerInstallScript(format, dir, downgrade)); err != nil {
		return err
	}
	_, _ = nc.Run(ctx, "rm -rf -- "+sshx.Quote(dir))
	return nil
}

// writeDaemonConfig renders, validates and activates daemon.json (managed
// mode) or the proxy drop-in (external mode), restarting Docker.
func (s *Service) writeDaemonConfig(ctx context.Context, nc *cluster.NodeCtx, d *dockerHost, mode string, firstInstall bool) (string, error) {
	eff := d.effective()
	proxyURL, extra, err := s.pullProxyURL(ctx, d, eff.PullProxy)
	if err != nil {
		return "", err
	}
	noProxy := s.noProxyList(ctx, d, extra)
	if mode == "external" {
		if proxyURL == "" {
			_, err := nc.Run(ctx, "rm -f "+DockerProxyDropIn+" && systemctl daemon-reload && systemctl restart docker && docker info >/dev/null")
			return "", err
		}
		if err := sshx.PutFile(ctx, nc.SSH, DockerProxyDropIn, []byte(RenderProxyDropIn(proxyURL, noProxy)), "0600", "root:root", "0755"); err != nil {
			return "", err
		}
		out, err := nc.Run(ctx, "systemctl daemon-reload && systemctl restart docker && timeout 60 docker info >/dev/null && docker version --format '{{.Server.Version}}'")
		nc.Step.Logf("镜像拉取代理已写入 docker.service drop-in")
		return strings.TrimSpace(out), err
	}
	body, err := RenderDaemonJSON(eff, proxyURL, noProxy, firstInstall)
	if err != nil {
		return "", err
	}
	if !firstInstall {
		// data-root may only be set at first install: keep whatever is active.
		if cur, err := nc.Run(ctx, "cat "+DockerDaemonJSON+" 2>/dev/null || true"); err == nil {
			var m map[string]any
			if json.Unmarshal([]byte(cur), &m) == nil {
				if dr, ok := m["data-root"].(string); ok && dr != "" {
					var nm map[string]any
					_ = json.Unmarshal(body, &nm)
					nm["data-root"] = dr
					body, _ = json.MarshalIndent(nm, "", "  ")
					body = append(body, '\n')
				}
			}
		}
	}
	mode0 := "0644"
	if proxyURL != "" && strings.Contains(proxyURL, "@") {
		mode0 = "0600"
	}
	staged := DockerDaemonJSON + ".nd-new"
	if err := sshx.PutFile(ctx, nc.SSH, staged, body, mode0, "root:root", "0755"); err != nil {
		return "", err
	}
	out, err := nc.Run(ctx, dockerWriteConfigScript(staged, firstInstall))
	if err != nil {
		return "", fmt.Errorf("daemon.json 校验或生效失败：%w", err)
	}
	nc.Step.Logf("托管的 daemon.json 已校验并生效（live-restore、日志轮转%s）", map[bool]string{true: "、镜像拉取代理", false: ""}[proxyURL != ""])
	return strings.TrimSpace(out), nil
}

// waitDockerDriver waits until the Nomad client on the host reports a
// healthy Docker driver (no-op for hosts that are not Nomad clients).
func (s *Service) waitDockerDriver(ctx context.Context, d *dockerHost, log func(string, ...any)) error {
	if d.member == nil || !IsClient(d.member.Role) || d.cl == nil || d.cl.InitState != db.InitInitialized {
		return nil
	}
	id := memberConfig(d.member).ClientNodeID
	if id == "" {
		return nil
	}
	deadline := time.Now().Add(3 * time.Minute)
	var last error
	for time.Now().Before(deadline) {
		api, _, err := s.apiClient(ctx, d.cl, "")
		if err == nil {
			var n *NodeDetail
			if n, err = api.Node(ctx, id); err == nil {
				if dr, ok := n.Drivers["docker"]; ok && dr.Detected && dr.Healthy {
					log("Nomad Docker 驱动健康")
					return nil
				}
				err = errors.New("Docker 驱动尚未健康")
			}
		}
		last = err
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
	return fmt.Errorf("Nomad Docker 驱动未恢复健康：%v", last)
}

func (s *Service) recordDocker(ctx context.Context, d *dockerHost, mode, version string) error {
	b, _ := json.Marshal(d.host)
	d.node.DockerMode, d.node.DockerStatus, d.node.DockerVersion = mode, "running", version
	return db.UpdateNodeDocker(ctx, s.DB.Writer, d.node.ID, mode, "running", version, string(b), s.DB.Now())
}

// installDockerOn performs a fresh managed install on an open host session.
func (s *Service) installDockerOn(ctx context.Context, t *ops.Task, nc *cluster.NodeCtx, d *dockerHost, arts []*release.Artifact, version string) error {
	target, err := dockerTarget(d.node)
	if err != nil {
		return err
	}
	dir, err := s.stageDocker(ctx, t, nc, arts, version)
	if err != nil {
		return err
	}
	if err := s.installDockerPackages(ctx, nc, target.Format, dir, false); err != nil {
		return err
	}
	got, err := s.writeDaemonConfig(ctx, nc, d, "managed", true)
	if err != nil {
		return err
	}
	if got != version {
		return fmt.Errorf("docker 报告的版本 %q 与期望的 %s 不一致", got, version)
	}
	if err := s.recordDocker(ctx, d, "managed", version); err != nil {
		return err
	}
	return s.waitDockerDriver(ctx, d, nc.Step.Logf)
}

// InstallDocker installs Docker on a host (absent mode), or converts an
// external installation to managed (adopt=true; refused while containers run).
func (s *Service) InstallDocker(ctx context.Context, actor audit.Actor, nodeID string, in DockerInstallInput, adopt bool) (*db.OperationTask, error) {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	switch {
	case adopt && d.node.DockerMode != "external":
		return nil, conflict("not_external", "只有 external 模式的主机可以转为托管（当前 %s）", d.node.DockerMode)
	case !adopt && d.node.DockerMode != "absent":
		return nil, conflict("docker_present", "主机已安装 Docker（%s 模式）", d.node.DockerMode)
	}
	if in.Version == "" {
		in.Version = d.effective().Version
	}
	if err := validDockerVersion(in.Version); err != nil {
		return nil, err
	}
	if _, err := dockerTarget(d.node); err != nil {
		return nil, err
	}
	if issues := cluster.HostIssues(d.node); cluster.Blocking(issues) != nil {
		return nil, cluster.Blocking(issues)
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	action := "docker.install"
	if adopt {
		action = "docker.adopt"
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: action, TargetType: "node", TargetID: nodeID, Locks: s.dockerLocks(d),
		TriggeredBy: actor.Name, Params: map[string]any{"version": in.Version, "use_proxy": hc.UseProxy},
		Run: func(ctx context.Context, t *ops.Task) error {
			step, err := t.Step("下载并校验 Docker "+in.Version, "")
			if err != nil {
				return err
			}
			arts, err := s.fetchDocker(ctx, step, hc, d.node, in.Version)
			step.Finish(err, nil)
			if err != nil {
				return err
			}
			nc, err := s.dockerRemote().Open(ctx, t, nodeID, "安装 Docker 到")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if adopt {
				if err = nc.Remote(ctx, "docker-uninstall-external", dockerUninstallExternalScript); err != nil {
					return err
				}
			}
			err = s.installDockerOn(ctx, t, nc, d, arts, in.Version)
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: action, ResourceType: "node", ResourceID: nodeID,
		ResourceName: d.node.Name, OperationTaskID: task.ID, Summary: map[string]any{"version": in.Version, "use_proxy": hc.UseProxy}})
	return task, nil
}

// DockerUpgradeKind classifies an upgrade.
type DockerUpgradeKind struct {
	InPlace bool   `json:"in_place"`
	Reason  string `json:"reason"`
}

// classifyDockerUpgrade decides whether an upgrade may run in place: the
// target must be the next patch of the current minor and containerd.io
// must only move within its minor (Docker only guarantees live-restore
// across such patch upgrades). Everything else needs a drain.
func classifyDockerUpgrade(cur, target, curContainerd, targetContainerd string) DockerUpgradeKind {
	cm, cn, cp, err1 := splitVer(cur)
	tm, tn, tp, err2 := splitVer(target)
	if err1 != nil || err2 != nil {
		return DockerUpgradeKind{Reason: "无法解析版本号"}
	}
	if cm != tm || cn != tn {
		return DockerUpgradeKind{Reason: "跨小版本或主版本升级，Docker 不保证 live-restore 接管运行中的容器"}
	}
	if tp != cp+1 {
		return DockerUpgradeKind{Reason: fmt.Sprintf("跳过了补丁版本（%s → %s）", cur, target)}
	}
	if curContainerd != "" && targetContainerd != "" {
		am, an, ap, e1 := splitVer(curContainerd)
		bm, bn, bp, e2 := splitVer(targetContainerd)
		if e1 != nil || e2 != nil || am != bm || an != bn || bp < ap {
			return DockerUpgradeKind{Reason: fmt.Sprintf("containerd.io 不是补丁升级（%s → %s）", curContainerd, targetContainerd)}
		}
	}
	return DockerUpgradeKind{InPlace: true, Reason: "下一个补丁版本，live-restore 可保持容器运行"}
}

func splitVer(v string) (int, int, int, error) {
	m := reVersionIn.FindString(v)
	if m == "" {
		return 0, 0, 0, fmt.Errorf("bad version %q", v)
	}
	p := strings.Split(m, ".")
	a, _ := strconv.Atoi(p[0])
	b, _ := strconv.Atoi(p[1])
	c, _ := strconv.Atoi(p[2])
	return a, b, c, nil
}

// UpgradeDocker upgrades a managed Docker installation on one host.
func (s *Service) UpgradeDocker(ctx context.Context, actor audit.Actor, nodeID string, in DockerInstallInput) (*db.OperationTask, error) {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if err := s.checkDockerUpgrade(d, in); err != nil {
		return nil, err
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "docker.upgrade", TargetType: "node", TargetID: nodeID, Locks: s.dockerLocks(d),
		TriggeredBy: actor.Name, Params: map[string]any{"from": d.node.DockerVersion, "to": in.Version, "use_proxy": hc.UseProxy,
			"drain": in.Drain, "allow_interruption": in.AllowInterruption},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.upgradeDockerHost(ctx, t, nodeID, in, hc)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.upgrade", ResourceType: "node", ResourceID: nodeID,
		ResourceName: d.node.Name, OperationTaskID: task.ID, Summary: map[string]any{"from": d.node.DockerVersion, "to": in.Version}})
	return task, nil
}

func (s *Service) checkDockerUpgrade(d *dockerHost, in DockerInstallInput) error {
	if d.node.DockerMode != "managed" {
		return conflict("not_managed", "%s 的 Docker 不是托管模式（%s），不能由 NomadDeck 升级", d.node.Name, d.node.DockerMode)
	}
	if err := validDockerVersion(in.Version); err != nil {
		return err
	}
	if release.CompareVersions(in.Version, d.node.DockerVersion) <= 0 {
		return badRequest("%s 的 Docker 版本只允许前进（当前 %s）", d.node.Name, d.node.DockerVersion)
	}
	cm, _, _, _ := splitVer(d.node.DockerVersion)
	tm, _, _, _ := splitVer(in.Version)
	if cm != tm && !in.Confirm {
		return conflict("confirmation_required", "Docker 跨主版本升级（%s → %s）需显式确认", d.node.DockerVersion, in.Version)
	}
	return nil
}

func (s *Service) runningContainers(ctx context.Context, nc *cluster.NodeCtx) ([]string, error) {
	out, err := nc.Run(ctx, "docker ps -q --no-trunc")
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, f := range strings.Fields(out) {
		if reDockerID.MatchString(f) {
			ids = append(ids, f)
		}
	}
	return ids, nil
}

func (s *Service) containerdVersion(ctx context.Context, nc *cluster.NodeCtx) string {
	out, _ := nc.Run(ctx, "containerd --version 2>/dev/null || true")
	return reVersionIn.FindString(out)
}

func containerdOf(arts []*release.Artifact) string {
	for _, a := range arts {
		if a.Product == "containerd.io" {
			return reVersionIn.FindString(a.Version)
		}
	}
	return ""
}

// clientAllocs lists the running allocation IDs of a Nomad client.
func (s *Service) clientAllocs(ctx context.Context, d *dockerHost) ([]string, error) {
	if d.member == nil || d.cl == nil || !IsClient(d.member.Role) {
		return nil, nil
	}
	id := memberConfig(d.member).ClientNodeID
	api, _, err := s.apiClient(ctx, d.cl, "")
	if err != nil || id == "" {
		return nil, err
	}
	var allocs []struct {
		ID           string `json:"ID"`
		ClientStatus string `json:"ClientStatus"`
	}
	if err := api.Request(ctx, "GET", "node/"+url.PathEscape(id)+"/allocations", nil, &allocs); err != nil {
		return nil, err
	}
	var out []string
	for _, a := range allocs {
		if a.ClientStatus == "running" {
			out = append(out, a.ID)
		}
	}
	return out, nil
}

// waitAllocsHealthy waits until every given allocation (or, after a drain,
// its replacement) is running.
func (s *Service) waitAllocsHealthy(ctx context.Context, d *dockerHost, ids []string, followReplacement bool, log func(string, ...any)) error {
	if len(ids) == 0 {
		return nil
	}
	deadline := time.Now().Add(5 * time.Minute)
	for {
		api, _, err := s.apiClient(ctx, d.cl, "")
		pending := 0
		if err == nil {
			for _, id := range ids {
				cur := id
				for hop := 0; hop < 5; hop++ {
					var a struct {
						ClientStatus   string `json:"ClientStatus"`
						NextAllocation string `json:"NextAllocation"`
					}
					if err := api.Request(ctx, "GET", "allocation/"+url.PathEscape(cur), nil, &a); err != nil {
						pending++
						break
					}
					if followReplacement && a.NextAllocation != "" {
						cur = a.NextAllocation
						continue
					}
					if a.ClientStatus != "running" {
						pending++
					}
					break
				}
			}
		} else {
			pending = len(ids)
		}
		if pending == 0 {
			log("%d 个 Allocation 均已恢复运行", len(ids))
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%d 个 Allocation 未恢复运行", pending)
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return err
		}
	}
}

func (s *Service) upgradeDockerHost(ctx context.Context, t *ops.Task, nodeID string, in DockerInstallInput, hc *cluster.HTTPClient) error {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return err
	}
	cur := d.node.DockerVersion
	step, err := t.Step("下载并校验 Docker "+in.Version+"（"+d.node.Name+"）", nodeID)
	if err != nil {
		return err
	}
	arts, err := s.fetchDocker(ctx, step, hc, d.node, in.Version)
	var prev []*release.Artifact
	if err == nil {
		// The current version's packages back an in-place rollback.
		if prev, err = s.fetchDocker(ctx, step, hc, d.node, cur); err != nil {
			step.Logf("当前版本 %s 的安装包不可用（%v），本次升级不提供回退", cur, err)
			prev, err = nil, nil
		}
	}
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	target, err := dockerTarget(d.node)
	if err != nil {
		return err
	}
	nc, err := s.dockerRemote().Open(ctx, t, nodeID, "升级 Docker")
	if err != nil {
		return err
	}
	defer func() { nc.Done(ctx, err) }()
	kind := classifyDockerUpgrade(cur, in.Version, s.containerdVersion(ctx, nc), containerdOf(arts))
	canDrain := d.member != nil && IsClient(d.member.Role) && d.cl != nil && d.cl.InitState == db.InitInitialized
	drain := !kind.InPlace || in.Drain
	nc.Step.Logf("升级类型：%s（%s）", map[bool]string{true: "原地升级", false: "疏散后升级"}[kind.InPlace], kind.Reason)
	if drain && !canDrain && !in.AllowInterruption && !kind.InPlace {
		err = conflict("interruption_required", "%s 不能原地升级（%s），且不是可疏散的 Nomad Client，需显式确认接受容器中断", d.node.Name, kind.Reason)
		return err
	}
	var containers, allocs []string
	if drain && canDrain {
		if allocs, err = s.clientAllocs(ctx, d); err != nil {
			return err
		}
		if err = s.drainClient(ctx, d.cl, d.member, nc.Step.Logf); err != nil {
			return err
		}
	} else if kind.InPlace {
		if containers, err = s.runningContainers(ctx, nc); err != nil {
			return err
		}
		if allocs, err = s.clientAllocs(ctx, d); err != nil {
			return err
		}
		nc.Step.Logf("记录升级前运行中的容器 %d 个", len(containers))
	}
	dir, err := s.stageDocker(ctx, t, nc, arts, in.Version)
	if err != nil {
		return err
	}
	if err = s.installDockerPackages(ctx, nc, target.Format, dir, false); err != nil {
		return err
	}
	verify := func() error {
		out, err := nc.Run(ctx, "systemctl restart docker && timeout 60 docker info >/dev/null && docker version --format '{{.Server.Version}}'")
		if err != nil {
			return err
		}
		if got := strings.TrimSpace(out); got != in.Version {
			return fmt.Errorf("docker 报告的版本 %q 与期望的 %s 不一致", got, in.Version)
		}
		if kind.InPlace && !drain {
			for _, id := range containers {
				state, err := nc.Run(ctx, "docker inspect -f '{{.State.Running}}' "+id)
				if err != nil || strings.TrimSpace(state) != "true" {
					return fmt.Errorf("容器 %s 升级后不再运行", id[:12])
				}
			}
			nc.Step.Logf("升级前的 %d 个容器均仍在运行且可被管理", len(containers))
			if err := s.waitAllocsHealthy(ctx, d, allocs, false, nc.Step.Logf); err != nil {
				return err
			}
		} else {
			image := DefaultTestImage
			_ = db.GetSettingJSON(ctx, s.DB.Reader, "docker.test_image", &image)
			if _, err := nc.Run(ctx, "timeout 300 docker run --rm "+sshx.Quote(image)+" true"); err != nil {
				return fmt.Errorf("测试容器 %s 拉取或启动失败：%w", image, err)
			}
			nc.Step.Logf("测试容器 %s 拉取并启动成功", image)
		}
		return s.waitDockerDriver(ctx, d, nc.Step.Logf)
	}
	if verr := verify(); verr != nil {
		if kind.InPlace && !drain && prev != nil {
			nc.Step.Logf("验证失败（%v），按缓存的 %s 安装包回退", verr, cur)
			if pdir, perr := s.stageDocker(ctx, t, nc, prev, cur); perr == nil {
				if perr = s.installDockerPackages(ctx, nc, target.Format, pdir, true); perr == nil {
					_, _ = nc.Run(ctx, "systemctl restart docker")
				}
			}
			err = fmt.Errorf("%s 的 Docker 升级验证失败，已回退到 %s：%w", d.node.Name, cur, verr)
			return err
		}
		err = fmt.Errorf("熔断：%s 的 Docker 升级验证失败，节点保持不可调度，请人工处理：%w", d.node.Name, verr)
		return err
	}
	if err = s.recordDocker(ctx, d, "managed", in.Version); err != nil {
		return err
	}
	if drain && canDrain {
		if err = s.undrain(ctx, d.cl, d.member); err != nil {
			return err
		}
		nc.Step.Logf("已恢复调度")
		err = s.waitAllocsHealthy(ctx, d, allocs, true, nc.Step.Logf)
	}
	return err
}

// DockerConfigInput updates a host's Docker overrides.
type DockerConfigInput struct {
	DockerConfig
	// PullProxyPassword sets the custom proxy password (nil keeps it).
	PullProxyPassword *string `json:"pull_proxy_password"`
}

// applyPassword stores a new custom proxy password, or keeps the old one.
func (s *Service) applyPassword(cfg *DockerConfig, old *PullProxy, pass *string, aad string) error {
	if cfg.PullProxy == nil || cfg.PullProxy.Mode != "custom" {
		if cfg.PullProxy != nil {
			cfg.PullProxy.PasswordEncrypted, cfg.PullProxy.Username = "", ""
		}
		return nil
	}
	cfg.PullProxy.PasswordEncrypted = ""
	switch {
	case pass != nil && *pass != "":
		enc, err := s.Keys.EncryptString(*pass, aad)
		if err != nil {
			return err
		}
		cfg.PullProxy.PasswordEncrypted = enc
	case pass == nil && old != nil:
		cfg.PullProxy.PasswordEncrypted = old.PasswordEncrypted
	}
	return nil
}

// UpdateDockerConfig stores a host's overrides and applies them: managed
// hosts get a validated daemon.json (restored if Docker does not come back),
// external hosts only the pull proxy drop-in.
func (s *Service) UpdateDockerConfig(ctx context.Context, actor audit.Actor, nodeID string, in DockerConfigInput) (*db.OperationTask, error) {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if err := in.validate(); err != nil {
		return nil, err
	}
	if in.DataRoot != "" && in.DataRoot != d.host.DataRoot && d.node.DockerMode != "absent" {
		return nil, badRequest("data-root 只能在首次安装时设置")
	}
	if d.node.DockerMode == "external" && (len(in.RegistryMirrors) > 0 || in.LogMaxSize != "" || in.LogMaxFile != 0) {
		return nil, badRequest("external 模式只托管镜像拉取代理，其余守护进程配置不由 NomadDeck 管理")
	}
	cfg := in.DockerConfig
	if err := s.applyPassword(&cfg, d.host.PullProxy, in.PullProxyPassword, nodeProxyAAD(nodeID)); err != nil {
		return nil, err
	}
	d.host = cfg
	if d.host.PullProxy != nil {
		d.proxyAAD = nodeProxyAAD(nodeID)
	}
	b, _ := json.Marshal(cfg)
	if d.node.DockerMode == "absent" {
		if err := db.UpdateNodeDocker(ctx, s.DB.Writer, nodeID, d.node.DockerMode, d.node.DockerStatus, d.node.DockerVersion, string(b), s.DB.Now()); err != nil {
			return nil, err
		}
		_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.config", ResourceType: "node", ResourceID: nodeID,
			ResourceName: d.node.Name, Summary: map[string]any{"applied": false}})
		return nil, nil
	}
	if _, _, err := s.pullProxyURL(ctx, d, d.effective().PullProxy); err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "docker.config", TargetType: "node", TargetID: nodeID, Locks: s.dockerLocks(d),
		TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			nc, err := s.dockerRemote().Open(ctx, t, nodeID, "更新 Docker 守护进程配置")
			if err != nil {
				return err
			}
			defer func() { nc.Done(ctx, err) }()
			if _, err = s.writeDaemonConfig(ctx, nc, d, d.node.DockerMode, false); err != nil {
				return err
			}
			err = db.UpdateNodeDocker(ctx, s.DB.Writer, nodeID, d.node.DockerMode, "running", d.node.DockerVersion, string(b), s.DB.Now())
			if err == nil {
				err = s.waitDockerDriver(ctx, d, nc.Step.Logf)
			}
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.config", ResourceType: "node", ResourceID: nodeID,
		ResourceName: d.node.Name, OperationTaskID: task.ID, Summary: map[string]any{"pull_proxy": proxyMode(cfg.PullProxy)}})
	return task, nil
}

func proxyMode(p *PullProxy) string {
	if p == nil {
		return "inherit"
	}
	return p.Mode
}

// PutDockerDefaults stores the cluster default Docker configuration.
func (s *Service) PutDockerDefaults(ctx context.Context, actor audit.Actor, clusterID string, in DockerConfigInput) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	if in.AutoInstall && in.Version == "" {
		return badRequest("开启自动安装时需指定默认 Docker 版本")
	}
	var old DockerConfig
	_ = json.Unmarshal(cl.Settings.DockerDefaults, &old)
	cfg := in.DockerConfig
	if err := s.applyPassword(&cfg, old.PullProxy, in.PullProxyPassword, clusterProxyAAD(clusterID)); err != nil {
		return err
	}
	b, _ := json.Marshal(cfg)
	cl.Settings.DockerDefaults = b
	if err := s.saveSettings(ctx, cl); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.defaults", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, Summary: map[string]any{"version": cfg.Version, "auto_install": cfg.AutoInstall, "pull_proxy": proxyMode(cfg.PullProxy)}})
}

// ---- Proxy test ----

// ProxyTestResult is the outcome of a pull proxy test from a host.
type ProxyTestResult struct {
	OK         bool   `json:"ok"`
	Registry   string `json:"registry"`
	StatusCode int    `json:"status_code"`
	DurationMS int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}

// TestPullProxy checks, from the host itself, that the given (unsaved)
// pull proxy reaches the registry API (Docker Hub, or the first mirror).
func (s *Service) TestPullProxy(ctx context.Context, actor audit.Actor, nodeID string, in DockerConfigInput) (*ProxyTestResult, error) {
	d, err := s.loadDockerHost(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if err := in.validate(); err != nil {
		return nil, err
	}
	cfg := in.DockerConfig
	if err := s.applyPassword(&cfg, d.host.PullProxy, in.PullProxyPassword, nodeProxyAAD(nodeID)); err != nil {
		return nil, err
	}
	d.host = cfg
	d.proxyAAD = nodeProxyAAD(nodeID)
	eff := d.effective()
	proxyURL, _, err := s.pullProxyURL(ctx, d, eff.PullProxy)
	if err != nil {
		return nil, err
	}
	registry := "https://registry-1.docker.io/v2/"
	if len(eff.RegistryMirrors) > 0 {
		registry = strings.TrimRight(eff.RegistryMirrors[0], "/") + "/v2/"
	}
	res := &ProxyTestResult{Registry: registry}
	n, c, err := s.remote().Connect(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	var probe struct {
		Tools map[string]bool `json:"tools"`
	}
	_ = json.Unmarshal([]byte(n.ProbeJSON), &probe)
	env := "NO_PROXY= no_proxy= "
	if proxyURL != "" {
		env += "HTTPS_PROXY=" + sshx.Quote(proxyURL) + " HTTP_PROXY=" + sshx.Quote(proxyURL) + " https_proxy=" + sshx.Quote(proxyURL) +
			" http_proxy=" + sshx.Quote(proxyURL) + " "
	}
	var script string
	switch {
	case probe.Tools["curl"]:
		script = env + "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 " + sshx.Quote(registry)
	case probe.Tools["wget"]:
		script = env + "wget -S -O /dev/null --timeout=20 --tries=1 " + sshx.Quote(registry) + " 2>&1 | awk '/^  HTTP\\//{c=$2} END{print c}'"
	default:
		return nil, conflict("no_http_client", "主机上没有 curl 或 wget，无法从节点测试代理")
	}
	start := time.Now()
	r, err := c.Run(ctx, script, sshx.RunOptions{})
	res.DurationMS = time.Since(start).Milliseconds()
	out := ""
	if r != nil {
		out = strings.TrimSpace(string(r.Stdout))
	}
	res.StatusCode, _ = strconv.Atoi(out)
	switch {
	case res.StatusCode == 407:
		res.Error = "代理要求认证或认证失败（HTTP 407）"
	case res.StatusCode >= 200 && res.StatusCode < 500:
		res.OK = true
	case err != nil:
		msg := err.Error()
		if r != nil && len(r.Stderr) > 0 {
			msg = strings.TrimSpace(string(r.Stderr))
		}
		res.Error = msg
	default:
		res.Error = fmt.Sprintf("镜像仓库返回 HTTP %d", res.StatusCode)
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.proxy_test", ResourceType: "node", ResourceID: nodeID,
		ResourceName: n.Name, Summary: map[string]any{"ok": res.OK, "status": res.StatusCode, "mode": proxyMode(cfg.PullProxy)}})
	return res, nil
}

// ---- Cluster rolling upgrade ----

// DockerPlanItem is one host of a cluster Docker upgrade plan.
type DockerPlanItem struct {
	NodeID  string `json:"node_id"`
	Node    string `json:"node"`
	Mode    string `json:"mode"`
	Current string `json:"current_version"`
	Action  string `json:"action"` // upgrade | skip
	Kind    string `json:"kind,omitempty"`
	Reason  string `json:"reason"`
}

// DockerUpgradePlan previews a cluster-wide Docker upgrade.
type DockerUpgradePlan struct {
	Target string           `json:"target_version"`
	Items  []DockerPlanItem `json:"items"`
}

// PlanDockerUpgrade previews a rolling Docker upgrade of a Nomad cluster's
// clients. The in-place decision also depends on the containerd.io
// version resolved at run time, which can only demote a host to a drain.
func (s *Service) PlanDockerUpgrade(ctx context.Context, clusterID, version string) (*DockerUpgradePlan, error) {
	if _, err := s.loadCluster(ctx, s.DB.Reader, clusterID); err != nil {
		return nil, err
	}
	if err := validDockerVersion(version); err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	p := &DockerUpgradePlan{Target: version, Items: []DockerPlanItem{}}
	for _, m := range clients(members) {
		n, err := db.GetNode(ctx, s.DB.Reader, m.NodeID)
		if err != nil {
			return nil, err
		}
		it := DockerPlanItem{NodeID: n.ID, Node: n.Name, Mode: n.DockerMode, Current: n.DockerVersion, Action: "skip"}
		switch {
		case n.DockerMode != "managed":
			it.Reason = "非托管模式，不由 NomadDeck 升级"
		case release.CompareVersions(version, n.DockerVersion) <= 0:
			it.Reason = "已是该版本或更新"
		default:
			k := classifyDockerUpgrade(n.DockerVersion, version, "", "")
			it.Action, it.Reason = "upgrade", k.Reason
			it.Kind = map[bool]string{true: "in_place", false: "drain"}[k.InPlace]
		}
		p.Items = append(p.Items, it)
	}
	return p, nil
}

// UpgradeClusterDocker upgrades Docker on the cluster's managed clients one
// host at a time, stopping at the first failure.
func (s *Service) UpgradeClusterDocker(ctx context.Context, actor audit.Actor, clusterID string, in DockerInstallInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if err := s.requireOperable(cl); err != nil {
		return nil, err
	}
	plan, err := s.PlanDockerUpgrade(ctx, clusterID, in.Version)
	if err != nil {
		return nil, err
	}
	locks := []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}
	var targets []string
	for _, it := range plan.Items {
		if it.Action != "upgrade" {
			continue
		}
		d, err := s.loadDockerHost(ctx, it.NodeID)
		if err != nil {
			return nil, err
		}
		if err := s.checkDockerUpgrade(d, in); err != nil {
			return nil, err
		}
		targets = append(targets, it.NodeID)
		locks = append(locks, ops.LockReq{Key: ops.HostLock(it.NodeID, "docker"), Mode: ops.Exclusive})
	}
	if len(targets) == 0 {
		return nil, conflict("nothing_to_upgrade", "没有需要升级的托管 Docker 主机")
	}
	hc, err := cluster.NewHTTPClient(ctx, s.Proxy, in.UseProxy)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "docker.cluster_upgrade", TargetType: "cluster", TargetID: clusterID, Locks: locks,
		TriggeredBy: actor.Name, Params: map[string]any{"to": in.Version, "nodes": len(targets), "use_proxy": hc.UseProxy},
		Run: func(ctx context.Context, t *ops.Task) error {
			for _, id := range targets {
				if err := s.upgradeDockerHost(ctx, t, id, in, hc); err != nil {
					return fmt.Errorf("Docker 滚动升级熔断，后续主机未升级：%w", err)
				}
				_ = t.Checkpoint(map[string]any{"done": id, "to": in.Version})
			}
			return nil
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "docker.cluster_upgrade", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"to": in.Version, "nodes": len(targets)}})
	return task, nil
}
