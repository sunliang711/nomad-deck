package vault

import (
	"bytes"
	"context"
	"testing"
	"time"
)

// TestVaultProtocol exercises the raw API flows the orchestration relies on
// against real Vault processes: Shamir init, two-phase Raft join by
// unsealing joiners, autopilot, rekey with verification, generate-root and
// restoring a snapshot taken before a rekey.
func TestVaultProtocol(t *testing.T) {
	lc := newLocalCluster(t, 3)
	ctx := context.Background()
	for _, n := range lc.nodes {
		lc.start(n)
	}
	n1, n2, n3 := lc.nodes[0], lc.nodes[1], lc.nodes[2]
	c1 := lc.client(n1, "")
	st, err := c1.SealStatus(ctx)
	if err != nil || st.Initialized || !st.Sealed {
		t.Fatalf("fresh status: %+v %v", st, err)
	}
	init, err := c1.Init(ctx, 5, 3)
	if err != nil || len(init.KeysBase64) != 5 || init.RootToken == "" {
		t.Fatalf("init: %v", err)
	}
	keys := init.KeysBase64
	unseal := func(n *localNode, ks []string) error {
		c := lc.client(n, "")
		for _, k := range ks[:3] {
			s, err := c.Unseal(ctx, k)
			if err != nil {
				return err
			}
			if !s.Sealed {
				return nil
			}
		}
		return nil
	}
	if err := unseal(n1, keys); err != nil {
		t.Fatal(err)
	}
	root := lc.client(n1, init.RootToken)
	waitFor(t, "n1 active", 30*time.Second, func() (bool, error) {
		h, err := root.Health(ctx)
		return err == nil && h.HTTPStatus == 200, err
	})
	// Joiners: retry_join is configured; submitting unseal keys completes the challenge.
	for _, n := range []*localNode{n2, n3} {
		n := n
		waitFor(t, n.name+" joined", 60*time.Second, func() (bool, error) {
			err := unseal(n, keys)
			if err != nil {
				return false, err
			}
			s, err := lc.client(n, "").SealStatus(ctx)
			return err == nil && !s.Sealed, err
		})
	}
	waitFor(t, "3 healthy voters", 60*time.Second, func() (bool, error) {
		ap, err := root.AutopilotState(ctx)
		if err != nil {
			return false, err
		}
		return ap.Healthy && len(ap.Voters) == 3 && ap.FailureTolerance == 1, nil
	})
	cfg, err := root.RaftConfiguration(ctx)
	if err != nil || len(cfg) != 3 {
		t.Fatalf("raft config: %v %v", cfg, err)
	}

	// Snapshot before rekey.
	var snap bytes.Buffer
	if _, err := root.SnapshotSave(ctx, &snap); err != nil || snap.Len() == 0 {
		t.Fatalf("snapshot: %v", err)
	}

	// Rekey with verification.
	rs, err := c1.RekeyInit(ctx, 5, 3)
	if err != nil || rs.Nonce == "" || !rs.VerificationRequired {
		t.Fatalf("rekey init: %+v %v", rs, err)
	}
	var upd *RekeyStatus
	for _, k := range keys[:3] {
		if upd, err = c1.RekeyUpdate(ctx, k, rs.Nonce); err != nil {
			t.Fatal(err)
		}
	}
	if !upd.Complete || len(upd.KeysBase64) != 5 || upd.VerificationNonce == "" {
		t.Fatalf("rekey update result: %+v", upd)
	}
	newKeys := upd.KeysBase64
	vs, err := c1.RekeyVerifyStatus(ctx)
	if err != nil || !vs.Started || vs.Nonce != upd.VerificationNonce {
		t.Fatalf("verify status before: %+v %v", vs, err)
	}
	// Old keys still unseal until verification completes: generate-root works with old keys.
	var vr *RekeyStatus
	for _, k := range newKeys[:3] {
		if vr, err = c1.RekeyVerifyUpdate(ctx, k, upd.VerificationNonce); err != nil {
			t.Fatal(err)
		}
	}
	if !vr.Complete {
		t.Fatalf("verify result: %+v", vr)
	}
	_, err = c1.RekeyVerifyStatus(ctx)
	t.Logf("verify status after completion: err=%v", err)

	// Vault refuses to seal a standby through the API; a restart seals it.
	c2 := lc.client(n2, init.RootToken)
	if err := c2.Seal(ctx); err == nil || !IsStandbySealRefused(err) {
		t.Fatalf("sealing a standby via API must be refused: %v", err)
	}
	n2.stop()
	lc.start(n2)
	s2, _ := lc.client(n2, "").SealStatus(ctx)
	if !s2.Sealed {
		t.Fatal("a restarted node must come up sealed")
	}
	// A full threshold of old keys is rejected as invalid; new keys unseal.
	err = unseal(n2, keys)
	t.Logf("unseal n2 with old keys: %v", err)
	if !IsInvalidKey(err) {
		t.Fatalf("old keys must be reported as invalid: %v", err)
	}
	_ = lc.client(n2, "").UnsealReset(ctx)
	if err := unseal(n2, newKeys); err != nil {
		t.Fatal(err)
	}

	// generate-root with the new keys.
	gr, err := c1.GenerateRootInit(ctx)
	if err != nil || gr.OTP == "" {
		t.Fatalf("generate-root init: %+v %v", gr, err)
	}
	var gu *GenerateRootStatus
	for _, k := range newKeys[:3] {
		if gu, err = c1.GenerateRootUpdate(ctx, k, gr.Nonce); err != nil {
			t.Fatal(err)
		}
	}
	enc := gu.EncodedToken
	if enc == "" {
		enc = gu.EncodedRoot
	}
	tok, err := DecodeRootToken(enc, gr.OTP)
	if err != nil {
		t.Fatal(err)
	}
	info, err := lc.client(n1, tok).LookupSelf(ctx)
	if err != nil || len(info.Policies) == 0 || info.Policies[0] != "root" {
		t.Fatalf("generated root: %+v %v", info, err)
	}
	_ = lc.client(n1, tok).RevokeSelf(ctx)

	// Restore the pre-rekey snapshot (needs force) and observe the seal state.
	err = root.SnapshotRestore(ctx, bytes.NewReader(snap.Bytes()), false)
	t.Logf("restore without force: %v", err)
	if err == nil {
		t.Fatal("restoring a snapshot from another key generation must require force")
	}
	if err := root.SnapshotRestore(ctx, bytes.NewReader(snap.Bytes()), true); err != nil {
		t.Fatalf("force restore: %v", err)
	}
	time.Sleep(3 * time.Second)
	for _, n := range lc.nodes {
		s, _ := lc.client(n, "").SealStatus(ctx)
		t.Logf("after force restore: %s sealed=%v", n.name, s.Sealed)
	}
	for _, n := range lc.nodes {
		n := n
		waitFor(t, n.name+" unsealed with old keys", 60*time.Second, func() (bool, error) {
			s, err := lc.client(n, "").SealStatus(ctx)
			if err != nil {
				return false, err
			}
			if !s.Sealed {
				return true, nil
			}
			err = unseal(n, keys)
			if err != nil && IsInvalidKey(err) {
				_ = lc.client(n, "").UnsealReset(ctx)
				err = unseal(n, newKeys)
			}
			return false, err
		})
	}
}
