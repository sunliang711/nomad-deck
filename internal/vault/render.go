package vault

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
)

// Remote layout of a Vault node.
const (
	Base        = "/opt/nomad-deck/vault"
	BinDir      = Base + "/bin"
	VersionsDir = BinDir + "/versions"
	BinLink     = BinDir + "/vault"
	SystemLink  = "/usr/local/bin/vault"
	EtcDir      = Base + "/etc"
	ReleasesDir = EtcDir + "/releases"
	ConfigLink  = EtcDir + "/vault.d"
	DataDir     = Base + "/data/raft"
	LogDir      = Base + "/logs"
	AuditLog    = LogDir + "/audit.log"
	OpLockFile  = Base + "/.op.lock"
	UnitFile    = "/etc/systemd/system/vault.service"
	LogrotateF  = "/etc/logrotate.d/nomad-deck-vault"
	ManagedMark = "# Managed by NomadDeck"
	// KeepGenerations is how many config generations stay on disk.
	KeepGenerations = 5
)

// VersionBinary returns the installed binary path of a version.
func VersionBinary(version string) string { return VersionsDir + "/vault-" + version + "/vault" }

// GenerationDir returns a config generation directory.
func GenerationDir(gen int) string { return ReleasesDir + "/" + strconv.Itoa(gen) }

// NodeConfig is everything needed to render one node's config.hcl.
type NodeConfig struct {
	ClusterName  string
	RaftNodeID   string
	Advertise    string // host part of api_addr/cluster_addr
	APIPort      int
	ClusterPort  int
	TLS          bool
	Generation   int
	Peers        []string // api addresses of the other nodes (retry_join)
	AuditLogPath string
	Version      string // Vault version the config is rendered for
}

// unauthGenerateRoot reports whether the version denies unauthenticated
// generate-root by default (Vault 2.0 and later), which the control plane
// needs for emergency token recovery when no valid token exists.
func unauthGenerateRoot(version string) bool {
	major, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(major)
	return err == nil && n >= 2
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

// APIAddr returns the node API address.
func APIAddr(host string, port int, tls bool) string {
	return scheme(tls) + "://" + hostPort(host, port)
}

// ClusterAddr returns the node cluster address.
func ClusterAddr(host string, port int, tls bool) string {
	return "https://" + hostPort(host, port)
}

// RenderConfig renders config.hcl. TLS files are referenced by absolute
// paths inside the generation directory.
func RenderConfig(c NodeConfig) string {
	dir := GenerationDir(c.Generation)
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", ManagedMark)
	fmt.Fprintf(&b, "ui            = true\n")
	fmt.Fprintf(&b, "disable_mlock = true\n")
	fmt.Fprintf(&b, "cluster_name  = %q\n", c.ClusterName)
	fmt.Fprintf(&b, "api_addr      = %q\n", APIAddr(c.Advertise, c.APIPort, c.TLS))
	fmt.Fprintf(&b, "cluster_addr  = %q\n", ClusterAddr(c.Advertise, c.ClusterPort, c.TLS))
	if unauthGenerateRoot(c.Version) {
		// Emergency token recovery uses generate-root without a token; it
		// still requires a threshold of unseal keys.
		fmt.Fprintf(&b, "enable_unauthenticated_access = [\"generate-root\"]\n")
	}
	fmt.Fprintf(&b, "\n")
	fmt.Fprintf(&b, "listener \"tcp\" {\n")
	fmt.Fprintf(&b, "  address         = %q\n", hostPort("0.0.0.0", c.APIPort))
	fmt.Fprintf(&b, "  cluster_address = %q\n", hostPort("0.0.0.0", c.ClusterPort))
	if c.TLS {
		fmt.Fprintf(&b, "  tls_cert_file   = %q\n", dir+"/tls/server.crt")
		fmt.Fprintf(&b, "  tls_key_file    = %q\n", dir+"/tls/server.key")
		fmt.Fprintf(&b, "  tls_min_version = \"tls12\"\n")
	} else {
		fmt.Fprintf(&b, "  tls_disable     = true\n")
	}
	fmt.Fprintf(&b, "}\n\n")
	fmt.Fprintf(&b, "storage \"raft\" {\n")
	fmt.Fprintf(&b, "  path    = %q\n", DataDir)
	fmt.Fprintf(&b, "  node_id = %q\n", c.RaftNodeID)
	for _, p := range c.Peers {
		fmt.Fprintf(&b, "\n  retry_join {\n")
		fmt.Fprintf(&b, "    leader_api_addr = %q\n", p)
		if c.TLS {
			fmt.Fprintf(&b, "    leader_ca_cert_file = %q\n", dir+"/tls/ca.crt")
		}
		fmt.Fprintf(&b, "  }\n")
	}
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

// ValidateHCL checks that rendered configuration parses.
func ValidateHCL(name, src string) error {
	_, diags := hclsyntax.ParseConfig([]byte(src), name, hcl.InitialPos)
	if diags.HasErrors() {
		return fmt.Errorf("%s: %s", name, diags.Error())
	}
	return nil
}

// UnitContent is the systemd unit. Vault runs as the unprivileged "vault"
// user, core dumps are disabled and no local auto-unseal is installed.
const UnitContent = ManagedMark + `
[Unit]
Description=HashiCorp Vault (managed by NomadDeck)
Documentation=https://developer.hashicorp.com/vault/docs
Requires=network-online.target
After=network-online.target

[Service]
Type=notify
User=vault
Group=vault
ExecStart=` + BinLink + ` server -config=` + ConfigLink + `/config.hcl
ExecReload=/bin/kill --signal HUP $MAINPID
KillMode=process
KillSignal=SIGINT
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=65536
LimitCORE=0
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SYSLOG CAP_IPC_LOCK

[Install]
WantedBy=multi-user.target
`

// LogrotateContent rotates the file audit log by size and makes Vault
// reopen it with SIGHUP.
func LogrotateContent(maxMB, keep int) string {
	if maxMB <= 0 {
		maxMB = 100
	}
	if keep <= 0 {
		keep = 10
	}
	return fmt.Sprintf(`%s
%s {
    size %dM
    rotate %d
    compress
    delaycompress
    missingok
    notifempty
    create 0600 vault vault
    postrotate
        systemctl kill --signal=HUP vault.service >/dev/null 2>&1 || true
    endscript
}
`, ManagedMark, AuditLog, maxMB, keep)
}

// PrepareScript creates the vault user, the directory layout, the systemd
// unit and the logrotate configuration (idempotent).
func PrepareScript(unit, logrotate string) string {
	return fmt.Sprintf(`set -e
if ! id vault >/dev/null 2>&1; then
  nologin=$(command -v nologin || echo /bin/false)
  useradd --system --home-dir %[1]s --no-create-home --shell "$nologin" vault
fi
install -d -m 0755 -o root -g root %[1]s %[2]s %[3]s %[4]s
install -d -m 0750 -o root -g vault %[5]s
install -d -m 0700 -o vault -g vault %[1]s/data %[6]s
install -d -m 0750 -o vault -g vault %[7]s
touch %[8]s && chown vault:vault %[8]s && chmod 0600 %[8]s
cat > %[9]s.nd-tmp <<'ND_UNIT_EOF'
%[10]sND_UNIT_EOF
mv -f %[9]s.nd-tmp %[9]s
chmod 0644 %[9]s
if [ -d /etc/logrotate.d ]; then
cat > %[11]s.nd-tmp <<'ND_LR_EOF'
%[12]sND_LR_EOF
mv -f %[11]s.nd-tmp %[11]s
chmod 0644 %[11]s
fi
systemctl daemon-reload
echo "host prepared"
`, Base, BinDir, VersionsDir, EtcDir, ReleasesDir, DataDir, LogDir, AuditLog, UnitFile, unit, LogrotateF, logrotate)
}

// ActivateBinaryScript points the binary links at an installed version.
func ActivateBinaryScript(version string) string {
	bin := VersionBinary(version)
	return fmt.Sprintf(`set -e
test -x %[1]s
%[1]s version
ln -sfn %[1]s %[2]s.nd-tmp && mv -Tf %[2]s.nd-tmp %[2]s
ln -sfn %[2]s %[3]s.nd-tmp && mv -Tf %[3]s.nd-tmp %[3]s
`, bin, BinLink, SystemLink)
}

// GenerationFile is one file of a config generation.
type GenerationFile struct {
	Name    string // relative name, e.g. config.hcl or tls/server.key
	Content []byte
	Mode    string
	SHA256  string
}

// SwitchGenerationScript verifies every file of a candidate generation by
// SHA-256, fixes ownership and atomically switches the vault.d link, then
// prunes old generations (never the active one).
func SwitchGenerationScript(gen int, files []GenerationFile) string {
	dir := GenerationDir(gen)
	var sums strings.Builder
	for _, f := range files {
		fmt.Fprintf(&sums, "%s  %s\n", f.SHA256, f.Name)
	}
	return fmt.Sprintf(`set -e
cd %[1]s
sha256sum -c --quiet - <<'ND_SUMS_EOF'
%[2]sND_SUMS_EOF
chown -R root:vault %[1]s
find %[1]s -type d -exec chmod 0750 {} +
ln -sfn releases/%[3]d %[4]s.nd-tmp && mv -Tf %[4]s.nd-tmp %[4]s
cd %[5]s
ls -1 | grep -E '^[0-9]+$' | sort -n | head -n -%[6]d | while read -r g; do
  [ "$g" = %[3]d ] || rm -rf -- "%[5]s/$g"
done
readlink %[4]s
`, dir, sums.String(), gen, ConfigLink, ReleasesDir, KeepGenerations)
}

// ServiceScript runs a systemctl action on vault.service.
func ServiceScript(action string) (string, error) {
	switch action {
	case "start":
		return "systemctl enable vault.service >/dev/null 2>&1 || true\nsystemctl start vault.service\nsystemctl is-active vault.service\n", nil
	case "stop":
		return "systemctl stop vault.service\nsystemctl is-active vault.service || true\n", nil
	case "restart":
		return "systemctl restart vault.service\nsystemctl is-active vault.service\n", nil
	case "disable":
		return "systemctl disable --now vault.service >/dev/null 2>&1 || true\n", nil
	}
	return "", fmt.Errorf("unknown service action %q", action)
}
