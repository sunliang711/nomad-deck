package release

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
)

func TestBuiltinKeyFingerprint(t *testing.T) {
	if _, err := (&HashiCorp{}).Keyring(); err != nil {
		t.Fatal(err)
	}
}

type fakeRelease struct {
	sums, sig, zip []byte
}

func buildFake(t *testing.T, signer *openpgp.Entity, binary []byte, tamper bool) fakeRelease {
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	w, _ := zw.Create("nomad")
	w.Write(binary)
	zw.Close()
	sum := sha256.Sum256(zbuf.Bytes())
	sums := fmt.Sprintf("%s  nomad_1.9.3_linux_amd64.zip\n%s  nomad_1.9.3_linux_arm64.zip\n", hex.EncodeToString(sum[:]), strings.Repeat("0", 64))
	var sig bytes.Buffer
	if err := openpgp.DetachSign(&sig, signer, strings.NewReader(sums), nil); err != nil {
		t.Fatal(err)
	}
	z := zbuf.Bytes()
	if tamper {
		z = append(append([]byte{}, z...), 0)
	}
	return fakeRelease{sums: []byte(sums), sig: sig.Bytes(), zip: z}
}

func serve(t *testing.T, fr fakeRelease) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/nomad/index.json":
			io.WriteString(w, `{"versions":{"1.8.4":{},"1.9.3":{},"1.10.0-beta.1":{},"1.9.3+ent":{},"1.10.1":{}}}`)
		case "/nomad/1.9.3/nomad_1.9.3_SHA256SUMS":
			w.Write(fr.sums)
		case "/nomad/1.9.3/nomad_1.9.3_SHA256SUMS.sig":
			w.Write(fr.sig)
		case "/nomad/1.9.3/nomad_1.9.3_linux_amd64.zip":
			w.Write(fr.zip)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func armoredPublic(t *testing.T, e *openpgp.Entity) string {
	var b bytes.Buffer
	aw, _ := armor.Encode(&b, openpgp.PublicKeyType, nil)
	e.Serialize(aw)
	aw.Close()
	return b.String()
}

func TestFetchVerifiesSignatureAndDigest(t *testing.T) {
	signer, err := openpgp.NewEntity("test", "", "test@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte("#!/bin/sh\necho nomad\n")
	srv := serve(t, buildFake(t, signer, binary, false))
	h := &HashiCorp{BaseURL: srv.URL, CacheDir: t.TempDir(), ArmoredKey: armoredPublic(t, signer)}

	versions, err := h.Versions(context.Background(), srv.Client(), "nomad")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(versions, ",") != "1.10.1,1.9.3" {
		t.Fatalf("versions (stable, >= 1.9.0, newest first): %v", versions)
	}
	a, err := h.Fetch(context.Background(), srv.Client(), "nomad", "1.9.3", "linux", "amd64", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(binary)
	if a.PayloadSHA256 != hex.EncodeToString(want[:]) || !a.Gzipped {
		t.Fatalf("artifact: %+v", a)
	}
	f, _ := os.Open(a.GzipPath)
	zr, _ := gzip.NewReader(f)
	got, _ := io.ReadAll(zr)
	f.Close()
	if !bytes.Equal(got, binary) {
		t.Fatal("gzip payload mismatch")
	}
	// Cached on second call (server no longer needed).
	srv.Close()
	if _, err := h.Fetch(context.Background(), http.DefaultClient, "nomad", "1.9.3", "linux", "amd64", nil); err != nil {
		t.Fatalf("cache: %v", err)
	}
	if _, err := h.Fetch(context.Background(), http.DefaultClient, "nomad", "1.8.4", "linux", "amd64", nil); err == nil {
		t.Fatal("versions below the minimum must be rejected")
	}
}

func TestFetchRejectsWrongSignerAndTamperedArchive(t *testing.T) {
	signer, _ := openpgp.NewEntity("test", "", "a@example.com", nil)
	other, _ := openpgp.NewEntity("evil", "", "b@example.com", nil)
	srv := serve(t, buildFake(t, other, []byte("x"), false))
	h := &HashiCorp{BaseURL: srv.URL, CacheDir: t.TempDir(), ArmoredKey: armoredPublic(t, signer)}
	if _, err := h.Fetch(context.Background(), srv.Client(), "nomad", "1.9.3", "linux", "amd64", nil); err == nil ||
		!strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature failure, got %v", err)
	}
	srv2 := serve(t, buildFake(t, signer, []byte("x"), true))
	h2 := &HashiCorp{BaseURL: srv2.URL, CacheDir: t.TempDir(), ArmoredKey: armoredPublic(t, signer)}
	if _, err := h2.Fetch(context.Background(), srv2.Client(), "nomad", "1.9.3", "linux", "amd64", nil); err == nil ||
		!strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected digest failure, got %v", err)
	}
}

func TestCNIPinnedDigests(t *testing.T) {
	payload := []byte("fake tgz")
	sum := sha256.Sum256(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(payload) }))
	defer srv.Close()
	c := &CNI{BaseURL: srv.URL, CacheDir: t.TempDir()}
	if _, err := c.Fetch(context.Background(), srv.Client(), "v9.9.9", "amd64", nil); err == nil {
		t.Fatal("unregistered version must be rejected")
	}
	c.Extra = CNIChecksums{"v9.9.9": {"amd64": hex.EncodeToString(sum[:])}}
	a, err := c.Fetch(context.Background(), srv.Client(), "v9.9.9", "amd64", nil)
	if err != nil || a.Gzipped || a.PayloadSHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("fetch: %+v %v", a, err)
	}
	c.Extra = CNIChecksums{"v9.9.9": {"amd64": strings.Repeat("a", 64)}}
	c.CacheDir = t.TempDir()
	if _, err := c.Fetch(context.Background(), srv.Client(), "v9.9.9", "amd64", nil); err == nil {
		t.Fatal("digest mismatch must fail")
	}
	if v := c.Versions(); v[0] != "v9.9.9" || len(v) != len(BuiltinCNIChecksums)+1 {
		t.Fatalf("versions: %v", v)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := [][3]any{{"1.10.0", "1.9.9", 1}, {"1.9.0", "1.9.0", 0}, {"1.2.3", "1.10.0", -1}}
	for _, c := range cases {
		if got := CompareVersions(c[0].(string), c[1].(string)); got != c[2].(int) {
			t.Errorf("%v: %d", c, got)
		}
	}
}
