package pki

import (
	"strings"
	"testing"
	"time"
)

func TestIssueAndVerify(t *testing.T) {
	now := time.Now()
	caM, err := NewCA("test CA", CATTL, now)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := ParseCA(caM.CertPEM, caM.KeyPEM)
	if err != nil {
		t.Fatal(err)
	}
	hosts := []string{"localhost", "127.0.0.1", "::1", "10.0.0.11", "vault.example.com", "VAULT.example.com"}
	leaf, err := ca.Issue(Request{CommonName: "node-1", Hosts: hosts}, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(leaf.CertPEM, leaf.KeyPEM, caM.CertPEM, hosts, now, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := Verify(leaf.CertPEM, leaf.KeyPEM, caM.CertPEM, []string{"10.0.0.12"}, now, 0); err == nil {
		t.Fatal("uncovered host must fail")
	}
	other, _ := ca.Issue(Request{CommonName: "node-2", Hosts: hosts}, now)
	if err := Verify(leaf.CertPEM, other.KeyPEM, caM.CertPEM, nil, now, 0); err == nil {
		t.Fatal("mismatched key must fail")
	}
	otherCA, _ := NewCA("other", CATTL, now)
	if err := Verify(leaf.CertPEM, leaf.KeyPEM, otherCA.CertPEM, nil, now, 0); err == nil {
		t.Fatal("foreign CA must fail")
	}
	// A bundle with both CAs verifies leaves of either, and signing picks the CA matching the key.
	bundle := otherCA.CertPEM + caM.CertPEM
	if err := Verify(leaf.CertPEM, leaf.KeyPEM, bundle, nil, now, 0); err != nil {
		t.Fatal(err)
	}
	if ca2, err := ParseCA(bundle, caM.KeyPEM); err != nil || ca2.Cert.Subject.CommonName != "test CA" {
		t.Fatalf("CA from bundle: %v %v", ca2, err)
	}
	if err := Verify(leaf.CertPEM, leaf.KeyPEM, caM.CertPEM, nil, now, 3*365*24*time.Hour); err == nil ||
		!strings.Contains(err.Error(), "expires") {
		t.Fatalf("short validity must fail: %v", err)
	}
}
