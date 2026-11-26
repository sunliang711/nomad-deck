package integration

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"

	"nomad-deck/internal/nomad"
)

func TestRenderPolicyAndRole(t *testing.T) {
	explicit := RoleSpec{Name: "web", Policy: "p-web", Mode: "explicit", SecretPaths: []string{"secret/apps/web", "kv/shared/db"},
		BoundClaims: map[string]string{"nomad_namespace": "prod", "nomad_job_id": "web"}, TokenPeriod: "1h"}
	p := RenderPolicy(explicit, "auth_jwt_123")
	for _, want := range []string{`path "secret/data/apps/web"`, `path "secret/metadata/apps/web"`, `path "kv/data/shared/db"`} {
		if !strings.Contains(p, want) {
			t.Errorf("explicit policy lacks %s:\n%s", want, p)
		}
	}
	tpl := RoleSpec{Name: "all", Policy: "p-all", Mode: "templated", BoundClaims: map[string]string{"nomad_namespace": "prod"}}
	tp := RenderPolicy(tpl, "auth_jwt_123")
	if !strings.Contains(tp, "secret/data/{{identity.entity.aliases.auth_jwt_123.metadata.nomad_namespace}}/{{identity.entity.aliases.auth_jwt_123.metadata.nomad_job_id}}") {
		t.Errorf("templated policy:\n%s", tp)
	}
	for _, src := range []string{p, tp} {
		if _, diags := hclsyntax.ParseConfig([]byte(src), "p.hcl", hcl.InitialPos); diags.HasErrors() {
			t.Fatalf("policy does not parse: %s\n%s", diags.Error(), src)
		}
	}
	role := RenderRole(explicit, []string{"vault.io"})
	if role["role_type"] != "jwt" || role["user_claim_json_pointer"] != true || role["user_claim"] != "/sub" ||
		role["bound_claims"].(map[string]any)["nomad_namespace"] != "prod" {
		t.Fatalf("role: %v", role)
	}
}

func TestRoleValidation(t *testing.T) {
	in := RoleInput{RoleName: "web", SecretPaths: []string{"secret/apps/web"}, BoundClaims: map[string]string{"nomad_job_id": "web"}}
	if err := in.validate("prod"); err == nil {
		t.Fatal("bound_claims without nomad_namespace must be rejected")
	}
	in.BoundClaims["nomad_namespace"] = "prod"
	if err := in.validate("prod"); err != nil || in.PolicyName != "nomad-prod-web" || in.TokenPeriod != "1h" {
		t.Fatalf("defaults: %+v %v", in, err)
	}
	in.SecretPaths = []string{"secret/../sys"}
	if err := in.validate("prod"); err == nil {
		t.Fatal("path traversal must be rejected")
	}
}

func TestJWKSToPEM(t *testing.T) {
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	enc := base64.RawURLEncoding
	doc, _ := json.Marshal(map[string]any{"keys": []any{
		map[string]any{"kid": "r1", "kty": "RSA", "n": enc.EncodeToString(rk.N.Bytes()), "e": enc.EncodeToString(big.NewInt(int64(rk.E)).Bytes())},
		map[string]any{"kid": "e1", "kty": "OKP", "crv": "Ed25519", "x": enc.EncodeToString(pub)},
	}})
	keys, err := JWKSToPEM(doc)
	if err != nil || len(keys) != 2 || !strings.Contains(keys["r1"], "PUBLIC KEY") {
		t.Fatalf("keys: %v %v", keys, err)
	}
}

// The rendered vault block must be accepted by "nomad config validate"
// next to the rest of the managed configuration, for every role.
func TestNomadVaultBlockValidates(t *testing.T) {
	bin, err := exec.LookPath("nomad")
	if err != nil || testing.Short() {
		t.Skip("nomad binary not available")
	}
	vs := VaultSide{Address: "https://vault.example.com:8200", AuthPath: "jwt-nomad-prod", Audience: []string{"vault.io"}, TTL: "1h", HasCA: true}
	for _, role := range []string{nomad.RoleServer, nomad.RoleClient, nomad.RoleServerClient} {
		dir := t.TempDir()
		files, err := nomad.RenderFiles(nomad.NodeConfig{Region: "global", Datacenter: "dc1", NodeName: "n1", Role: role,
			Advertise: "10.0.0.1", HTTPPort: 4646, RPCPort: 4647, SerfPort: 4648, Generation: 1, Servers: []string{"10.0.0.1"},
			BootstrapN: 1, TLS: true, Extra: map[string]string{"60-vault.hcl": RenderNomadVault(vs, role, dir+"/vault-ca.crt")}})
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range files {
			c := strings.ReplaceAll(string(f.Content), nomad.GenerationDir(1), dir)
			c = strings.ReplaceAll(c, nomad.DataDir, filepath.Join(dir, "data"))
			if err := os.WriteFile(filepath.Join(dir, f.Name), []byte(c), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if out, err := exec.Command(bin, "config", "validate", dir).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v\n%s\n%s", role, err, out, RenderNomadVault(vs, role, "x"))
		}
	}
	a := NomadSHA256(vs, "ca1")
	vs.Address = "https://other:8200"
	if a == NomadSHA256(vs, "ca1") || NomadSHA256(vs, "ca1") == NomadSHA256(vs, "ca2") {
		t.Fatal("digest must change with the Vault address and the CA bundle")
	}
}

func TestJobExampleWithOptions(t *testing.T) {
	role := RoleSpec{
		Name:        "postgres",
		Mode:        "explicit",
		SecretPaths: []string{"secret/apps/postgres"},
		BoundClaims: map[string]string{"nomad_namespace": "default"},
	}

	probe := JobExampleWithOptions(role, JobExampleOptions{SecretPath: "secret/apps/postgres", TemplateKind: "probe"})
	if !strings.Contains(probe, `secret "secret/data/apps/postgres"`) || !strings.Contains(probe, `role = "postgres"`) || !strings.Contains(probe, `driver = "docker"`) {
		t.Fatalf("probe HCL unexpected:\n%s", probe)
	}

	envJob := JobExampleWithOptions(role, JobExampleOptions{
		SecretPath:   "secret/apps/postgres",
		TemplateKind: "docker_env",
		SecretKeys:   []string{"username", "password"},
	})
	if !strings.Contains(envJob, `env         = true`) || !strings.Contains(envJob, `USERNAME={{ .Data.data.username | toJSON }}`) {
		t.Fatalf("docker_env HCL unexpected:\n%s", envJob)
	}

	fileJob := JobExampleWithOptions(role, JobExampleOptions{
		SecretPath:   "secret/apps/postgres",
		TemplateKind: "docker_file",
		SecretKeys:   []string{"username", "password"},
	})
	if !strings.Contains(fileJob, `APP_SECRET_FILE = "/secrets/app.secret"`) ||
		!strings.Contains(fileJob, `perms       = "0600"`) ||
		!strings.Contains(fileJob, `index .Data.data "password"`) {
		t.Fatalf("docker_file HCL unexpected:\n%s", fileJob)
	}
}
