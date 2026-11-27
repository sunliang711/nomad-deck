package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

func TestMultiNomadSingleVaultAndSpecificConflicts(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{9}, 32))
	s := &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Log: log}

	now := time.Now()
	insertCluster := func(id, name, kind string) {
		if err := db.InsertCluster(ctx, d.Writer, &db.Cluster{
			ID: id, Name: name, Type: kind, Mode: "single", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	insertCluster("n1", "nomad-a", "nomad")
	insertCluster("n2", "nomad-b", "nomad")
	insertCluster("v1", "vault-main", "vault")
	actor := audit.Actor{Name: "tester"}

	v1, err := s.Create(ctx, actor, Input{Name: "nomad-a-vault", SourceClusterID: "n1", TargetClusterID: "v1", AuthPath: "jwt-nomad"})
	if err != nil {
		t.Fatalf("first integration: %v", err)
	}
	if v1.AuthPath != "jwt-nomad" {
		t.Fatalf("unexpected auth path: %s", v1.AuthPath)
	}

	// Second Nomad cluster pointing at the same Vault with empty auth_path auto-derives a unique path.
	v2, err := s.Create(ctx, actor, Input{Name: "nomad-b-vault", SourceClusterID: "n2", TargetClusterID: "v1"})
	if err != nil {
		t.Fatalf("second Nomad on same Vault must succeed: %v", err)
	}
	if v2.AuthPath != "jwt-nomad-nomad-b" {
		t.Fatalf("unexpected auto auth path: %s", v2.AuthPath)
	}

	// Duplicate source cluster gives specific source-bound error.
	if _, err := s.Create(ctx, actor, Input{Name: "dup-src", SourceClusterID: "n1", TargetClusterID: "v1", AuthPath: "jwt-other"}); err == nil || !strings.Contains(err.Error(), "nomad-a") {
		t.Fatalf("expected source-bound error mentioning nomad-a, got: %v", err)
	}

	// Duplicate name gives specific name error.
	insertCluster("n3", "nomad-c", "nomad")
	if _, err := s.Create(ctx, actor, Input{Name: "nomad-a-vault", SourceClusterID: "n3", TargetClusterID: "v1", AuthPath: "jwt-c"}); err == nil || !strings.Contains(err.Error(), "联动名称") {
		t.Fatalf("expected name-taken error, got: %v", err)
	}

	// Duplicate (target_cluster_id, auth_path) gives specific auth_path error.
	if _, err := s.Create(ctx, actor, Input{Name: "nomad-c-vault", SourceClusterID: "n3", TargetClusterID: "v1", AuthPath: "jwt-nomad"}); err == nil || !strings.Contains(err.Error(), "Auth 路径") {
		t.Fatalf("expected auth-path-taken error, got: %v", err)
	}
}

func TestIntegrationCAConfigDrift(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "drift.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{9}, 32))
	s := &Service{DB: d, Keys: keys, Audit: &audit.Recorder{DB: d, Log: log}, Log: log}

	now := time.Now()
	nomadCl := &db.Cluster{
		ID: "n1", Name: "nomad-1", Type: "nomad", Mode: "single",
		TLSEnabled: true, CACertPEM: "NOMAD-CA-V1", PublicAPIURL: "https://10.0.0.1:4646",
		CreatedAt: now, UpdatedAt: now,
	}
	vaultCl := &db.Cluster{
		ID: "v1", Name: "vault-1", Type: "vault", Mode: "single",
		TLSEnabled: true, CACertPEM: "VAULT-CA-V1", PublicAPIURL: "https://10.0.0.2:8200",
		CreatedAt: now, UpdatedAt: now,
	}
	if err := db.InsertCluster(ctx, d.Writer, nomadCl); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertCluster(ctx, d.Writer, vaultCl); err != nil {
		t.Fatal(err)
	}

	view, err := s.Create(ctx, audit.Actor{Name: "tester"}, Input{
		Name: "nv", SourceClusterID: "n1", TargetClusterID: "v1", AuthPath: "jwt-nomad",
	})
	if err != nil {
		t.Fatal(err)
	}

	l, err := s.load(ctx, view.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, vaultAddr, _, err := s.addresses(ctx, l)
	if err != nil {
		t.Fatal(err)
	}
	l.Status = "applied"
	l.NomadSideEnabled = true
	l.NomadConfigSHA256 = NomadSHA256(s.vaultSide(l, vaultAddr), vaultCl.CACertPEM)
	l.cfg.AppliedJWKSURL = "https://10.0.0.1:4646/.well-known/jwks.json"
	l.cfg.AppliedJWKSCASHA256 = caSHA256(nomadCl.CACertPEM)
	b, _ := json.Marshal(l.cfg)
	l.ConfigJSON = string(b)
	if err := db.UpdateIntegrationConfig(ctx, d.Writer, l.Integration, now); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateIntegrationState(ctx, d.Writer, l.Integration, now); err != nil {
		t.Fatal(err)
	}

	// Clean state must report zero drift.
	got, err := s.Get(ctx, view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ConfigDrifted || len(got.DriftReasons) != 0 {
		t.Fatalf("expected zero drift when CAs match, got: %+v", got)
	}

	// Simulate Vault CA reset/rotation without Nomad updating.
	vaultCl.CACertPEM = "VAULT-CA-V2"
	if err := db.UpdateClusterTLS(ctx, d.Writer, vaultCl, now); err != nil {
		t.Fatal(err)
	}
	got, err = s.Get(ctx, view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.ConfigDrifted || !strings.Contains(strings.Join(got.DriftReasons, "\n"), "Vault 集群 CA") {
		t.Fatalf("expected Vault CA drift, got: %+v", got)
	}

	// Simulate Nomad CA change too.
	nomadCl.CACertPEM = "NOMAD-CA-V2"
	if err := db.UpdateClusterTLS(ctx, d.Writer, nomadCl, now); err != nil {
		t.Fatal(err)
	}
	got, err = s.Get(ctx, view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.ConfigDrifted || len(got.DriftReasons) != 2 || !strings.Contains(strings.Join(got.DriftReasons, "\n"), "Nomad 集群 CA") {
		t.Fatalf("expected both Vault and Nomad CA drift reasons, got: %+v", got)
	}
}
