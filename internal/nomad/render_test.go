package nomad

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func sampleConfig(role string) NodeConfig {
	return NodeConfig{Region: "global", Datacenter: "dc1", NodeName: "n1", Role: role, Advertise: "10.0.0.11",
		HTTPPort: 4646, RPCPort: 4647, SerfPort: 4648, Generation: 3, Servers: []string{"10.0.0.11", "10.0.0.12", "10.0.0.13"},
		BootstrapN: 3, GossipKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", TLS: true, Telemetry: true,
		UI: UISettings{Label: "prod", LabelBG: "red"}, NodePool: "default", Meta: map[string]string{"rack": "r1"},
		HostVolumes: []HostVolume{{Name: "data", Path: "/srv/data"}}, RawExec: true, Denylist: []string{"java"}, CNI: true,
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
