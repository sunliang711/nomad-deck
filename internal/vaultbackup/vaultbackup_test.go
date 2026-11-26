package vaultbackup

import (
	"errors"
	"testing"
	"time"
)

func TestRoundTrip(t *testing.T) {
	DefaultMemory = 8 * 1024 // keep the test fast
	p := &Payload{ClusterID: "c1", ClusterName: "prod-vault", CreatedAt: time.Now().UTC(), ActiveGeneration: 2,
		Generations: []Generation{{Generation: 2, State: "active", KeyShares: 5, KeyThreshold: 3, UnsealKeys: []string{"a", "b", "c", "d", "e"}}}}
	data, err := Encrypt(p, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decrypt(data, "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if got.ClusterName != "prod-vault" || got.Generations[0].UnsealKeys[4] != "e" || got.ActiveGeneration != 2 {
		t.Fatalf("payload: %+v", got)
	}
	if _, err := Decrypt(data, "wrong passphrase!!"); !errors.Is(err, ErrBadPassphrase) {
		t.Fatalf("wrong passphrase: %v", err)
	}
	data[7] ^= 1 // tamper with the header (authenticated as AAD)
	if _, err := Decrypt(data, "correct horse battery"); err == nil {
		t.Fatal("tampered header must fail")
	}
	if _, err := Encrypt(p, "short"); err == nil {
		t.Fatal("short passphrase (<6) must be rejected")
	}
	if _, err := Encrypt(p, "123456"); err != nil {
		t.Fatalf("6-char passphrase must succeed: %v", err)
	}
	plainData, err := Encrypt(p, "")
	if err != nil {
		t.Fatalf("empty passphrase must succeed: %v", err)
	}
	gotPlain, err := Decrypt(plainData, "")
	if err != nil {
		t.Fatalf("decrypt unencrypted backup: %v", err)
	}
	if gotPlain.ClusterName != "prod-vault" || gotPlain.ActiveGeneration != 2 {
		t.Fatalf("unencrypted payload: %+v", gotPlain)
	}
}
