package release

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/clearsign"
	"github.com/klauspost/compress/zstd"
)

func TestBuiltinDockerKeys(t *testing.T) {
	kr, err := (&Docker{}).Keyring()
	if err != nil {
		t.Fatal(err)
	}
	if len(kr) != 2 {
		t.Fatalf("expected the deb and rpm keys, got %d", len(kr))
	}
}

type fakePkg struct{ name, version, upstream, arch string }

var fakePkgs = []fakePkg{
	{"docker-ce", "5:27.3.1-1~ubuntu.24.04~noble", "27.3.1", "amd64"},
	{"docker-ce", "5:27.3.0-1~ubuntu.24.04~noble", "27.3.0", "amd64"},
	{"docker-ce", "5:27.4.0-1~ubuntu.24.04~noble", "27.4.0", "amd64"}, // no matching cli
	{"docker-ce", "5:28.0.0~rc.1-1~ubuntu.24.04~noble", "28.0.0~rc.1", "amd64"},
	{"docker-ce", "5:27.5.0-1~ubuntu.24.04~noble", "27.5.0", "arm64"},
	{"docker-ce-cli", "5:27.3.1-1~ubuntu.24.04~noble", "27.3.1", "amd64"},
	{"docker-ce-cli", "5:27.3.0-1~ubuntu.24.04~noble", "27.3.0", "amd64"},
	{"containerd.io", "1.7.21-1", "1.7.21", "amd64"},
	{"containerd.io", "1.7.22-2", "1.7.22", "amd64"},
	{"containerd.io", "1.7.22-1", "1.7.22", "amd64"},
	{"docker-buildx-plugin", "0.17.1-1~ubuntu.24.04~noble", "0.17.1", "amd64"},
	{"docker-compose-plugin", "2.29.7-1~ubuntu.24.04~noble", "2.29.7", "amd64"},
	{"docker-ce-rootless-extras", "5:27.3.1-1~ubuntu.24.04~noble", "27.3.1", "amd64"},
}

func pkgBody(name, version string) []byte { return []byte("package " + name + " " + version) }

// fakeDebRepo builds a signed apt repository served under /ubuntu.
func fakeDebRepo(t *testing.T, signer *openpgp.Entity) map[string][]byte {
	files := map[string][]byte{}
	var packages bytes.Buffer
	for _, p := range fakePkgs {
		file := fmt.Sprintf("%s_%s_%s.deb", p.name, strings.SplitN(p.version, ":", 2)[len(strings.SplitN(p.version, ":", 2))-1], p.arch)
		rel := "dists/noble/pool/stable/" + p.arch + "/" + file
		body := pkgBody(p.name, p.version)
		files["/ubuntu/"+rel] = body
		fmt.Fprintf(&packages, "Package: %s\nArchitecture: %s\nVersion: %s\nDescription: test\n multi-line\nFilename: %s\nSize: %d\nSHA256: %s\n\n",
			p.name, p.arch, p.version, rel, len(body), sha256Hex(body))
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(packages.Bytes())
	zw.Close()
	files["/ubuntu/dists/noble/stable/binary-amd64/Packages.gz"] = gz.Bytes()
	release := fmt.Sprintf("Origin: Docker\nSuite: noble\nSHA256:\n %s %d stable/binary-amd64/Packages.gz\n %s %d stable/binary-amd64/Packages\n",
		sha256Hex(gz.Bytes()), gz.Len(), sha256Hex(packages.Bytes()), packages.Len())
	var signed bytes.Buffer
	w, err := clearsign.Encode(&signed, signer.PrivateKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte(release))
	w.Close()
	files["/ubuntu/dists/noble/InRelease"] = signed.Bytes()
	return files
}

// fakeRPMRepo builds a signed yum repository served under /centos/9/x86_64/stable.
func fakeRPMRepo(t *testing.T, signer *openpgp.Entity) map[string][]byte {
	files := map[string][]byte{}
	const repo = "/centos/9/x86_64/stable/"
	var primary bytes.Buffer
	primary.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm">`)
	for _, p := range fakePkgs {
		if p.arch != "amd64" || strings.Contains(p.upstream, "~") {
			continue
		}
		file := fmt.Sprintf("Packages/%s-%s-1.el9.x86_64.rpm", p.name, p.upstream)
		body := pkgBody(p.name, p.upstream)
		files[repo+file] = body
		fmt.Fprintf(&primary, `<package type="rpm"><name>%s</name><arch>x86_64</arch><version epoch="3" ver="%s" rel="1.el9"/>
<checksum type="sha256" pkgid="YES">%s</checksum><size package="%d"/><location href="%s"/>
<format><rpm:license>Apache-2.0</rpm:license></format></package>`, p.name, p.upstream, sha256Hex(body), len(body), file)
	}
	primary.WriteString(`</metadata>`)
	enc, _ := zstd.NewWriter(nil)
	zst := enc.EncodeAll(primary.Bytes(), nil)
	href := "repodata/" + sha256Hex(zst) + "-primary.xml.zst"
	files[repo+href] = zst
	repomd := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo"><data type="primary"><checksum type="sha256">%s</checksum>
<open-checksum type="sha256">%s</open-checksum><location href="%s"/><size>%d</size></data></repomd>`,
		sha256Hex(zst), sha256Hex(primary.Bytes()), href, len(zst))
	files[repo+"repodata/repomd.xml"] = []byte(repomd)
	var sig bytes.Buffer
	if err := openpgp.ArmoredDetachSign(&sig, signer, strings.NewReader(repomd), nil); err != nil {
		t.Fatal(err)
	}
	files[repo+"repodata/repomd.xml.asc"] = sig.Bytes()
	return files
}

func serveFiles(t *testing.T, files map[string][]byte) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDockerDebIndexAndFetch(t *testing.T) {
	signer, _ := openpgp.NewEntity("docker-test", "", "deb@example.com", nil)
	srv := serveFiles(t, fakeDebRepo(t, signer))
	d := &Docker{BaseURL: srv.URL, CacheDir: t.TempDir(), ArmoredKeys: armoredPublic(t, signer)}
	target := DockerTarget{Format: "deb", Distro: "ubuntu", Release: "noble", Arch: "amd64"}
	ix, err := d.Index(context.Background(), srv.Client(), target, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ix.EngineVersions(), ","); got != "27.3.1,27.3.0" {
		t.Fatalf("engine versions (stable, with cli, this arch): %s", got)
	}
	arts, err := d.Fetch(context.Background(), srv.Client(), target, "27.3.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, a := range arts {
		names = append(names, a.Product+"="+a.Version)
		body, _ := os.ReadFile(a.GzipPath)
		if a.Gzipped || sha256Hex(body) != a.PayloadSHA256 || !strings.HasSuffix(a.PayloadName, ".deb") {
			t.Fatalf("artifact %+v", a)
		}
	}
	want := "docker-ce=5:27.3.1-1~ubuntu.24.04~noble,docker-ce-cli=5:27.3.1-1~ubuntu.24.04~noble,containerd.io=1.7.22-2," +
		"docker-buildx-plugin=0.17.1-1~ubuntu.24.04~noble,docker-compose-plugin=2.29.7-1~ubuntu.24.04~noble"
	if strings.Join(names, ",") != want {
		t.Fatalf("resolved packages:\n%s\nwant\n%s", strings.Join(names, ","), want)
	}
	if _, err := d.Fetch(context.Background(), srv.Client(), target, "27.4.0", nil); err == nil {
		t.Fatal("a version without docker-ce-cli must not resolve")
	}
}

func TestDockerRPMIndexAndFetch(t *testing.T) {
	signer, _ := openpgp.NewEntity("docker-test", "", "rpm@example.com", nil)
	srv := serveFiles(t, fakeRPMRepo(t, signer))
	d := &Docker{BaseURL: srv.URL, CacheDir: t.TempDir(), ArmoredKeys: armoredPublic(t, signer)}
	target := DockerTarget{Format: "rpm", Distro: "centos", Release: "9", Arch: "amd64"}
	arts, err := d.Fetch(context.Background(), srv.Client(), target, "27.3.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(arts) != len(DockerPackages) || arts[0].Version != "3:27.3.0-1.el9" || arts[2].Version != "3:1.7.22-1.el9" {
		t.Fatalf("artifacts: %+v %+v", arts[0], arts[2])
	}
	// Second fetch is served from the cache.
	srv.Close()
	if _, err := d.fetchPackage(context.Background(), http.DefaultClient,
		&DockerIndex{Target: target, repoURL: "http://127.0.0.1:1"},
		DockerPackage{Name: "docker-ce", Version: "3:27.3.0-1.el9", Filename: "Packages/docker-ce-27.3.0-1.el9.x86_64.rpm",
			SHA256: arts[0].PayloadSHA256}, nil); err != nil {
		t.Fatalf("cache: %v", err)
	}
}

func TestDockerRejectsTampering(t *testing.T) {
	signer, _ := openpgp.NewEntity("docker-test", "", "a@example.com", nil)
	other, _ := openpgp.NewEntity("evil", "", "b@example.com", nil)
	deb := DockerTarget{Format: "deb", Distro: "ubuntu", Release: "noble", Arch: "amd64"}
	rpm := DockerTarget{Format: "rpm", Distro: "centos", Release: "9", Arch: "amd64"}
	cases := []struct {
		name   string
		target DockerTarget
		key    *openpgp.Entity
		mutate func(files map[string][]byte)
		want   string
	}{
		{"deb wrong signer", deb, other, nil, "signature verification failed"},
		{"deb tampered InRelease", deb, signer, func(f map[string][]byte) {
			f["/ubuntu/dists/noble/InRelease"] = bytes.Replace(f["/ubuntu/dists/noble/InRelease"], []byte("Origin: Docker"), []byte("Origin: Dockex"), 1)
		}, "signature verification failed"},
		{"deb tampered Packages", deb, signer, func(f map[string][]byte) {
			f["/ubuntu/dists/noble/stable/binary-amd64/Packages.gz"] = append(f["/ubuntu/dists/noble/stable/binary-amd64/Packages.gz"], 0)
		}, "mismatch"},
		{"deb tampered package", deb, signer, func(f map[string][]byte) {
			f["/ubuntu/dists/noble/pool/stable/amd64/docker-ce_27.3.1-1~ubuntu.24.04~noble_amd64.deb"] = []byte("evil")
		}, "sha256 mismatch"},
		{"deb other suite", DockerTarget{Format: "deb", Distro: "ubuntu", Release: "jammy", Arch: "amd64"}, signer, func(f map[string][]byte) {
			f["/ubuntu/dists/jammy/InRelease"] = f["/ubuntu/dists/noble/InRelease"]
		}, "expected \"jammy\""},
		{"rpm wrong signer", rpm, other, nil, "signature verification failed"},
		{"rpm tampered repomd", rpm, signer, func(f map[string][]byte) {
			k := "/centos/9/x86_64/stable/repodata/repomd.xml"
			f[k] = bytes.Replace(f[k], []byte("<size>"), []byte("<size>1"), 1)
		}, "signature verification failed"},
		{"rpm tampered package", rpm, signer, func(f map[string][]byte) {
			f["/centos/9/x86_64/stable/Packages/docker-ce-27.3.1-1.el9.x86_64.rpm"] = []byte("evil")
		}, "sha256 mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := fakeDebRepo(t, signer)
			for k, v := range fakeRPMRepo(t, signer) {
				files[k] = v
			}
			if tc.mutate != nil {
				tc.mutate(files)
			}
			srv := serveFiles(t, files)
			d := &Docker{BaseURL: srv.URL, CacheDir: t.TempDir(), ArmoredKeys: armoredPublic(t, tc.key)}
			_, err := d.Fetch(context.Background(), srv.Client(), tc.target, "27.3.1", nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want error containing %q", err, tc.want)
			}
		})
	}
}

func TestDockerPathChecks(t *testing.T) {
	for _, p := range []string{"../etc/passwd", "/abs.deb", "a//b.deb", "a/./b.deb", "http://x/a.deb", "a/b.deb?x", "a\\b.deb"} {
		if checkRelPath(p) == nil {
			t.Errorf("%q must be rejected", p)
		}
	}
	bad := DockerPackage{Name: "docker-ce", SHA256: strings.Repeat("a", 64), Filename: "pool/x/evil.sh"}
	if bad.check() == nil {
		t.Error("non-package file names must be rejected")
	}
}

func TestDockerTargetFromProbe(t *testing.T) {
	cases := []struct {
		raw  map[string]string
		arch string
		want string
		err  bool
	}{
		{map[string]string{"os_id": "ubuntu", "os_version_id": "24.04", "os_codename": "noble"}, "amd64", "deb ubuntu/noble/amd64", false},
		{map[string]string{"os_id": "debian", "os_version_id": "12", "os_codename": "bookworm"}, "arm64", "deb debian/bookworm/arm64", false},
		{map[string]string{"os_id": "rocky", "os_version_id": "9.4"}, "amd64", "rpm centos/9/amd64", false},
		{map[string]string{"os_id": "rhel", "os_version_id": "8.10"}, "arm64", "rpm rhel/8/arm64", false},
		{map[string]string{"os_id": "fedora", "os_version_id": "41"}, "amd64", "rpm fedora/41/amd64", false},
		{map[string]string{"os_id": "linuxmint", "os_id_like": "ubuntu debian", "os_codename": "wilma"}, "amd64", "", true},
		{map[string]string{"os_id": "ubuntu", "os_codename": ""}, "amd64", "", true},
		{map[string]string{"os_id": "ubuntu", "os_codename": "noble"}, "s390x", "", true},
	}
	for _, tc := range cases {
		got, err := DockerTargetFromProbe(tc.raw, tc.arch)
		if tc.err {
			if err == nil {
				t.Errorf("%v: expected an error", tc.raw)
			}
			continue
		}
		if err != nil || got.Format+" "+got.String() != tc.want {
			t.Errorf("%v: got %v %v, want %s", tc.raw, got, err, tc.want)
		}
	}
}

// TestDockerLiveIndex verifies the real Docker repositories with the
// built-in keys. Run with NOMAD_DECK_LIVE_DOCKER=1.
func TestDockerLiveIndex(t *testing.T) {
	if os.Getenv("NOMAD_DECK_LIVE_DOCKER") != "1" {
		t.Skip("set NOMAD_DECK_LIVE_DOCKER=1 to check the real Docker repositories")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	d := &Docker{CacheDir: t.TempDir()}
	for _, target := range []DockerTarget{
		{Format: "deb", Distro: "ubuntu", Release: "noble", Arch: "amd64"},
		{Format: "deb", Distro: "debian", Release: "bookworm", Arch: "arm64"},
		{Format: "rpm", Distro: "centos", Release: "9", Arch: "amd64"},
		{Format: "rpm", Distro: "rhel", Release: "9", Arch: "arm64"},
		{Format: "rpm", Distro: "fedora", Release: "41", Arch: "amd64"},
	} {
		ix, err := d.Index(ctx, http.DefaultClient, target, nil)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		versions := ix.EngineVersions()
		if len(versions) == 0 {
			t.Fatalf("%s: no engine versions", target)
		}
		pkgs, err := ix.Resolve(versions[0])
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		var names []string
		for _, p := range pkgs {
			names = append(names, p.Name+"="+p.Version)
		}
		t.Logf("%s: %d versions, newest %s -> %s", target, len(versions), versions[0], strings.Join(names, " "))
	}
}
