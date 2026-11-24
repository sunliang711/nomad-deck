package sshx

import (
	"bufio"
	"context"
	"strconv"
	"strings"
	"time"
)

// probeScript gathers host facts as key=value lines. It runs as the login
// user and uses "sudo -n" only for checks that need root.
const probeScript = `set +e
emit() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')"; }
emit uid "$(id -u)"
emit kernel "$(uname -r)"
emit arch "$(uname -m)"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  emit os_id "$ID"; emit os_id_like "$ID_LIKE"; emit os_version_id "$VERSION_ID"
  emit os_codename "${VERSION_CODENAME:-}"; emit os_pretty "$PRETTY_NAME"
fi
for t in systemctl journalctl systemd-run tar gzip sha256sum; do
  if command -v "$t" >/dev/null 2>&1; then emit "has_$t" 1; else emit "has_$t" 0; fi
done
for pm in apt-get dnf yum; do
  if command -v "$pm" >/dev/null 2>&1; then emit package_manager "$pm"; break; fi
done
if [ "$(id -u)" = 0 ]; then emit sudo root; SUDO=""
elif sudo -n true 2>/dev/null; then emit sudo ok; SUDO="sudo -n"
else emit sudo none; SUDO="false"; fi
if command -v getenforce >/dev/null 2>&1; then emit selinux "$(getenforce 2>/dev/null)"
elif [ -d /sys/fs/selinux ]; then emit selinux unknown
else emit selinux disabled; fi
emit swap_entries "$(awk 'NR>1' /proc/swaps 2>/dev/null | wc -l | tr -d ' ')"
emit swap_crypt "$(awk 'NR>1{print $1}' /proc/swaps 2>/dev/null | grep -c '^/dev/mapper/' )"
emit machine_id "$(cat /etc/machine-id 2>/dev/null)"
emit epoch "$(date +%s.%N 2>/dev/null)"
if command -v timedatectl >/dev/null 2>&1; then
  emit ntp_synced "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
elif command -v chronyc >/dev/null 2>&1; then
  if chronyc tracking 2>/dev/null | grep -q 'Leap status *: Normal'; then emit ntp_synced yes; else emit ntp_synced no; fi
fi
if command -v dockerd >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
  emit docker_installed 1
  emit docker_version "$( (dockerd --version || docker --version) 2>/dev/null | head -1)"
  emit docker_active "$(systemctl is-active docker 2>/dev/null)"
  if command -v dpkg-query >/dev/null 2>&1; then
    emit docker_pkg "$(dpkg-query -W -f='${Package} ' docker-ce docker.io moby-engine 2>/dev/null)"
  elif command -v rpm >/dev/null 2>&1; then
    emit docker_pkg "$(rpm -q --qf '%{NAME} ' docker-ce docker moby-engine 2>/dev/null | grep -v 'not installed')"
  fi
  [ -e /etc/docker/daemon.json.managed-by-nomad-deck ] && emit docker_managed_marker 1
else
  emit docker_installed 0
fi
if [ -d /opt/nomad-deck ]; then d=/opt/nomad-deck; else d=/opt; fi
if [ "$SUDO" != "false" ] && $SUDO test -w "$d" 2>/dev/null; then emit opt_writable 1; else emit opt_writable 0; fi
`

// ProbeResult holds parsed host facts.
type ProbeResult struct {
	Raw            map[string]string `json:"raw"`
	Arch           string            `json:"arch"`
	Kernel         string            `json:"kernel"`
	OSInfo         string            `json:"os_info"`
	OSFamily       string            `json:"os_family"`
	OSCodename     string            `json:"os_codename"`
	PackageManager string            `json:"package_manager"`
	IsRoot         bool              `json:"is_root"`
	SudoReady      bool              `json:"sudo_ready"`
	SELinux        string            `json:"selinux"`
	SwapEnabled    bool              `json:"swap_enabled"`
	SwapEncrypted  bool              `json:"swap_encrypted"`
	MachineID      string            `json:"machine_id"`
	TimeSync       string            `json:"time_sync"`
	ClockSkewMS    int64             `json:"clock_skew_ms"`
	DockerMode     string            `json:"docker_mode"`
	DockerStatus   string            `json:"docker_status"`
	DockerVersion  string            `json:"docker_version"`
	OptWritable    bool              `json:"opt_writable"`
	Tools          map[string]bool   `json:"tools"`
	Missing        []string          `json:"missing_tools"`
}

// Probe runs the probe script and parses the result. The clock skew is the
// remote clock minus the midpoint of the local request/response times.
func Probe(ctx context.Context, c *Client) (*ProbeResult, error) {
	t0 := time.Now()
	res, err := c.Run(ctx, probeScript, RunOptions{})
	t1 := time.Now()
	if err != nil {
		return nil, err
	}
	return ParseProbe(string(res.Stdout), t0.Add(t1.Sub(t0)/2)), nil
}

// ParseProbe converts probe output into a ProbeResult.
func ParseProbe(out string, localMid time.Time) *ProbeResult {
	raw := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok {
			raw[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	p := &ProbeResult{Raw: raw, Tools: map[string]bool{}}
	p.Arch = normalizeArch(raw["arch"])
	p.Kernel = raw["kernel"]
	p.OSInfo = strings.TrimSpace(raw["os_pretty"] + " / " + raw["kernel"])
	p.OSFamily, p.OSCodename = osFamily(raw["os_id"], raw["os_id_like"], raw["os_version_id"], raw["os_codename"])
	p.PackageManager = map[string]string{"apt-get": "apt", "dnf": "dnf", "yum": "yum"}[raw["package_manager"]]
	p.IsRoot = raw["sudo"] == "root"
	p.SudoReady = raw["sudo"] == "root" || raw["sudo"] == "ok"
	switch strings.ToLower(raw["selinux"]) {
	case "enforcing", "permissive", "disabled":
		p.SELinux = strings.ToLower(raw["selinux"])
	default:
		p.SELinux = "unknown"
	}
	entries, _ := strconv.Atoi(raw["swap_entries"])
	crypt, _ := strconv.Atoi(raw["swap_crypt"])
	p.SwapEnabled = entries > 0
	p.SwapEncrypted = entries > 0 && crypt == entries
	p.MachineID = raw["machine_id"]
	switch strings.ToLower(raw["ntp_synced"]) {
	case "yes", "true", "1":
		p.TimeSync = "synced"
	case "no", "false", "0":
		p.TimeSync = "unsynced"
	default:
		p.TimeSync = "unknown"
	}
	if f, err := strconv.ParseFloat(raw["epoch"], 64); err == nil && f > 0 && !localMid.IsZero() {
		remote := time.Unix(0, int64(f*1e9))
		p.ClockSkewMS = remote.Sub(localMid).Milliseconds()
	}
	if raw["docker_installed"] == "1" {
		p.DockerVersion = parseDockerVersion(raw["docker_version"])
		if raw["docker_active"] == "active" {
			p.DockerStatus = "running"
		} else {
			p.DockerStatus = "installed_stopped"
		}
		if raw["docker_managed_marker"] == "1" && strings.Contains(raw["docker_pkg"], "docker-ce") {
			p.DockerMode = "managed"
		} else {
			p.DockerMode = "external"
		}
	} else {
		p.DockerMode, p.DockerStatus = "absent", "absent"
	}
	p.OptWritable = raw["opt_writable"] == "1"
	for _, t := range []string{"systemctl", "journalctl", "systemd-run", "tar", "gzip", "sha256sum"} {
		ok := raw["has_"+t] == "1"
		p.Tools[t] = ok
		if !ok {
			p.Missing = append(p.Missing, t)
		}
	}
	return p
}

func normalizeArch(a string) string {
	switch a {
	case "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	default:
		return a
	}
}

func osFamily(id, like, versionID, codename string) (family, code string) {
	id, like = strings.ToLower(id), strings.ToLower(like)
	has := func(s string) bool { return id == s || strings.Contains(" "+like+" ", " "+s+" ") }
	switch {
	case has("debian") || has("ubuntu"):
		return "debian", codename
	case has("rhel") || has("fedora") || has("centos"):
		major, _, _ := strings.Cut(versionID, ".")
		return "rhel", major
	default:
		return id, codename
	}
}

// parseDockerVersion extracts "27.3.1" from "Docker version 27.3.1, build ...".
func parseDockerVersion(s string) string {
	f := strings.Fields(s)
	for i, w := range f {
		if w == "version" && i+1 < len(f) {
			return strings.TrimSuffix(f[i+1], ",")
		}
	}
	return strings.TrimSpace(s)
}
