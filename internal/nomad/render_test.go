package nomad

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func boolPtr(v bool) *bool { return &v }

func sampleConfig(role string) NodeConfig {
	return NodeConfig{Region: "global", Datacenter: "dc1", NodeName: "n1", Role: role, Advertise: "10.0.0.11",
		HTTPPort: 4646, RPCPort: 4647, SerfPort: 4648, Generation: 3, Servers: []string{"10.0.0.11", "10.0.0.12", "10.0.0.13"},
		BootstrapN: 3, GossipKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", TLS: true, Telemetry: true,
		TelemetryOptions: TelemetrySettings{
			CollectionInterval:       "1s",
			DisableHostname:          boolPtr(false),
			PrometheusMetrics:        boolPtr(true),
			PublishAllocationMetrics: boolPtr(true),
			PublishNodeMetrics:       boolPtr(true),
		},
		JobGC:    "4h",
		UI:       UISettings{Label: "prod", LabelBG: "red"}, NodePool: "default", Meta: map[string]string{"rack": "r1"},
		HostVolumes: []HostVolume{{Name: "data", Path: "/srv/data"}},
		HostNetworks: []HostNetwork{
			{Name: "loopback", CIDR: "127.0.0.1/32"},
			{Name: "private", Interface: "lo0", ReservedPorts: "22,80-85"},
		},
		Docker: DockerDriver{
			AllowPrivileged: true,
			Volumes:         true,
			ImageGCDelay:    "100h",
			DanglingContainers: &DanglingContainersGC{
				Enabled:       true,
				DryRun:        false,
				Period:        "10m",
				CreationGrace: "10m",
			},
			ExtraLabels: []string{"job_name", "task_group_name", "task_name", "namespace", "node_name", "short_alloc_id"},
		},
		RawExec: true, Denylist: []string{"java"}, CNI: true, CPUTotal: 4000,
		Extra: map[string]string{"60-vault.hcl": "# Managed by NomadDeck\nvault {\n  enabled = true\n}\n"}}
}

func TestRenderFiles(t *testing.T) {
	for _, role := range []string{RoleServer, RoleClient, RoleServerClient} {
		files, err := RenderFiles(sampleConfig(role))
		if err != nil {
			t.Fatal(role, err)
		}
		names := map[string]string{}
		for _, f := range files {
			names[f.Name] = string(f.Content)
			if !strings.HasPrefix(string(f.Content), ManagedMark) {
				t.Errorf("%s/%s lacks the managed marker", role, f.Name)
			}
		}
		base := names["10-base.hcl"]
		if IsServer(role) != strings.Contains(base, "server {") || IsClient(role) != strings.Contains(base, "client {") {
			t.Errorf("%s: wrong role blocks in base:\n%s", role, base)
		}
		if IsServer(role) && strings.Contains(base, `retry_join = ["10.0.0.11:4648"`) {
			t.Errorf("server joins itself")
		}
		if _, ok := names["80-docker.hcl"]; ok != IsClient(role) {
			t.Errorf("%s: docker fragment presence wrong", role)
		}
		if IsClient(role) {
			if !strings.Contains(names["71-host-network-loopback.hcl"], `host_network "loopback"`) ||
				!strings.Contains(names["71-host-network-loopback.hcl"], `cidr           = "127.0.0.1/32"`) {
				t.Errorf("%s: missing loopback host_network:\n%s", role, names["71-host-network-loopback.hcl"])
			}
			dockerHCL := names["80-docker.hcl"]
			for _, want := range []string{"dangling_containers {", `period         = "10m"`, `creation_grace = "10m"`, `extra_labels = ["job_name"`} {
				if !strings.Contains(dockerHCL, want) {
					t.Errorf("%s: docker hcl missing %q:\n%s", role, want, dockerHCL)
				}
			}
		} else if _, ok := names["71-host-network-loopback.hcl"]; ok {
			t.Errorf("%s: server should not render host_network", role)
		}
		if !strings.Contains(names["40-telemetry.hcl"], `collection_interval        = "1s"`) ||
			!strings.Contains(names["40-telemetry.hcl"], `disable_hostname           = false`) {
			t.Errorf("%s: telemetry fragment mismatch:\n%s", role, names["40-telemetry.hcl"])
		}
		if _, ok := names["35-ui.hcl"]; ok != IsServer(role) {
			t.Errorf("%s: ui fragment presence wrong", role)
		}
		if !strings.Contains(names["30-tls.hcl"], GenerationDir(3)+"/tls/agent.pem") ||
			!strings.Contains(names["30-tls.hcl"], "verify_https_client    = false") {
			t.Errorf("tls fragment: %s", names["30-tls.hcl"])
		}
	}
	if RunUser(RoleServer) != "nomad" || RunUser(RoleClient) != "root" || RunUser(RoleServerClient) != "root" {
		t.Error("run user by role")
	}
	cniScript := CNIInstallScript("/tmp/cni.tgz")
	for _, want := range []string{ModulesLoadFile, SysctlFile, "br_netfilter", "net.bridge.bridge-nf-call-iptables = 1"} {
		if !strings.Contains(cniScript, want) {
			t.Errorf("CNIInstallScript missing %q", want)
		}
	}
}

// TestRenderedConfigValidates runs the real "nomad config validate" on the
// rendered fragments (TLS paths rewritten to a temp directory).
func TestRenderedConfigValidates(t *testing.T) {
	bin, err := exec.LookPath("nomad")
	if err != nil || testing.Short() {
		t.Skip("nomad binary not available")
	}
	for _, role := range []string{RoleServer, RoleClient, RoleServerClient} {
		dir := t.TempDir()
		files, err := RenderFiles(sampleConfig(role))
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			c := strings.ReplaceAll(string(f.Content), GenerationDir(3), dir)
			c = strings.ReplaceAll(c, DataDir, filepath.Join(dir, "data"))
			if err := os.WriteFile(filepath.Join(dir, f.Name), []byte(c), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		out, err := exec.Command(bin, "config", "validate", dir).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: nomad config validate: %v\n%s", role, err, out)
		}
	}
}
