package db

import (
	"context"
	"path/filepath"
	"testing"

	"nomad-deck/internal/crypto"
)

func TestOpenIsIdempotentAndChecksKeys(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "t.db")
	d, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	v, err := d.SchemaVersion(ctx)
	if err != nil || v < 1 {
		t.Fatalf("schema version %d %v", v, err)
	}
	kr1, _ := crypto.NewKeyringForTest(make([]byte, 32))
	ct, _ := kr1.EncryptString("x", SSHKeyAAD("k1"))
	if err := InsertSSHKey(ctx, d.Writer, &SSHKey{ID: "k1", Name: "k", Algorithm: "ed25519", PublicKey: "p",
		PrivateKeyEncrypted: ct, Fingerprint: "f", CreatedAt: d.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := PutSetting(ctx, d.Writer, "proxy.password", "not-a-ciphertext", true, d.NowString()); err != nil {
		t.Fatal(err)
	}
	d.Close()

	d, err = Open(ctx, path)
	if err != nil {
		t.Fatal("reopen must not re-apply migrations:", err)
	}
	defer d.Close()
	problems, err := CheckKeyIDs(ctx, d.Reader, crypto.KeyIDOf, kr1.Has)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 1 || problems[0].Field != "system_settings.value" {
		t.Fatalf("expected one malformed secret setting, got %v", problems)
	}
	other := []byte("0123456789abcdef0123456789abcdef")
	kr2, _ := crypto.NewKeyringForTest(other)
	problems, _ = CheckKeyIDs(ctx, d.Reader, crypto.KeyIDOf, kr2.Has)
	if len(problems) != 2 {
		t.Fatalf("expected unknown key + malformed, got %v", problems)
	}
}

func TestAuditListFilters(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for i, act := range []string{"auth.login", "auth.login", "admin.create"} {
		res := "success"
		if i == 1 {
			res = "failed"
		}
		if err := InsertAuditLog(ctx, d.Writer, &AuditLog{ID: NewID(), Action: act, ResourceName: "alice_%",
			RequestSummaryJSON: "{}", Result: res, CreatedAt: d.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	logs, _ := ListAuditLogs(ctx, d.Reader, AuditFilter{Action: "auth.login", Result: "failed"})
	if len(logs) != 1 {
		t.Fatalf("filter: %d", len(logs))
	}
	logs, _ = ListAuditLogs(ctx, d.Reader, AuditFilter{Keyword: "e_%"})
	if len(logs) != 3 {
		t.Fatalf("keyword with wildcards must be literal: %d", len(logs))
	}
	page, _ := ListAuditLogs(ctx, d.Reader, AuditFilter{Limit: 2})
	rest, _ := ListAuditLogs(ctx, d.Reader, AuditFilter{Before: page[1].ID})
	if len(page) != 2 || len(rest) != 1 {
		t.Fatalf("pagination: %d %d", len(page), len(rest))
	}
}

func TestNodesAllowSharedMachineIDWithForeignKeysIntact(t *testing.T) {
	ctx := context.Background()
	d, err := Open(ctx, filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := d.Now()
	if err := InsertSSHKey(ctx, d.Writer, &SSHKey{
		ID: "k1", Name: "default", Algorithm: "ed25519", PublicKey: "ssh-ed25519 AAAA",
		PrivateKeyEncrypted: "ct", Fingerprint: "SHA256:abc", IsDefault: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []*Node{
		{ID: "n1", Name: "node-1", Host: "10.0.0.1", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1", CreatedAt: now, UpdatedAt: now},
		{ID: "n2", Name: "node-2", Host: "10.0.0.2", SSHPort: 22, SSHUser: "root", SSHKeyID: "k1", CreatedAt: now, UpdatedAt: now},
	} {
		if err := InsertNode(ctx, d.Writer, n); err != nil {
			t.Fatal(err)
		}
		n.MachineID = "shared-clone-mid"
		n.Status = "online"
		if err := UpdateNodeProbe(ctx, d.Writer, n, now); err != nil {
			t.Fatalf("UpdateNodeProbe(%s) failed: %v", n.ID, err)
		}
	}
	rows, err := ListNodesByMachineID(ctx, d.Reader, "shared-clone-mid")
	if err != nil || len(rows) != 2 {
		t.Fatalf("expected 2 nodes sharing machine_id, got %d (%v)", len(rows), err)
	}
}
