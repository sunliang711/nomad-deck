package vault

import (
	"strings"
	"testing"
)

func TestRenderConfig(t *testing.T) {
	c := NodeConfig{ClusterName: "prod", RaftNodeID: "n1", Advertise: "10.0.0.11", APIPort: 8200, ClusterPort: 8201, TLS: true,
		Generation: 3, Peers: []string{"https://10.0.0.12:8200"}, Version: "1.21.1"}
	out := RenderConfig(c)
	for _, want := range []string{"disable_mlock = true", `api_addr      = "https://10.0.0.11:8200"`,
		`tls_cert_file   = "/opt/nomad-deck/vault/etc/releases/3/tls/server.crt"`,
		`leader_ca_cert_file = "/opt/nomad-deck/vault/etc/releases/3/tls/ca.crt"`, `node_id = "n1"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, "enable_unauthenticated_access") {
		t.Error("Vault 1.x configs must not set enable_unauthenticated_access")
	}
	if err := ValidateHCL("config.hcl", out); err != nil {
		t.Fatal(err)
	}
	c.Version, c.Advertise = "2.1.2", "fd00::11"
	out = RenderConfig(c)
	if !strings.Contains(out, `enable_unauthenticated_access = ["generate-root"]`) || !strings.Contains(out, "https://[fd00::11]:8200") {
		t.Fatalf("Vault 2.x / IPv6 config:\n%s", out)
	}
	if err := ValidateHCL("config.hcl", out); err != nil {
		t.Fatal(err)
	}
}
