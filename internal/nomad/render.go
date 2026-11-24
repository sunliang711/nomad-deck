package nomad

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"

	"nomad-deck/internal/sshx"
)

// Remote layout of a Nomad node.
const (
	Base        = "/opt/nomad-deck/nomad"
	BinDir      = Base + "/bin"
	VersionsDir = BinDir + "/versions"
	BinLink     = BinDir + "/nomad"
	SystemLink  = "/usr/local/bin/nomad"
	EtcDir      = Base + "/etc"
	ReleasesDir = EtcDir + "/releases"
	ConfigLink  = EtcDir + "/nomad.d"
	DataDir     = Base + "/data"
	VolumesDir  = Base + "/volumes"
	OpLockFile  = Base + "/.op.lock"
	UnitFile    = "/etc/systemd/system/nomad.service"
	CNIBinDir   = "/opt/cni/bin"
	CNIConfDir  = "/opt/cni/config"
	SysctlFile  = "/etc/sysctl.d/90-nomad-deck-cni.conf"
	ManagedMark = "# Managed by NomadDeck"
	// KeepGenerations is how many config generations stay on disk.
	KeepGenerations = 5
)

// Roles of a Nomad member.
const (
	RoleServer       = "server"
	RoleClient       = "client"
	RoleServerClient = "server_client"
)

// IsServer reports whether a role runs the server.
func IsServer(role string) bool { return role == RoleServer || role == RoleServerClient }

// IsClient reports whether a role runs the client.
func IsClient(role string) bool { return role == RoleClient || role == RoleServerClient }

// RunUser is the service user: pure servers run unprivileged, anything with
// a client runs as root for cgroups, CNI namespaces, host volumes and the
// Docker socket.
func RunUser(role string) string {
	if IsClient(role) {
		return "root"
	}
	return "nomad"
}

// VersionBinary returns the installed binary path of a version.
func VersionBinary(version string) string { return VersionsDir + "/nomad-" + version + "/nomad" }

// GenerationDir returns a config generation directory.
func GenerationDir(gen int) string { return ReleasesDir + "/" + strconv.Itoa(gen) }

// HostVolume is a client host volume.
type HostVolume struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	ReadOnly bool   `json:"read_only"`
	// Create makes the control plane create the directory on the host.
	Create bool `json:"create"`
}

// DockerDriver configures the Docker task driver plugin.
type DockerDriver struct {
	AllowPrivileged bool   `json:"allow_privileged"`
	Volumes         bool   `json:"volumes"`
	DisableImageGC  bool   `json:"disable_image_gc"`
	ImageGCDelay    string `json:"image_gc_delay,omitempty"`
	AuthConfig      string `json:"auth_config,omitempty"`
}

// UISettings configures the native Nomad UI.
type UISettings struct {
	Disabled   bool   `json:"disabled"`
	Label      string `json:"label,omitempty"`
	LabelBG    string `json:"label_background,omitempty"`
	LabelFG    string `json:"label_text_color,omitempty"`
	VaultUIURL string `json:"vault_ui_url,omitempty"`
}

// NodeConfig is everything needed to render one node's config generation.
type NodeConfig struct {
	Region      string
	Datacenter  string
	NodeName    string
	Role        string
	Advertise   string
	HTTPPort    int
	RPCPort     int
	SerfPort    int
	Generation  int
	Servers     []string // advertise addresses of every server (retry_join)
	BootstrapN  int      // bootstrap_expect for servers
	GossipKey   string
	TLS         bool
	VerifyHTTPS bool
	UI          UISettings
	Telemetry   bool
	JobGC       string
	NodePool    string
	Meta        map[string]string
	HostVolumes []HostVolume
	Docker      DockerDriver
	RawExec     bool
	Denylist    []string
	CNI         bool
	// Extra holds integration fragments (e.g. 60-vault.hcl, tls/vault-ca.crt)
	// keyed by file name relative to the generation directory.
	Extra map[string]string
}

func hostPort(host string, port int) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return host + ":" + strconv.Itoa(port)
}

func scheme(tls bool) string {
	if tls {
		return "https"
	}
	return "http"
}

// APIAddr returns the node HTTP API address.
func APIAddr(host string, port int, tls bool) string {
	return scheme(tls) + "://" + hostPort(host, port)
}

func quoteList(xs []string) string {
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = strconv.Quote(x)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// RenderBase renders 10-base.hcl.
func RenderBase(c NodeConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", ManagedMark)
	fmt.Fprintf(&b, "region     = %q\n", c.Region)
	fmt.Fprintf(&b, "datacenter = %q\n", c.Datacenter)
	fmt.Fprintf(&b, "name       = %q\n", c.NodeName)
	fmt.Fprintf(&b, "data_dir   = %q\n", DataDir)
	fmt.Fprintf(&b, "bind_addr  = \"0.0.0.0\"\n")
	fmt.Fprintf(&b, "log_level  = \"INFO\"\n\n")
	fmt.Fprintf(&b, "advertise {\n  http = %q\n  rpc  = %q\n  serf = %q\n}\n\n",
		hostPort(c.Advertise, c.HTTPPort), hostPort(c.Advertise, c.RPCPort), hostPort(c.Advertise, c.SerfPort))
	fmt.Fprintf(&b, "ports {\n  http = %d\n  rpc  = %d\n  serf = %d\n}\n\n", c.HTTPPort, c.RPCPort, c.SerfPort)
	if IsServer(c.Role) {
		var join []string
		for _, s := range c.Servers {
			if s != c.Advertise {
				join = append(join, hostPort(s, c.SerfPort))
			}
		}
		fmt.Fprintf(&b, "server {\n  enabled          = true\n  bootstrap_expect = %d\n", c.BootstrapN)
		if c.GossipKey != "" {
			fmt.Fprintf(&b, "  encrypt          = %q\n", c.GossipKey)
		}
		if c.JobGC != "" {
			fmt.Fprintf(&b, "  job_gc_threshold = %q\n", c.JobGC)
		}
		if len(join) > 0 {
			fmt.Fprintf(&b, "\n  server_join {\n    retry_join = %s\n  }\n", quoteList(join))
		}
		fmt.Fprintf(&b, "}\n\n")
	}
	if IsClient(c.Role) {
		var join []string
		for _, s := range c.Servers {
			join = append(join, hostPort(s, c.RPCPort))
		}
		fmt.Fprintf(&b, "client {\n  enabled   = true\n")
		if c.NodePool != "" {
			fmt.Fprintf(&b, "  node_pool = %q\n", c.NodePool)
		}
		fmt.Fprintf(&b, "\n  server_join {\n    retry_join = %s\n  }\n}\n\n", quoteList(join))
	}
	fmt.Fprintf(&b, "acl {\n  enabled = true\n}\n")
	return b.String()
}

// RenderTLS renders 30-tls.hcl. Files are referenced by absolute paths in
// the generation directory so a candidate generation validates on its own.
func RenderTLS(c NodeConfig) string {
	dir := GenerationDir(c.Generation)
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", ManagedMark)
	if !c.TLS {
		fmt.Fprintf(&b, "# TLS is disabled for this non-production cluster (allow_insecure_http).\n")
		fmt.Fprintf(&b, "tls {\n  http = false\n  rpc  = false\n}\n")
		return b.String()
	}
	fmt.Fprintf(&b, "tls {\n")
	fmt.Fprintf(&b, "  http                   = true\n")
	fmt.Fprintf(&b, "  rpc                    = true\n")
	fmt.Fprintf(&b, "  ca_file                = %q\n", dir+"/tls/ca.pem")
	fmt.Fprintf(&b, "  cert_file              = %q\n", dir+"/tls/agent.pem")
	fmt.Fprintf(&b, "  key_file               = %q\n", dir+"/tls/agent-key.pem")
	fmt.Fprintf(&b, "  verify_server_hostname = true\n")
	fmt.Fprintf(&b, "  verify_https_client    = %t\n", c.VerifyHTTPS)
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

// RenderUI renders 35-ui.hcl (servers only).
func RenderUI(c NodeConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", ManagedMark)
	fmt.Fprintf(&b, "ui {\n  enabled = %t\n", !c.UI.Disabled)
	if c.UI.Label != "" {
		fmt.Fprintf(&b, "\n  label {\n    text = %q\n", c.UI.Label)
		if c.UI.LabelBG != "" {
			fmt.Fprintf(&b, "    background_color = %q\n", c.UI.LabelBG)
		}
		if c.UI.LabelFG != "" {
			fmt.Fprintf(&b, "    text_color = %q\n", c.UI.LabelFG)
		}
		fmt.Fprintf(&b, "  }\n")
	}
	if c.UI.VaultUIURL != "" {
		fmt.Fprintf(&b, "\n  vault {\n    ui_url = %q\n  }\n", c.UI.VaultUIURL)
	}
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

// RenderTelemetry renders 40-telemetry.hcl.
func RenderTelemetry(c NodeConfig) string {
	return fmt.Sprintf(`%s
telemetry {
  collection_interval        = "10s"
  disable_hostname           = true
  prometheus_metrics         = %t
  publish_allocation_metrics = %t
  publish_node_metrics       = %t
}
`, ManagedMark, c.Telemetry, c.Telemetry, c.Telemetry)
}

// RenderHostVolume renders 70-host-volume-<name>.hcl.
func RenderHostVolume(v HostVolume) string {
	return fmt.Sprintf(`%s
client {
  host_volume %q {
    path      = %q
    read_only = %t
  }
}
`, ManagedMark, v.Name, v.Path, v.ReadOnly)
}

// RenderMeta renders 72-client-meta.hcl.
func RenderMeta(meta map[string]string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\nclient {\n  meta = {\n", ManagedMark)
	for _, k := range sortedKeys(meta) {
		fmt.Fprintf(&b, "    %q = %q\n", k, meta[k])
	}
	fmt.Fprintf(&b, "  }\n}\n")
	return b.String()
}

// RenderDocker renders 80-docker.hcl.
func RenderDocker(d DockerDriver) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\nplugin \"docker\" {\n  config {\n", ManagedMark)
	fmt.Fprintf(&b, "    allow_privileged = %t\n\n", d.AllowPrivileged)
	fmt.Fprintf(&b, "    volumes {\n      enabled = %t\n    }\n\n", d.Volumes)
	delay := d.ImageGCDelay
	if delay == "" {
		delay = "3m"
	}
	fmt.Fprintf(&b, "    gc {\n      image       = %t\n      image_delay = %q\n      container   = true\n    }\n",
		!d.DisableImageGC, delay)
	if d.AuthConfig != "" {
		fmt.Fprintf(&b, "\n    auth {\n      config = %q\n    }\n", d.AuthConfig)
	}
	fmt.Fprintf(&b, "  }\n}\n")
	return b.String()
}

// RenderRawExec renders 81-raw-exec.hcl.
func RenderRawExec() string {
	return ManagedMark + "\nplugin \"raw_exec\" {\n  config {\n    enabled = true\n  }\n}\n"
}

// RenderDenylist renders 82-driver-denylist.hcl.
func RenderDenylist(drivers []string) string {
	return fmt.Sprintf("%s\nclient {\n  options = {\n    \"driver.denylist\" = %q\n  }\n}\n", ManagedMark, strings.Join(drivers, ","))
}

// RenderCNI renders 83-cni.hcl.
func RenderCNI() string {
	return fmt.Sprintf("%s\nclient {\n  cni_path       = %q\n  cni_config_dir = %q\n}\n", ManagedMark, CNIBinDir, CNIConfDir)
}

// GenerationFile is one file of a config generation.
type GenerationFile struct {
	Name    string // relative name, e.g. 10-base.hcl or tls/agent-key.pem
	Content []byte
	Mode    string
	SHA256  string
}

var reVolumeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

// RenderFiles renders every HCL fragment of a node (TLS material is added
// by the caller). Fragments that do not apply to the role are omitted.
func RenderFiles(c NodeConfig) ([]GenerationFile, error) {
	files := []GenerationFile{
		{Name: "10-base.hcl", Content: []byte(RenderBase(c))},
		{Name: "30-tls.hcl", Content: []byte(RenderTLS(c))},
		{Name: "40-telemetry.hcl", Content: []byte(RenderTelemetry(c))},
	}
	if IsServer(c.Role) {
		files = append(files, GenerationFile{Name: "35-ui.hcl", Content: []byte(RenderUI(c))})
	}
	if IsClient(c.Role) {
		for _, v := range c.HostVolumes {
			if !reVolumeName.MatchString(v.Name) {
				return nil, fmt.Errorf("invalid host volume name %q", v.Name)
			}
			files = append(files, GenerationFile{Name: "70-host-volume-" + v.Name + ".hcl", Content: []byte(RenderHostVolume(v))})
		}
		if len(c.Meta) > 0 {
			files = append(files, GenerationFile{Name: "72-client-meta.hcl", Content: []byte(RenderMeta(c.Meta))})
		}
		files = append(files, GenerationFile{Name: "80-docker.hcl", Content: []byte(RenderDocker(c.Docker))})
		if c.RawExec {
			files = append(files, GenerationFile{Name: "81-raw-exec.hcl", Content: []byte(RenderRawExec())})
		}
		if len(c.Denylist) > 0 {
			files = append(files, GenerationFile{Name: "82-driver-denylist.hcl", Content: []byte(RenderDenylist(c.Denylist))})
		}
		if c.CNI {
			files = append(files, GenerationFile{Name: "83-cni.hcl", Content: []byte(RenderCNI())})
		}
	}
	names := make([]string, 0, len(c.Extra))
	for n := range c.Extra {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		files = append(files, GenerationFile{Name: n, Content: []byte(c.Extra[n])})
	}
	for i := range files {
		files[i].Mode = "0640"
		if strings.HasSuffix(files[i].Name, ".hcl") {
			if err := ValidateHCL(files[i].Name, string(files[i].Content)); err != nil {
				return nil, err
			}
		}
	}
	return files, nil
}

// ValidateHCL checks that rendered configuration parses.
func ValidateHCL(name, src string) error {
	_, diags := hclsyntax.ParseConfig([]byte(src), name, hcl.InitialPos)
	if diags.HasErrors() {
		return fmt.Errorf("%s: %s", name, diags.Error())
	}
	return nil
}

// UnitContent is the systemd unit for a role.
func UnitContent(role string) string {
	user := RunUser(role)
	return ManagedMark + `
[Unit]
Description=HashiCorp Nomad (managed by NomadDeck)
Documentation=https://developer.hashicorp.com/nomad/docs
Wants=network-online.target
After=network-online.target

[Service]
User=` + user + `
Group=` + user + `
ExecReload=/bin/kill -HUP $MAINPID
ExecStart=` + BinLink + ` agent -config ` + ConfigLink + `
KillMode=process
KillSignal=SIGINT
LimitNOFILE=65536
LimitNPROC=infinity
Restart=on-failure
RestartSec=2
TasksMax=infinity
OOMScoreAdjust=-1000

[Install]
WantedBy=multi-user.target
`
}

// PrepareScript creates the nomad user (for pure servers), the directory
// layout and the systemd unit (idempotent).
func PrepareScript(role string) string {
	user := RunUser(role)
	return fmt.Sprintf(`set -e
if ! id nomad >/dev/null 2>&1; then
  nologin=$(command -v nologin || echo /bin/false)
  useradd --system --home-dir %[1]s --no-create-home --shell "$nologin" nomad
fi
install -d -m 0755 -o root -g root %[1]s %[2]s %[3]s %[4]s %[7]s
install -d -m 0750 -o root -g %[8]s %[5]s
install -d -m 0700 -o %[8]s -g %[8]s %[6]s
cat > %[9]s.nd-tmp <<'ND_UNIT_EOF'
%[10]sND_UNIT_EOF
mv -f %[9]s.nd-tmp %[9]s
chmod 0644 %[9]s
systemctl daemon-reload
echo "host prepared (service user %[8]s)"
`, Base, BinDir, VersionsDir, EtcDir, ReleasesDir, DataDir, VolumesDir, user, UnitFile, UnitContent(role))
}

// ActivateBinaryScript points the binary links at an installed version.
func ActivateBinaryScript(version string) string {
	bin := VersionBinary(version)
	return fmt.Sprintf(`set -e
test -x %[1]s
%[1]s version | head -1
ln -sfn %[1]s %[2]s.nd-tmp && mv -Tf %[2]s.nd-tmp %[2]s
ln -sfn %[2]s %[3]s.nd-tmp && mv -Tf %[3]s.nd-tmp %[3]s
`, bin, BinLink, SystemLink)
}

// SwitchGenerationScript verifies every file of a candidate generation by
// SHA-256, validates the directory with "nomad config validate", fixes
// ownership and atomically switches the nomad.d link, then prunes old
// generations (never the active one).
func SwitchGenerationScript(gen int, role string, files []GenerationFile) string {
	dir := GenerationDir(gen)
	var sums strings.Builder
	for _, f := range files {
		fmt.Fprintf(&sums, "%s  %s\n", f.SHA256, f.Name)
	}
	return fmt.Sprintf(`set -e
cd %[1]s
sha256sum -c --quiet - <<'ND_SUMS_EOF'
%[2]sND_SUMS_EOF
chown -R root:%[7]s %[1]s
find %[1]s -type d -exec chmod 0750 {} +
%[8]s config validate %[1]s >/dev/null
ln -sfn releases/%[3]d %[4]s.nd-tmp && mv -Tf %[4]s.nd-tmp %[4]s
cd %[5]s
ls -1 | grep -E '^[0-9]+$' | sort -n | head -n -%[6]d | while read -r g; do
  [ "$g" = %[3]d ] || rm -rf -- "%[5]s/$g"
done
readlink %[4]s
`, dir, sums.String(), gen, ConfigLink, ReleasesDir, KeepGenerations, RunUser(role), BinLink)
}

// ServiceScript runs a systemctl action on nomad.service.
func ServiceScript(action string) (string, error) {
	switch action {
	case "start":
		return "systemctl enable nomad.service >/dev/null 2>&1 || true\nsystemctl start nomad.service\nsystemctl is-active nomad.service\n", nil
	case "stop":
		return "systemctl stop nomad.service\nsystemctl is-active nomad.service || true\n", nil
	case "restart":
		return "systemctl restart nomad.service\nsystemctl is-active nomad.service\n", nil
	case "disable":
		return "systemctl disable --now nomad.service >/dev/null 2>&1 || true\n", nil
	}
	return "", fmt.Errorf("unknown service action %q", action)
}

// CNIInstallScript extracts a staged, verified CNI archive into /opt/cni/bin
// and enables the bridge sysctls Nomad bridge networking needs.
func CNIInstallScript(archive string) string {
	return fmt.Sprintf(`set -e
install -d -m 0755 %[1]s %[2]s
tar -xzf %[3]s -C %[1]s
rm -f %[3]s
modprobe br_netfilter 2>/dev/null || true
cat > %[4]s.nd-tmp <<'ND_SYSCTL_EOF'
%[5]s
net.bridge.bridge-nf-call-arptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
ND_SYSCTL_EOF
mv -f %[4]s.nd-tmp %[4]s
sysctl -q -p %[4]s 2>/dev/null || echo "bridge sysctls not applied (br_netfilter unavailable)"
ls %[1]s | tr '\n' ' '
`, CNIBinDir, CNIConfDir, archive, SysctlFile, ManagedMark)
}

// HostVolumeScript creates host volume directories that do not exist yet;
// existing directories are left untouched.
func HostVolumeScript(vols []HostVolume) string {
	var b strings.Builder
	b.WriteString("set -e\n")
	for _, v := range vols {
		if v.Create {
			fmt.Fprintf(&b, "[ -d %[1]s ] || install -d -m 0755 %[1]s\n", sshx.Quote(v.Path))
		}
	}
	return b.String()
}
