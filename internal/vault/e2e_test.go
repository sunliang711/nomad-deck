//go:build integration

// End-to-end test against real Linux hosts (systemd + sshd) reachable over
// SSH, with Vault releases downloaded and relayed by the control plane.
// See "make it-vault".
package vault

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/pki"
	"nomad-deck/internal/release"
	"nomad-deck/internal/sshx"
)

func pickVersions(t *testing.T) (string, string) {
	if from, to := os.Getenv("ND_E2E_FROM"), os.Getenv("ND_E2E_TO"); from != "" && to != "" {
		return from, to
	}
	vs, err := (&release.HashiCorp{}).Versions(context.Background(), http.DefaultClient, "vault")
	if err != nil {
		t.Fatal(err)
	}
	to := vs[0]
	toMinor := to[:strings.LastIndex(to, ".")]
	for _, v := range vs {
		if v[:strings.LastIndex(v, ".")] != toMinor {
			return v, to // newest patch of the previous minor
		}
	}
	t.Fatal("no previous minor found")
	return "", ""
}

func TestE2EVaultCluster(t *testing.T) {
	hostList := os.Getenv("ND_E2E_HOSTS")
	if hostList == "" {
		t.Skip("ND_E2E_HOSTS not set")
	}
	names := strings.Split(hostList, ",")
	if len(names) < 4 {
		t.Fatal("need 4 hosts")
	}
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "e2e.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{5}, 32))
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	rec := &audit.Recorder{DB: d, Log: log}
	pool := sshx.NewPool(8)
	defer pool.Close()
	hs := &hosts.Service{DB: d, Keys: keys, Audit: rec, Pool: pool, LocalMachineID: "e2e-runner"}
	engine := ops.NewEngine(d, log, dir)
	s := &Service{DB: d, Keys: keys, Audit: rec, Hosts: hs, Ops: engine, DataDir: dir, Log: log,
		Releases: &release.Provider{DB: d, CacheDir: filepath.Join(dir, "cache")}, Proxy: &netx.Manager{DB: d, Keys: keys},
		PollEvery: time.Second, JoinTimeout: 4 * time.Minute}
	e := &svcEnv{t: t, s: s, dir: dir}
	actor := audit.Actor{Name: "e2e"}
	from, to := pickVersions(t)
	t.Logf("deploying Vault %s, upgrading to %s", from, to)

	if _, err := hs.GenerateKey(ctx, actor, "e2e"); err != nil {
		t.Fatal(err)
	}
	var nodeIDs []string
	for _, n := range names {
		node, err := hs.CreateNode(ctx, actor, hosts.NodeInput{Name: n, Host: n, SSHUser: os.Getenv("ND_E2E_USER"), UseSudo: true})
		if err != nil {
			t.Fatal(err)
		}
		if err := hs.PushKey(ctx, actor, node.ID, os.Getenv("ND_E2E_PASSWORD")); err != nil {
			t.Fatal(err)
		}
		if _, err := hs.Test(ctx, actor, node.ID); err != nil {
			t.Fatal(err)
		}
		// Containers share the host clock but report no NTP synchronization.
		if _, err := d.Writer.Exec(`UPDATE nodes SET time_sync = 'synced' WHERE id = ?`, node.ID); err != nil {
			t.Fatal(err)
		}
		nodeIDs = append(nodeIDs, node.ID)
	}
	var members []MemberInput
	for _, id := range nodeIDs[:3] {
		members = append(members, MemberInput{NodeID: id})
	}
	c, err := s.CreateCluster(ctx, actor, CreateInput{Name: "e2e-vault", Mode: "cluster", Nodes: members})
	if err != nil {
		t.Fatal(err)
	}
	id := c.ID
	e.cluster = c
	noProxy := false

	// Deploy and initialize.
	e.mustSucceed(s.Deploy(ctx, actor, id, DeployInput{Version: from, UseProxy: &noProxy, ConfirmSwap: true}))
	e.mustSucceed(s.Init(ctx, actor, id, InitInput{}))
	status := func() ([]NodeStatus, string) {
		ns, h, err := s.SyncStatus(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return ns, h
	}
	ns, health := status()
	voters := 0
	for _, n := range ns {
		if n.Voter && !n.Sealed && n.Version == from {
			voters++
		}
	}
	if health != "healthy" || voters != 3 || e.custody().BootstrapRootTokenEncrypted != "" {
		t.Fatalf("after init: %s %+v", health, ns)
	}

	// Seal a standby (restart over SSH) and unseal it.
	clu, _ := s.loadCluster(ctx, d.Reader, id)
	ms, _ := db.ListClusterNodes(ctx, d.Reader, id)
	var standby *db.ClusterNode
	for _, m := range ms {
		if s.nodeRole(ctx, clu, m) == "standby" {
			standby = m
			break
		}
	}
	e.mustSucceed(s.Seal(ctx, actor, id, SealInput{NodeIDs: []string{standby.NodeID}}))
	if s.nodeRole(ctx, clu, standby) != "sealed" {
		t.Fatal("standby must be sealed")
	}
	if err := s.UpdateCustody(ctx, actor, id, CustodyInput{ClearSuppression: true}); err != nil {
		t.Fatal(err)
	}
	e.mustSucceed(s.Unseal(ctx, actor, id, UnsealInput{}))

	// Rekey, then Doctor.
	e.mustSucceed(s.Rekey(ctx, actor, id, RekeyInput{}))
	if e.custody().SealGeneration != 2 {
		t.Fatal("rekey must activate generation 2")
	}
	// Emergency recovery through generate-root after the admin token is revoked.
	if adm, _, err := s.adminClient(ctx, clu); err != nil || adm.RevokeSelf(ctx) != nil {
		t.Fatal("revoke admin token")
	}
	e.mustSucceed(s.RecoverToken(ctx, actor, id))
	rep, err := s.Doctor(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range rep.Checks {
		if ch.Status == "FAIL" {
			t.Errorf("doctor FAIL: %+v", ch)
		}
	}
	t.Logf("doctor: %s", rep.Summary)

	// Scale out and back in.
	e.mustSucceed(s.NodeJoin(ctx, actor, id, nodeIDs[3], JoinInput{UseProxy: &noProxy, ConfirmSwap: true}))
	if ns, _ := status(); len(ns) != 4 {
		t.Fatalf("after join: %+v", ns)
	}
	e.mustSucceed(s.NodeRemove(ctx, actor, id, nodeIDs[3], false))
	if ns, _ := status(); len(ns) != 3 {
		t.Fatalf("after remove: %+v", ns)
	}
	n4, _ := db.GetNode(ctx, d.Reader, nodeIDs[3])
	sc, _ := hs.Connect(ctx, n4)
	if r, _ := sc.Run(ctx, "test -e "+Base+" && echo present || echo gone", sshx.RunOptions{Sudo: true}); strings.TrimSpace(string(r.Stdout)) != "gone" {
		t.Fatal("removed node must be wiped")
	}

	// Certificate renewal, then switching one node back to its previous
	// generation restores the previous certificate as well.
	before, _ := db.GetClusterNode(ctx, d.Reader, id, nodeIDs[0])
	time.Sleep(2 * time.Second)
	e.mustSucceed(s.RenewCerts(ctx, actor, id, false))
	renewed, _ := db.GetClusterNode(ctx, d.Reader, id, nodeIDs[0])
	if renewed.CertExpiresAt.Equal(before.CertExpiresAt) || memberConfig(renewed).ConfigGeneration != memberConfig(before).ConfigGeneration+1 {
		t.Fatal("renewal must issue a new certificate in a new generation")
	}
	e.mustSucceed(s.RollbackGeneration(ctx, actor, id, nodeIDs[0], false))
	rolled, _ := db.GetClusterNode(ctx, d.Reader, id, nodeIDs[0])
	if !rolled.CertExpiresAt.Truncate(time.Second).Equal(before.CertExpiresAt.Truncate(time.Second)) ||
		memberConfig(rolled).ConfigGeneration != memberConfig(before).ConfigGeneration {
		t.Fatalf("rollback must restore the previous certificate: %v vs %v", rolled.CertExpiresAt, before.CertExpiresAt)
	}
	if _, h := status(); h != "healthy" {
		t.Fatalf("after rollback: %s", h)
	}
	oldCA := clu.CACertPEM
	e.mustSucceed(s.RotateCA(ctx, actor, id, false))
	clu, _ = s.loadCluster(ctx, d.Reader, id)
	if certs, _ := pki.ParseCerts(clu.CACertPEM); len(certs) != 1 || clu.CACertPEM == oldCA {
		t.Fatal("CA rotation must end with only the new CA")
	}
	if _, h := status(); h != "healthy" {
		t.Fatalf("after CA rotation: %s", h)
	}

	// Snapshot, rolling upgrade, restore.
	e.mustSucceed(s.CreateSnapshot(ctx, actor, id))
	snaps, _ := s.ListSnapshots(ctx, id)
	e.mustSucceed(s.Upgrade(ctx, actor, id, UpgradeInput{Version: to, UseProxy: &noProxy, Confirm: true}))
	ns, health = status()
	for _, n := range ns {
		if n.Version != to || n.Sealed {
			t.Fatalf("after upgrade: %+v", ns)
		}
	}
	if health != "healthy" {
		t.Fatalf("after upgrade: %s", health)
	}
	if after, _ := s.ListSnapshots(ctx, id); len(after) != len(snaps)+1 || after[0].TriggerType != "pre_upgrade" {
		t.Fatalf("pre-upgrade snapshot missing: %+v", after)
	}
	e.mustSucceed(s.Restore(ctx, actor, id, snaps[0].ID, RestoreInput{}))
	if _, h := status(); h != "healthy" {
		t.Fatalf("after restore: %s", h)
	}

	// Uninstall.
	e.mustSucceed(s.Uninstall(ctx, actor, id, "e2e-vault", false))
	if _, err := db.GetCluster(ctx, d.Reader, id); err == nil {
		t.Fatal("cluster must be deleted")
	}
	engine.Wait()
	_ = io.Discard
}
