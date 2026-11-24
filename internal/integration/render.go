// Package integration links a Nomad cluster to a Vault cluster through
// Nomad workload identities: a dedicated JWT auth mount on Vault that
// trusts the Nomad JWKS endpoint (and the Nomad CA), least-privilege
// workload roles and policies, and the Nomad vault block with the Vault CA,
// with plan, apply, teardown and an end-to-end Doctor.
package integration

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"nomad-deck/internal/nomad"
)

// Config is stored in cluster_integrations.config_json.
type Config struct {
	Audience    []string `json:"aud"`
	JWKSMode    string   `json:"jwks_mode"` // url | static
	JWKSURL     string   `json:"jwks_url,omitempty"`
	VaultAddr   string   `json:"vault_address,omitempty"`
	DefaultRole string   `json:"default_role,omitempty"`
	IdentityTTL string   `json:"identity_ttl"`
	// StaticKeys are the PEM public keys written in static mode, kept
	// while tokens signed by them may still be valid.
	StaticKeys []StaticKey `json:"static_keys,omitempty"`
}

// StaticKey is one Nomad signing key published to Vault in static mode.
type StaticKey struct {
	KeyID    string `json:"kid"`
	PEM      string `json:"pem"`
	LastSeen string `json:"last_seen"`
}

func (c *Config) defaults() {
	if len(c.Audience) == 0 {
		c.Audience = []string{"vault.io"}
	}
	if c.JWKSMode == "" {
		c.JWKSMode = "url"
	}
	if c.IdentityTTL == "" {
		c.IdentityTTL = "1h"
	}
}

// RoleSpec is a workload role ready to render.
type RoleSpec struct {
	Name        string
	Policy      string
	Mode        string   // explicit | templated
	SecretPaths []string // explicit: "<kv mount>/<path>"; templated: KV mounts
	CustomHCL   string
	BoundClaims map[string]string
	TokenPeriod string
}

// RenderPolicy renders a role's Vault policy (default deny: only the
// listed KV v2 paths are readable). accessor is the JWT mount accessor
// used by templated policies.
func RenderPolicy(r RoleSpec, accessor string) string {
	if strings.TrimSpace(r.CustomHCL) != "" {
		return r.CustomHCL
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# Managed by NomadDeck: workload role %s\n", r.Name)
	switch r.Mode {
	case "templated":
		mounts := r.SecretPaths
		if len(mounts) == 0 {
			mounts = []string{"secret"}
		}
		meta := func(k string) string {
			return fmt.Sprintf("{{identity.entity.aliases.%s.metadata.%s}}", accessor, k)
		}
		for _, mnt := range mounts {
			base := meta("nomad_namespace") + "/" + meta("nomad_job_id")
			fmt.Fprintf(&b, "\npath %q {\n  capabilities = [\"read\"]\n}\n", mnt+"/data/"+base)
			fmt.Fprintf(&b, "\npath %q {\n  capabilities = [\"read\"]\n}\n", mnt+"/data/"+base+"/*")
			fmt.Fprintf(&b, "\npath %q {\n  capabilities = [\"read\", \"list\"]\n}\n", mnt+"/metadata/"+base+"/*")
		}
	default:
		for _, p := range r.SecretPaths {
			mnt, rest, _ := strings.Cut(strings.Trim(p, "/"), "/")
			fmt.Fprintf(&b, "\npath %q {\n  capabilities = [\"read\"]\n}\n", mnt+"/data/"+rest)
			fmt.Fprintf(&b, "\npath %q {\n  capabilities = [\"read\", \"list\"]\n}\n", mnt+"/metadata/"+rest)
		}
	}
	return b.String()
}

// RenderRole renders the JWT role: role_type jwt, a JSON-pointer user claim
// (the sub claim carries the namespace, so same-named jobs in different
// namespaces never share an entity alias), mandatory bound claims, the
// audience, claim mappings and the token period.
func RenderRole(r RoleSpec, aud []string) map[string]any {
	bound := map[string]any{}
	for k, v := range r.BoundClaims {
		bound[k] = v
	}
	return map[string]any{
		"role_type":               "jwt",
		"bound_audiences":         aud,
		"user_claim":              "/sub",
		"user_claim_json_pointer": true,
		"bound_claims":            bound,
		"bound_claims_type":       "string",
		"claim_mappings": map[string]string{"nomad_namespace": "nomad_namespace", "nomad_job_id": "nomad_job_id",
			"nomad_task": "nomad_task"},
		"token_type":     "service",
		"token_policies": []string{r.Policy},
		"token_period":   r.TokenPeriod,
	}
}

// VaultSide is the Nomad vault block input.
type VaultSide struct {
	Address  string
	AuthPath string
	Audience []string
	TTL      string
	HasCA    bool
}

// RenderNomadVault renders 60-vault.hcl for a role. caPath is the absolute
// path of the Vault CA inside the generation directory. The vault block is
// disabled by default in Nomad, so both sides set enabled = true.
func RenderNomadVault(v VaultSide, role, caPath string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\nvault {\n  enabled = true\n", nomad.ManagedMark)
	if nomad.IsClient(role) {
		fmt.Fprintf(&b, "  address               = %q\n", v.Address)
		fmt.Fprintf(&b, "  jwt_auth_backend_path = %q\n", v.AuthPath)
		if v.HasCA {
			fmt.Fprintf(&b, "  ca_file               = %q\n", caPath)
		}
	}
	if nomad.IsServer(role) {
		q := make([]string, len(v.Audience))
		for i, a := range v.Audience {
			q[i] = strconv.Quote(a)
		}
		fmt.Fprintf(&b, "\n  default_identity {\n    aud = [%s]\n    ttl = %q\n  }\n", strings.Join(q, ", "), v.TTL)
	}
	fmt.Fprintf(&b, "}\n")
	return b.String()
}

// NomadSHA256 is the digest of the Nomad-side content (both roles and the
// CA bundle), independent of generation numbers: an Apply only restarts
// Nomad when it changes.
func NomadSHA256(v VaultSide, caBundle string) string {
	h := sha256.New()
	for _, role := range []string{nomad.RoleServer, nomad.RoleClient, nomad.RoleServerClient} {
		h.Write([]byte(RenderNomadVault(v, role, "<generation>/tls/vault-ca.crt")))
	}
	h.Write([]byte(caBundle))
	return hex.EncodeToString(h.Sum(nil))
}

// jwk is a JSON Web Key as published by Nomad.
type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	N   string `json:"n"`
	E   string `json:"e"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// JWKSToPEM converts a JWKS document to PEM public keys keyed by kid.
func JWKSToPEM(doc []byte) (map[string]string, error) {
	var set struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(doc, &set); err != nil {
		return nil, err
	}
	out := map[string]string{}
	dec := base64.RawURLEncoding
	for _, k := range set.Keys {
		var pub any
		switch k.Kty {
		case "RSA":
			n, err1 := dec.DecodeString(k.N)
			e, err2 := dec.DecodeString(k.E)
			if err1 != nil || err2 != nil {
				return nil, errors.New("invalid RSA key")
			}
			pub = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		case "OKP":
			x, err := dec.DecodeString(k.X)
			if err != nil || k.Crv != "Ed25519" || len(x) != ed25519.PublicKeySize {
				return nil, errors.New("invalid OKP key")
			}
			pub = ed25519.PublicKey(x)
		case "EC":
			x, err1 := dec.DecodeString(k.X)
			y, err2 := dec.DecodeString(k.Y)
			if err1 != nil || err2 != nil || k.Crv != "P-256" {
				return nil, errors.New("invalid EC key")
			}
			pub = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		default:
			continue
		}
		der, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			return nil, err
		}
		out[k.Kid] = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	}
	if len(out) == 0 {
		return nil, errors.New("JWKS 中没有可用的公钥")
	}
	return out, nil
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// JobExample renders a test job that logs in with a role and reads a KV path.
func JobExample(r RoleSpec, secretPath string) string {
	ns := r.BoundClaims["nomad_namespace"]
	job := r.BoundClaims["nomad_job_id"]
	if job == "" {
		job = "vault-probe"
	}
	var tpl string
	if secretPath != "" {
		mnt, rest, _ := strings.Cut(strings.Trim(secretPath, "/"), "/")
		tpl = fmt.Sprintf(`
      template {
        destination = "secrets/app.env"
        env         = true
        data        = <<EOT
{{ with secret "%s/data/%s" }}{{ range $k, $v := .Data.data }}{{ $k }}={{ $v }}
{{ end }}{{ end }}
EOT
      }
`, mnt, rest)
	}
	return fmt.Sprintf(`job %q {
  namespace = %q
  type      = "batch"

  group "probe" {
    task "read" {
      driver = "raw_exec"

      config {
        command = "/bin/sh"
        args    = ["-c", "test -s \"${NOMAD_SECRETS_DIR}/vault_token\" && echo vault login ok"]
      }

      vault {
        role = %q
      }
%s    }
  }
}
`, job, ns, r.Name, tpl)
}
