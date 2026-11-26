package sshx

import (
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestQuoteRoundTripsThroughShell(t *testing.T) {
	for _, s := range []string{"plain", "with space", "it's", `$(rm -rf /)`, "a\nb", `"; echo pwned`} {
		out, err := exec.Command("/bin/sh", "-c", "printf %s "+Quote(s)).Output()
		if err != nil || string(out) != s {
			t.Errorf("quote %q -> %q (%v)", s, out, err)
		}
	}
}

func TestValidators(t *testing.T) {
	good := map[string]func(string) error{"1.9.3": ValidVersion, "01JABC-step_1": ValidIdent, "/opt/nomad-deck/nomad/bin": ValidPath,
		"nomad-deck-op-X-1": ValidUnit}
	for v, f := range good {
		if err := f(v); err != nil {
			t.Errorf("%q should be valid: %v", v, err)
		}
	}
	bad := map[string]func(string) error{"1.9": ValidVersion, "a b": ValidIdent, "/opt/../etc": ValidPath, "relative": ValidPath,
		"/opt/x;rm": ValidPath, "x$(id)": ValidUnit, "ABC": ValidSHA256}
	for v, f := range bad {
		if err := f(v); err == nil {
			t.Errorf("%q should be invalid", v)
		}
	}
}

func TestParseProbe(t *testing.T) {
	out := `uid=1000
kernel=6.8.0-45-generic
arch=x86_64
os_id=ubuntu
os_id_like=debian
os_version_id=24.04
os_codename=noble
os_pretty=Ubuntu 24.04.1 LTS
has_systemctl=1
has_journalctl=1
has_systemd-run=1
has_tar=1
has_gzip=1
has_sha256sum=0
package_manager=apt-get
sudo=ok
selinux=disabled
swap_entries=1
swap_crypt=0
machine_id=0123456789abcdef0123456789abcdef
product_uuid=EC234567-89AB-CDEF-0123-456789ABCDEF
mac_addrs=52:54:00:11:22:33,52:54:00:AA:BB:CC,52:54:00:11:22:33,00:00:00:00:00:00
epoch=1700000010.500000000
ntp_synced=yes
docker_installed=1
docker_version=Docker version 27.3.1, build ce12230
docker_active=active
docker_pkg=docker.io
opt_writable=1
`
	p := ParseProbe(out, time.Unix(1700000010, 0))
	if p.Arch != "amd64" || p.OSFamily != "debian" || p.OSCodename != "noble" || p.PackageManager != "apt" {
		t.Fatalf("os: %+v", p)
	}
	if !p.SudoReady || p.IsRoot || !p.SwapEnabled || p.SwapEncrypted || p.TimeSync != "synced" {
		t.Fatalf("flags: %+v", p)
	}
	if p.ClockSkewMS != 500 {
		t.Fatalf("skew %d", p.ClockSkewMS)
	}
	if p.DockerMode != "external" || p.DockerStatus != "running" || p.DockerVersion != "27.3.1" {
		t.Fatalf("docker: %+v", p)
	}
	if strings.Join(p.Missing, ",") != "sha256sum" {
		t.Fatalf("missing: %v", p.Missing)
	}
	if p.ProductUUID != "ec234567-89ab-cdef-0123-456789abcdef" {
		t.Fatalf("product_uuid: %q", p.ProductUUID)
	}
	if strings.Join(p.MACAddrs, ",") != "52:54:00:11:22:33,52:54:00:aa:bb:cc" {
		t.Fatalf("mac_addrs: %v", p.MACAddrs)
	}

	rhel := ParseProbe("arch=aarch64\nos_id=rocky\nos_id_like=rhel centos fedora\nos_version_id=9.4\nsudo=root\ndocker_installed=0\n", time.Time{})
	if rhel.Arch != "arm64" || rhel.OSFamily != "rhel" || rhel.OSCodename != "9" || !rhel.IsRoot || rhel.DockerMode != "absent" {
		t.Fatalf("rhel: %+v", rhel)
	}
}

func TestParseProbeScriptRunsLocally(t *testing.T) {
	out, err := exec.Command("/bin/sh", "-c", probeScript).Output()
	if err != nil {
		t.Fatalf("probe script must be valid sh: %v", err)
	}
	if !strings.Contains(string(out), "uid=") || !strings.Contains(string(out), "opt_writable=") {
		t.Fatalf("unexpected output: %s", out)
	}
}
