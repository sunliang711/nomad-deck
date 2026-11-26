package hosts

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/sshx"
)

func TestControlPlaneHostColocationAllowedWithWarning(t *testing.T) {
	svc := &Service{LocalMachineID: "cp-machine-123"}
	same := &db.Node{Host: "127.0.0.1", MachineID: "cp-machine-123"}
	other := &db.Node{Host: "10.0.0.12", MachineID: "remote-machine-456"}

	if !svc.IsControlPlaneHost(same) {
		t.Fatal("expected IsControlPlaneHost(same) = true")
	}
	if svc.IsControlPlaneHost(other) {
		t.Fatal("expected IsControlPlaneHost(other) = false")
	}

	probe := &sshx.ProbeResult{
		SudoReady:   true,
		Arch:        "amd64",
		TimeSync:    "synced",
		OptWritable: true,
	}
	warnings := WarningsForHost(same, probe, svc.IsControlPlaneHost(same))
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "与 NomadDeck 控制面同机") {
		t.Fatalf("expected co-location warning, got %v", warnings)
	}
	if !strings.Contains(joined, "回环地址") {
		t.Fatalf("expected loopback warning, got %v", warnings)
	}

	otherWarnings := WarningsForHost(other, probe, svc.IsControlPlaneHost(other))
	if len(otherWarnings) != 0 {
		t.Fatalf("expected no warnings for clean remote node, got %v", otherWarnings)
	}
}

func TestFormatPushKeyError(t *testing.T) {
	mmErr := formatPushKeyError(&sshx.ErrHostKeyMismatch{Expected: "SHA256:a", Actual: "SHA256:b"})
	var ae *auth.Error
	if !errors.As(mmErr, &ae) || ae.Code != "host_key_mismatch" {
		t.Fatalf("expected host_key_mismatch, got %v", mmErr)
	}

	authErr := formatPushKeyError(errors.New("ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain"))
	if !errors.As(authErr, &ae) || ae.Code != "push_key_failed" || !strings.Contains(ae.Message, "手动配置公钥") {
		t.Fatalf("expected friendly auth error, got %v", authErr)
	}

	netErr := formatPushKeyError(errors.New("dial tcp 10.0.0.1:22: i/o timeout"))
	if !errors.As(netErr, &ae) || ae.Code != "push_key_failed" || !strings.Contains(ae.Message, "i/o timeout") {
		t.Fatalf("expected generic push_key_failed, got %v", netErr)
	}
}

func TestCompareHostIdentityAndCloneHandling(t *testing.T) {
	// Different machine_id -> different hosts.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-1", ProductUUID: "u1"},
		HostIdentity{MachineID: "mid-2", ProductUUID: "u2"},
	); got != IdentityDifferent {
		t.Fatalf("expected IdentityDifferent, got %v", got)
	}

	// Same machine_id, different product_uuid (even with identical SSH host key) -> clone.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-shared", ProductUUID: "uuid-a", HostKeyFingerprint: "SHA256:same"},
		HostIdentity{MachineID: "mid-shared", ProductUUID: "uuid-b", HostKeyFingerprint: "SHA256:same"},
	); got != IdentityClone {
		t.Fatalf("expected IdentityClone for differing product_uuid, got %v", got)
	}

	// Same machine_id, same product_uuid -> duplicate host.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-shared", ProductUUID: "UUID-A"},
		HostIdentity{MachineID: "mid-shared", ProductUUID: "uuid-a"},
	); got != IdentitySameHost {
		t.Fatalf("expected IdentitySameHost for matching product_uuid, got %v", got)
	}

	// Same machine_id, no product_uuid, disjoint MACs -> clone.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-shared", MACAddrs: []string{"52:54:00:00:00:01"}},
		HostIdentity{MachineID: "mid-shared", MACAddrs: []string{"52:54:00:00:00:02"}},
	); got != IdentityClone {
		t.Fatalf("expected IdentityClone for disjoint MACs, got %v", got)
	}

	// Same machine_id, no product_uuid, shared MAC -> duplicate host.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-shared", MACAddrs: []string{"52:54:00:00:00:01", "52:54:00:00:00:09"}},
		HostIdentity{MachineID: "mid-shared", MACAddrs: []string{"52:54:00:00:00:09"}},
	); got != IdentitySameHost {
		t.Fatalf("expected IdentitySameHost for shared MAC, got %v", got)
	}

	// Same machine_id, no hardware/MAC signals, differing SSH host key -> clone.
	if got := CompareHostIdentity(
		HostIdentity{MachineID: "mid-shared", HostKeyFingerprint: "SHA256:fp1"},
		HostIdentity{MachineID: "mid-shared", HostKeyFingerprint: "SHA256:fp2"},
	); got != IdentityClone {
		t.Fatalf("expected IdentityClone for differing SSH host keys, got %v", got)
	}

	// Empty machine_id, matching MAC -> duplicate host.
	if got := CompareHostIdentity(
		HostIdentity{MACAddrs: []string{"52:54:00:00:00:01"}},
		HostIdentity{MachineID: "mid-1", MACAddrs: []string{"52:54:00:00:00:01"}},
	); got != IdentitySameHost {
		t.Fatalf("expected IdentitySameHost without machine_id when MAC matches, got %v", got)
	}

	// Control plane clone must not be flagged as co-located.
	cpSvc := &Service{LocalIdentity: HostIdentity{MachineID: "mid-shared", ProductUUID: "uuid-cp", MACAddrs: []string{"52:54:00:00:00:aa"}}}
	cloneProbe, _ := json.Marshal(sshx.ProbeResult{MachineID: "mid-shared", ProductUUID: "uuid-node", MACAddrs: []string{"52:54:00:00:00:bb"}})
	cloneNode := &db.Node{Host: "10.0.0.2", MachineID: "mid-shared", ProbeJSON: string(cloneProbe)}
	if cpSvc.IsControlPlaneHost(cloneNode) {
		t.Fatal("cloned VM should not be treated as control plane host")
	}
}

func TestClassifyExistingPeersAndWarningsForNode(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(t.TempDir(), "hosts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := d.Now()
	if err := db.InsertSSHKey(ctx, d.Writer, &db.SSHKey{
		ID: "k1", Name: "default", Algorithm: "ed25519", PublicKey: "ssh-ed25519 AAAA",
		PrivateKeyEncrypted: "ct", Fingerprint: "SHA256:abc", IsDefault: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	p1 := sshx.ProbeResult{
		MachineID: "mid-clone", ProductUUID: "uuid-1", MACAddrs: []string{"52:54:00:00:00:01"},
		SudoReady: true, Arch: "amd64", TimeSync: "synced", OptWritable: true,
	}
	p1JSON, _ := json.Marshal(p1)
	n1 := &db.Node{
		ID: "n1", Name: "deck-node-1", Host: "10.0.0.1", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1",
		MachineID: "mid-clone", Arch: "amd64", TimeSync: "synced", SudoReady: true,
		ProbeJSON: string(p1JSON), Status: "online", LastCheckedAt: now, CreatedAt: now, UpdatedAt: now,
	}
	if err := db.InsertNode(ctx, d.Writer, n1); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateNodeProbe(ctx, d.Writer, n1, now); err != nil {
		t.Fatal(err)
	}

	svc := &Service{DB: d}
	n2 := &db.Node{ID: "n2", Name: "n2", Host: "10.0.0.2", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1"}
	p2 := &sshx.ProbeResult{
		MachineID: "mid-clone", ProductUUID: "uuid-2", MACAddrs: []string{"52:54:00:00:00:02"},
		SudoReady: true, Arch: "amd64", TimeSync: "synced", OptWritable: true,
	}
	clones, dup, err := svc.classifyExistingPeers(ctx, n2, p2)
	if err != nil {
		t.Fatal(err)
	}
	if dup != "" || len(clones) != 1 || clones[0] != "deck-node-1" {
		t.Fatalf("expected clone peer [deck-node-1] and no dup, got clones=%v dup=%q", clones, dup)
	}
	warnings := svc.WarningsForNode(ctx, n2, p2)
	if !strings.Contains(strings.Join(warnings, "\n"), "deck-node-1") || !strings.Contains(strings.Join(warnings, "\n"), "已允许接入") {
		t.Fatalf("expected non-blocking clone warning, got %v", warnings)
	}

	// Same host under second IP must still be caught as duplicate.
	n1Dup := &db.Node{ID: "n1-dup", Name: "n1-alt", Host: "192.168.1.1", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1"}
	p1Dup := &sshx.ProbeResult{
		MachineID: "mid-clone", ProductUUID: "uuid-1", MACAddrs: []string{"52:54:00:00:00:01"},
		SudoReady: true, Arch: "amd64", TimeSync: "synced", OptWritable: true,
	}
	_, dup, err = svc.classifyExistingPeers(ctx, n1Dup, p1Dup)
	if err != nil {
		t.Fatal(err)
	}
	if dup != "deck-node-1" {
		t.Fatalf("expected duplicate peer deck-node-1, got %q", dup)
	}
}

func TestResetMachineIDGuards(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(ctx, filepath.Join(t.TempDir(), "reset_mid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := d.Now()
	_ = db.InsertSSHKey(ctx, d.Writer, &db.SSHKey{
		ID: "k1", Name: "default", Algorithm: "ed25519", PublicKey: "ssh-ed25519 AAAA",
		PrivateKeyEncrypted: "ct", Fingerprint: "SHA256:abc", IsDefault: true, CreatedAt: now, UpdatedAt: now,
	})
	cpNode := &db.Node{
		ID: "cp1", Name: "cp-host", Host: "127.0.0.1", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1",
		MachineID: "cp-mid", CreatedAt: now, UpdatedAt: now,
	}
	_ = db.InsertNode(ctx, d.Writer, cpNode)
	_ = db.UpdateNodeProbe(ctx, d.Writer, cpNode, now)

	svc := &Service{DB: d, LocalIdentity: HostIdentity{MachineID: "cp-mid"}}
	var ae *auth.Error
	actor := audit.Actor{ID: "a1", Name: "admin", ClientIP: "127.0.0.1"}
	if _, err := svc.ResetMachineID(ctx, actor, "missing"); !errors.As(err, &ae) || ae.Status != 404 {
		t.Fatalf("expected 404 for missing node, got %v", err)
	}
	if _, err := svc.ResetMachineID(ctx, actor, "cp1"); !errors.As(err, &ae) || ae.Code != "control_plane_host" {
		t.Fatalf("expected control_plane_host guard, got %v", err)
	}
}
