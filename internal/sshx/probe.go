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
for t in systemctl journalctl systemd-run tar gzip sha256sum ip curl wget; do
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
if [ -r /proc/cpuinfo ]; then
  emit cpu_cores "$( (nproc || grep -c '^processor' /proc/cpuinfo) 2>/dev/null )"
fi
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{
    if (t>0) {
      if (a=="" || a==0) a=f+b+c;
      printf "mem_total_kb=%s\nmem_avail_kb=%s\n", t, a
    }
  }' /proc/meminfo
fi
if [ -r /proc/stat ]; then
  s1="$(head -n1 /proc/stat 2>/dev/null)"
  (sleep 0.25 2>/dev/null || sleep 1)
  s2="$(head -n1 /proc/stat 2>/dev/null)"
  emit cpu_stat_1 "$s1"
  emit cpu_stat_2 "$s2"
fi
`

const metricsScript = `set +e
emit() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ')"; }
if [ -r /proc/cpuinfo ]; then
  emit cpu_cores "$( (nproc || grep -c '^processor' /proc/cpuinfo) 2>/dev/null )"
fi
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{
    if (t>0) {
      if (a=="" || a==0) a=f+b+c;
      printf "mem_total_kb=%s\nmem_avail_kb=%s\n", t, a
    }
  }' /proc/meminfo
fi
if [ -r /proc/stat ]; then
  s1="$(head -n1 /proc/stat 2>/dev/null)"
  (sleep 0.25 2>/dev/null || sleep 1)
  s2="$(head -n1 /proc/stat 2>/dev/null)"
  emit cpu_stat_1 "$s1"
  emit cpu_stat_2 "$s2"
fi
`

// NodeMetrics holds CPU and memory utilization collected from a host.
type NodeMetrics struct {
	CPUCores      int     `json:"cpu_cores"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemTotalBytes int64   `json:"mem_total_bytes"`
	MemUsedBytes  int64   `json:"mem_used_bytes"`
	MemPercent    float64 `json:"mem_percent"`
}

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
	CPUCores       int               `json:"cpu_cores"`
	CPUPercent     float64           `json:"cpu_percent"`
	MemTotalBytes  int64             `json:"mem_total_bytes"`
	MemUsedBytes   int64             `json:"mem_used_bytes"`
	MemPercent     float64           `json:"mem_percent"`
	Tools          map[string]bool   `json:"tools"`
	Missing        []string          `json:"missing_tools"`
}

// CollectMetrics gathers lightweight CPU and memory utilization from c.
func CollectMetrics(ctx context.Context, c *Client) (*NodeMetrics, error) {
	res, err := c.Run(ctx, metricsScript, RunOptions{})
	if err != nil {
		return nil, err
	}
	raw := parseKV(string(res.Stdout))
	m := parseMetrics(raw)
	return &m, nil
}

func parseKV(out string) map[string]string {
	raw := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok {
			raw[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return raw
}

func parseMetrics(raw map[string]string) NodeMetrics {
	m := NodeMetrics{CPUPercent: -1, MemPercent: -1}
	if c, err := strconv.Atoi(raw["cpu_cores"]); err == nil && c > 0 {
		m.CPUCores = c
	}
	if totalKB, err := strconv.ParseInt(raw["mem_total_kb"], 10, 64); err == nil && totalKB > 0 {
		availKB, _ := strconv.ParseInt(raw["mem_avail_kb"], 10, 64)
		if availKB < 0 {
			availKB = 0
		}
		if availKB > totalKB {
			availKB = totalKB
		}
		m.MemTotalBytes = totalKB * 1024
		m.MemUsedBytes = (totalKB - availKB) * 1024
		m.MemPercent = float64(totalKB-availKB) * 100.0 / float64(totalKB)
	}
	if pct, ok := cpuPercentFromProcStat(raw["cpu_stat_1"], raw["cpu_stat_2"]); ok {
		m.CPUPercent = pct
	}
	return m
}

func cpuPercentFromProcStat(s1, s2 string) (float64, bool) {
	parseLine := func(line string) (total, idle uint64, ok bool) {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			return 0, 0, false
		}
		var nums []uint64
		for _, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return 0, 0, false
			}
			nums = append(nums, v)
			total += v
		}
		idle = nums[3]
		if len(nums) > 4 {
			idle += nums[4] // iowait
		}
		return total, idle, true
	}
	t1, i1, ok1 := parseLine(s1)
	t2, i2, ok2 := parseLine(s2)
	if !ok1 || !ok2 || t2 <= t1 {
		return 0, false
	}
	dt := float64(t2 - t1)
	di := float64(0)
	if i2 > i1 {
		di = float64(i2 - i1)
	}
	pct := (dt - di) * 100.0 / dt
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, true
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
	raw := parseKV(out)
	m := parseMetrics(raw)
	p := &ProbeResult{
		Raw: raw, Tools: map[string]bool{},
		CPUCores: m.CPUCores, CPUPercent: m.CPUPercent,
		MemTotalBytes: m.MemTotalBytes, MemUsedBytes: m.MemUsedBytes, MemPercent: m.MemPercent,
	}
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
	// Optional tools: required only by some roles (ip for Nomad clients,
	// curl or wget for the image pull proxy test).
	for _, t := range []string{"ip", "curl", "wget"} {
		p.Tools[t] = raw["has_"+t] == "1"
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
