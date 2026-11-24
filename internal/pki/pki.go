// Package pki issues and verifies the TLS material of managed clusters: a
// per-cluster CA, node certificates with explicit SANs, and the checks run
// before a certificate set is shipped to a host.
package pki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"time"
)

// Default lifetimes.
const (
	CATTL   = 10 * 365 * 24 * time.Hour
	LeafTTL = 2 * 365 * 24 * time.Hour
)

// Material is a PEM certificate with its PEM private key.
type Material struct {
	CertPEM  string
	KeyPEM   string
	NotAfter time.Time
}

// CA is a parsed signing CA.
type CA struct {
	Cert *x509.Certificate
	Key  crypto.Signer
}

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

func encodeKey(k *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

func encodeCert(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// NewCA creates a self-signed CA.
func NewCA(commonName string, ttl time.Duration, now time.Time) (*Material, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          sn,
		Subject:               pkix.Name{CommonName: commonName, Organization: []string{"NomadDeck"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(ttl),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	kp, err := encodeKey(key)
	if err != nil {
		return nil, err
	}
	return &Material{CertPEM: encodeCert(der), KeyPEM: kp, NotAfter: tmpl.NotAfter}, nil
}

// ParseCA loads a signing CA. certPEM may be a bundle; the certificate
// matching the key is used for signing.
func ParseCA(certPEM, keyPEM string) (*CA, error) {
	certs, err := ParseCerts(certPEM)
	if err != nil {
		return nil, err
	}
	key, err := ParseKey(keyPEM)
	if err != nil {
		return nil, err
	}
	for _, c := range certs {
		if c.IsCA && publicKeysEqual(c.PublicKey, key.Public()) {
			return &CA{Cert: c, Key: key}, nil
		}
	}
	return nil, errors.New("no CA certificate matches the CA private key")
}

// Request describes a leaf certificate.
type Request struct {
	CommonName string
	Hosts      []string // DNS names and IP addresses
	TTL        time.Duration
}

// Issue signs a new leaf certificate usable for TLS server and client auth.
func (ca *CA) Issue(r Request, now time.Time) (*Material, error) {
	if r.TTL <= 0 {
		r.TTL = LeafTTL
	}
	notAfter := now.Add(r.TTL)
	if notAfter.After(ca.Cert.NotAfter) {
		notAfter = ca.Cert.NotAfter
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := serial()
	if err != nil {
		return nil, err
	}
	dns, ips := SplitHosts(r.Hosts)
	tmpl := &x509.Certificate{
		SerialNumber: sn,
		Subject:      pkix.Name{CommonName: r.CommonName, Organization: []string{"NomadDeck"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     dns,
		IPAddresses:  ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, &key.PublicKey, ca.Key)
	if err != nil {
		return nil, err
	}
	kp, err := encodeKey(key)
	if err != nil {
		return nil, err
	}
	return &Material{CertPEM: encodeCert(der), KeyPEM: kp, NotAfter: notAfter}, nil
}

// SplitHosts separates DNS names from IP addresses, de-duplicating both.
func SplitHosts(hosts []string) (dns []string, ips []net.IP) {
	seen := map[string]bool{}
	for _, h := range hosts {
		h = strings.TrimSpace(strings.Trim(h, "[]"))
		if h == "" || seen[strings.ToLower(h)] {
			continue
		}
		seen[strings.ToLower(h)] = true
		if ip := net.ParseIP(h); ip != nil {
			ips = append(ips, ip)
		} else {
			dns = append(dns, strings.ToLower(h))
		}
	}
	return dns, ips
}

// ParseCerts parses every certificate in a PEM bundle.
func ParseCerts(bundle string) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	rest := []byte(bundle)
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		if b.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(b.Bytes)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, errors.New("no certificate found")
	}
	return out, nil
}

// ParseKey parses a PKCS#8, SEC1 or PKCS#1 private key.
func ParseKey(keyPEM string) (crypto.Signer, error) {
	b, _ := pem.Decode([]byte(keyPEM))
	if b == nil {
		return nil, errors.New("no private key found")
	}
	if k, err := x509.ParsePKCS8PrivateKey(b.Bytes); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s, nil
		}
	}
	if k, err := x509.ParseECPrivateKey(b.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS1PrivateKey(b.Bytes); err == nil {
		return k, nil
	}
	return nil, errors.New("unsupported private key format")
}

func publicKeysEqual(a, b crypto.PublicKey) bool {
	type eq interface{ Equal(crypto.PublicKey) bool }
	if e, ok := a.(eq); ok {
		return e.Equal(b)
	}
	return false
}

// Verify checks a leaf before it is distributed: it chains to a CA in
// caBundle, matches its private key, covers every wanted host and is valid
// for at least minValid from now.
func Verify(certPEM, keyPEM, caBundle string, hosts []string, now time.Time, minValid time.Duration) error {
	certs, err := ParseCerts(certPEM)
	if err != nil {
		return fmt.Errorf("certificate: %w", err)
	}
	leaf := certs[0]
	key, err := ParseKey(keyPEM)
	if err != nil {
		return fmt.Errorf("private key: %w", err)
	}
	if !publicKeysEqual(leaf.PublicKey, key.Public()) {
		return errors.New("private key does not match the certificate")
	}
	roots := x509.NewCertPool()
	cas, err := ParseCerts(caBundle)
	if err != nil {
		return fmt.Errorf("CA bundle: %w", err)
	}
	for _, c := range cas {
		roots.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: now,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return fmt.Errorf("certificate chain: %w", err)
	}
	for _, h := range hosts {
		if err := leaf.VerifyHostname(strings.Trim(h, "[]")); err != nil {
			return fmt.Errorf("certificate does not cover %s", h)
		}
	}
	if leaf.NotAfter.Sub(now) < minValid {
		return fmt.Errorf("certificate expires at %s", leaf.NotAfter.UTC().Format(time.RFC3339))
	}
	return nil
}

// NotAfter returns the expiry of the first certificate in a PEM bundle.
func NotAfter(certPEM string) (time.Time, error) {
	certs, err := ParseCerts(certPEM)
	if err != nil {
		return time.Time{}, err
	}
	return certs[0].NotAfter, nil
}

// EarliestExpiry returns the earliest expiry among the CAs in a bundle.
func EarliestExpiry(bundle string) (time.Time, error) {
	certs, err := ParseCerts(bundle)
	if err != nil {
		return time.Time{}, err
	}
	min := certs[0].NotAfter
	for _, c := range certs[1:] {
		if c.NotAfter.Before(min) {
			min = c.NotAfter
		}
	}
	return min, nil
}

// Pool builds a certificate pool from a PEM bundle.
func Pool(bundle string) (*x509.CertPool, error) {
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM([]byte(bundle)) {
		return nil, errors.New("no certificate found in CA bundle")
	}
	return p, nil
}
