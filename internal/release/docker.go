package release

import (
	"bufio"
	"bytes"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/clearsign"
	"github.com/klauspost/compress/zstd"
)

// docker-release.asc holds Docker's two repository signing keys: the deb key
// signs apt InRelease files, the rpm key signs repomd.xml and the RPMs.
//
//go:embed docker-release.asc
var builtinDockerKeys string

// DockerKeyFingerprints are the expected primary fingerprints of the built-in keys.
var DockerKeyFingerprints = map[string]string{
	"deb": "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
	"rpm": "060A61C51B558A7F742B77AAC52FEB6B621E9F35",
}

// DefaultDockerBaseURL is the official Docker package repository.
const DefaultDockerBaseURL = "https://download.docker.com/linux"

// DockerPackages are the packages a managed Docker Engine install consists of.
var DockerPackages = []string{"docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"}

// Index metadata limits.
const (
	maxRepoMetaSize   = 4 << 20
	maxRepoIndexSize  = 64 << 20
	maxRepoIndexOpen  = 512 << 20
	dockerStableComp  = "stable"
	dockerRPMChecksum = "sha256"
)

var (
	reDebSuite  = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	reRPMRel    = regexp.MustCompile(`^[0-9]{1,3}$`)
	rePkgFile   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+~-]*\.(deb|rpm)$`)
	reCacheSafe = regexp.MustCompile(`[^A-Za-z0-9._+-]`)
)

// DockerTarget identifies one Docker repository: a distribution release and architecture.
type DockerTarget struct {
	Format  string `json:"format"`  // deb or rpm
	Distro  string `json:"distro"`  // ubuntu, debian, centos, rhel, fedora
	Release string `json:"release"` // deb: codename; rpm: releasever
	Arch    string `json:"arch"`    // amd64 or arm64
}

func (t DockerTarget) String() string { return t.Distro + "/" + t.Release + "/" + t.Arch }

// Validate checks every field against the supported set; the values end up in URLs and paths.
func (t DockerTarget) Validate() error {
	if t.Arch != "amd64" && t.Arch != "arm64" {
		return fmt.Errorf("Docker 仓库不支持架构 %q", t.Arch)
	}
	switch t.Format {
	case "deb":
		if t.Distro != "ubuntu" && t.Distro != "debian" {
			return fmt.Errorf("deb 仓库不支持发行版 %q", t.Distro)
		}
		if !reDebSuite.MatchString(t.Release) {
			return fmt.Errorf("发行版代号 %q 不合法", t.Release)
		}
	case "rpm":
		if t.Distro != "centos" && t.Distro != "rhel" && t.Distro != "fedora" {
			return fmt.Errorf("rpm 仓库不支持发行版 %q", t.Distro)
		}
		if !reRPMRel.MatchString(t.Release) {
			return fmt.Errorf("发行版版本 %q 不合法", t.Release)
		}
	default:
		return fmt.Errorf("未知的仓库格式 %q", t.Format)
	}
	return nil
}

func (t DockerTarget) rpmArch() string {
	if t.Arch == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

// DockerTargetFromProbe maps the host's /etc/os-release facts (as recorded
// by the host probe) to the Docker repository that serves it. Hosts outside
// the official repositories can only run Docker in external mode.
func DockerTargetFromProbe(raw map[string]string, arch string) (DockerTarget, error) {
	id := strings.ToLower(strings.TrimSpace(raw["os_id"]))
	major, _, _ := strings.Cut(strings.TrimSpace(raw["os_version_id"]), ".")
	var t DockerTarget
	switch id {
	case "ubuntu", "debian":
		t = DockerTarget{Format: "deb", Distro: id, Release: strings.TrimSpace(raw["os_codename"])}
	case "rhel":
		t = DockerTarget{Format: "rpm", Distro: "rhel", Release: major}
	case "centos", "rocky", "almalinux":
		t = DockerTarget{Format: "rpm", Distro: "centos", Release: major}
	case "fedora":
		t = DockerTarget{Format: "rpm", Distro: "fedora", Release: major}
	default:
		return DockerTarget{}, fmt.Errorf("Docker 官方仓库不支持发行版 %q，该主机只能使用 external 模式", id)
	}
	t.Arch = arch
	return t, t.Validate()
}

// DockerPackage is one package entry taken from verified repository metadata.
type DockerPackage struct {
	Name     string `json:"name"`
	Version  string `json:"version"`  // full package version (epoch, revision)
	Upstream string `json:"upstream"` // MAJOR.MINOR.PATCH
	Revision string `json:"revision"`
	Arch     string `json:"arch"`
	Filename string `json:"filename"` // path relative to the repository root
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
}

// DockerIndex is the verified package list of one repository.
type DockerIndex struct {
	Target   DockerTarget    `json:"target"`
	Packages []DockerPackage `json:"packages"`
	// repoURL is the base that package filenames are relative to.
	repoURL string
}

// Docker resolves and downloads Docker Engine packages from the official
// repository after verifying its signed metadata.
type Docker struct {
	BaseURL  string
	CacheDir string
	// ArmoredKeys overrides the built-in signing keys (key rotation). It may
	// hold several armored public key blocks.
	ArmoredKeys string
}

func (d *Docker) base() string {
	if d.BaseURL == "" {
		return DefaultDockerBaseURL
	}
	return strings.TrimRight(d.BaseURL, "/")
}

// Keyring parses the signing keys; the built-in set must contain both expected fingerprints.
func (d *Docker) Keyring() (openpgp.EntityList, error) {
	armored := d.ArmoredKeys
	if armored == "" {
		armored = builtinDockerKeys
	}
	kr, err := readArmoredKeys(armored)
	if err != nil {
		return nil, fmt.Errorf("parse Docker signing key: %w", err)
	}
	if d.ArmoredKeys == "" {
		have := map[string]bool{}
		for _, e := range kr {
			have[strings.ToUpper(hex.EncodeToString(e.PrimaryKey.Fingerprint))] = true
		}
		for kind, fp := range DockerKeyFingerprints {
			if !have[fp] {
				return nil, fmt.Errorf("built-in Docker %s signing key fingerprint mismatch", kind)
			}
		}
	}
	return kr, nil
}

// readArmoredKeys reads every armored public key block in s.
func readArmoredKeys(s string) (openpgp.EntityList, error) {
	const begin = "-----BEGIN PGP PUBLIC KEY BLOCK-----"
	var out openpgp.EntityList
	for _, chunk := range strings.Split(s, begin)[1:] {
		kr, err := openpgp.ReadArmoredKeyRing(strings.NewReader(begin + chunk))
		if err != nil {
			return nil, err
		}
		out = append(out, kr...)
	}
	if len(out) == 0 {
		return nil, errors.New("no public key block found")
	}
	return out, nil
}

// Index downloads the repository metadata for t, verifies its signature and
// the digest chain down to the package list, and returns the Docker packages.
func (d *Docker) Index(ctx context.Context, client *http.Client, t DockerTarget, log io.Writer) (*DockerIndex, error) {
	if err := t.Validate(); err != nil {
		return nil, err
	}
	kr, err := d.Keyring()
	if err != nil {
		return nil, err
	}
	if t.Format == "deb" {
		return d.debIndex(ctx, client, kr, t, log)
	}
	return d.rpmIndex(ctx, client, kr, t, log)
}

func (d *Docker) debIndex(ctx context.Context, client *http.Client, kr openpgp.EntityList, t DockerTarget, log io.Writer) (*DockerIndex, error) {
	distURL := fmt.Sprintf("%s/%s/dists/%s", d.base(), t.Distro, t.Release)
	logf(log, "下载 Docker 仓库 %s 的 InRelease\n", t)
	raw, err := get(ctx, client, distURL+"/InRelease", maxRepoMetaSize)
	if err != nil {
		return nil, err
	}
	block, _ := clearsign.Decode(raw)
	if block == nil {
		return nil, errors.New("InRelease is not a clear-signed message")
	}
	if _, err := block.VerifySignature(kr, nil); err != nil {
		return nil, fmt.Errorf("InRelease signature verification failed: %w", err)
	}
	logf(log, "InRelease 的 GPG 签名校验通过\n")
	rel := parseDebControl(block.Plaintext)
	if len(rel) == 0 {
		return nil, errors.New("InRelease has no fields")
	}
	if rel[0]["suite"] != t.Release && rel[0]["codename"] != t.Release {
		return nil, fmt.Errorf("InRelease is for suite %q, expected %q", rel[0]["suite"], t.Release)
	}
	sums := parseReleaseSHA256(rel[0]["sha256"])
	name := fmt.Sprintf("%s/binary-%s/Packages", dockerStableComp, t.Arch)
	var listPath string
	var entry releaseEntry
	for _, cand := range []string{name + ".gz", name} {
		if e, ok := sums[cand]; ok {
			listPath, entry = cand, e
			break
		}
	}
	if listPath == "" {
		return nil, fmt.Errorf("InRelease does not list %s", name)
	}
	logf(log, "下载 %s 并按 InRelease 中的摘要校验\n", listPath)
	body, err := getVerified(ctx, client, distURL+"/"+listPath, entry.sha256, entry.size, maxRepoIndexSize)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(listPath, ".gz") {
		if body, err = decompress(body, ".gz"); err != nil {
			return nil, err
		}
	}
	want := map[string]bool{}
	for _, p := range DockerPackages {
		want[p] = true
	}
	ix := &DockerIndex{Target: t, repoURL: d.base() + "/" + t.Distro}
	for _, st := range parseDebControl(body) {
		name := st["package"]
		if !want[name] || (st["architecture"] != t.Arch && st["architecture"] != "all") {
			continue
		}
		upstream, revision := debVersionParts(st["version"])
		if !isStable(upstream) {
			continue
		}
		size, _ := strconv.ParseInt(st["size"], 10, 64)
		p := DockerPackage{Name: name, Version: st["version"], Upstream: upstream, Revision: revision,
			Arch: st["architecture"], Filename: st["filename"], SHA256: strings.ToLower(st["sha256"]), Size: size}
		if err := p.check(); err != nil {
			return nil, err
		}
		ix.Packages = append(ix.Packages, p)
	}
	logf(log, "已从签名索引中取得 %d 个 Docker 安装包条目\n", len(ix.Packages))
	return ix, nil
}

func (d *Docker) rpmIndex(ctx context.Context, client *http.Client, kr openpgp.EntityList, t DockerTarget, log io.Writer) (*DockerIndex, error) {
	repoURL := fmt.Sprintf("%s/%s/%s/%s/%s", d.base(), t.Distro, t.Release, t.rpmArch(), dockerStableComp)
	logf(log, "下载 Docker 仓库 %s 的 repomd.xml 与签名\n", t)
	repomd, err := get(ctx, client, repoURL+"/repodata/repomd.xml", maxRepoMetaSize)
	if err != nil {
		return nil, err
	}
	sig, err := get(ctx, client, repoURL+"/repodata/repomd.xml.asc", maxRepoMetaSize)
	if err != nil {
		return nil, err
	}
	if _, err := openpgp.CheckArmoredDetachedSignature(kr, bytes.NewReader(repomd), bytes.NewReader(sig), nil); err != nil {
		return nil, fmt.Errorf("repomd.xml signature verification failed: %w", err)
	}
	logf(log, "repomd.xml 的 GPG 签名校验通过\n")
	var md struct {
		Data []struct {
			Type     string `xml:"type,attr"`
			Checksum struct {
				Type  string `xml:"type,attr"`
				Value string `xml:",chardata"`
			} `xml:"checksum"`
			OpenChecksum struct {
				Type  string `xml:"type,attr"`
				Value string `xml:",chardata"`
			} `xml:"open-checksum"`
			Location struct {
				Href string `xml:"href,attr"`
			} `xml:"location"`
			Size int64 `xml:"size"`
		} `xml:"data"`
	}
	if err := xml.Unmarshal(repomd, &md); err != nil {
		return nil, fmt.Errorf("parse repomd.xml: %w", err)
	}
	for _, data := range md.Data {
		if data.Type != "primary" {
			continue
		}
		if data.Checksum.Type != dockerRPMChecksum || !reSHA.MatchString(strings.TrimSpace(data.Checksum.Value)) {
			return nil, errors.New("repomd.xml primary entry has no sha256 checksum")
		}
		href := data.Location.Href
		if err := checkRelPath(href); err != nil {
			return nil, err
		}
		logf(log, "下载 %s 并按 repomd.xml 中的摘要校验\n", path.Base(href))
		body, err := getVerified(ctx, client, repoURL+"/"+href, strings.TrimSpace(data.Checksum.Value), data.Size, maxRepoIndexSize)
		if err != nil {
			return nil, err
		}
		if body, err = decompress(body, path.Ext(href)); err != nil {
			return nil, err
		}
		if oc := strings.TrimSpace(data.OpenChecksum.Value); oc != "" && data.OpenChecksum.Type == dockerRPMChecksum {
			if got := sha256Hex(body); got != strings.ToLower(oc) {
				return nil, fmt.Errorf("primary metadata open-checksum mismatch: got %s, want %s", got, oc)
			}
		}
		pkgs, err := parsePrimary(body, t.rpmArch())
		if err != nil {
			return nil, err
		}
		logf(log, "已从签名索引中取得 %d 个 Docker 安装包条目\n", len(pkgs))
		return &DockerIndex{Target: t, Packages: pkgs, repoURL: repoURL}, nil
	}
	return nil, errors.New("repomd.xml has no primary metadata")
}

func parsePrimary(body []byte, arch string) ([]DockerPackage, error) {
	want := map[string]bool{}
	for _, p := range DockerPackages {
		want[p] = true
	}
	dec := xml.NewDecoder(bytes.NewReader(body))
	var out []DockerPackage
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("parse primary metadata: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "package" {
			continue
		}
		var rp struct {
			Name    string `xml:"name"`
			Arch    string `xml:"arch"`
			Version struct {
				Epoch string `xml:"epoch,attr"`
				Ver   string `xml:"ver,attr"`
				Rel   string `xml:"rel,attr"`
			} `xml:"version"`
			Checksum struct {
				Type  string `xml:"type,attr"`
				Value string `xml:",chardata"`
			} `xml:"checksum"`
			Size struct {
				Package int64 `xml:"package,attr"`
			} `xml:"size"`
			Location struct {
				Href string `xml:"href,attr"`
			} `xml:"location"`
		}
		if err := dec.DecodeElement(&rp, &se); err != nil {
			return nil, fmt.Errorf("parse primary metadata: %w", err)
		}
		if !want[rp.Name] || (rp.Arch != arch && rp.Arch != "noarch") || !isStable(rp.Version.Ver) {
			continue
		}
		if rp.Checksum.Type != dockerRPMChecksum {
			return nil, fmt.Errorf("package %s has no sha256 checksum", rp.Name)
		}
		version := rp.Version.Ver + "-" + rp.Version.Rel
		if rp.Version.Epoch != "" && rp.Version.Epoch != "0" {
			version = rp.Version.Epoch + ":" + version
		}
		p := DockerPackage{Name: rp.Name, Version: version, Upstream: rp.Version.Ver, Revision: rp.Version.Rel,
			Arch: rp.Arch, Filename: rp.Location.Href, SHA256: strings.ToLower(strings.TrimSpace(rp.Checksum.Value)), Size: rp.Size.Package}
		if err := p.check(); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
}

func (p DockerPackage) check() error {
	if !reSHA.MatchString(p.SHA256) {
		return fmt.Errorf("package %s %s has a malformed sha256", p.Name, p.Version)
	}
	if err := checkRelPath(p.Filename); err != nil {
		return err
	}
	if !rePkgFile.MatchString(path.Base(p.Filename)) {
		return fmt.Errorf("package %s has an unexpected file name %q", p.Name, path.Base(p.Filename))
	}
	return nil
}

// checkRelPath rejects repository paths that could escape the repository root.
func checkRelPath(p string) error {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\?#%") || strings.Contains(p, "://") {
		return fmt.Errorf("repository path %q is not allowed", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("repository path %q is not allowed", p)
		}
	}
	return nil
}

// EngineVersions lists Docker Engine versions for which both docker-ce and
// docker-ce-cli are published, newest first.
func (ix *DockerIndex) EngineVersions() []string {
	cli := map[string]bool{}
	for _, p := range ix.Packages {
		if p.Name == "docker-ce-cli" {
			cli[p.Upstream] = true
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, p := range ix.Packages {
		if p.Name == "docker-ce" && cli[p.Upstream] && !seen[p.Upstream] {
			seen[p.Upstream] = true
			out = append(out, p.Upstream)
		}
	}
	sort.Slice(out, func(i, j int) bool { return CompareVersions(out[i], out[j]) > 0 })
	return out
}

// Resolve picks the package set for a Docker Engine version: docker-ce and
// docker-ce-cli at that version, and the newest containerd.io, buildx and
// compose plugins (each at its newest packaging revision).
func (ix *DockerIndex) Resolve(version string) ([]DockerPackage, error) {
	if !isStable(version) {
		return nil, fmt.Errorf("invalid Docker version %q", version)
	}
	var out []DockerPackage
	for _, name := range DockerPackages {
		var best *DockerPackage
		for i := range ix.Packages {
			p := &ix.Packages[i]
			if p.Name != name {
				continue
			}
			if (name == "docker-ce" || name == "docker-ce-cli") && p.Upstream != version {
				continue
			}
			if best == nil || comparePackage(*p, *best) > 0 {
				best = p
			}
		}
		if best == nil {
			if name == "docker-ce" || name == "docker-ce-cli" {
				return nil, fmt.Errorf("Docker %s 在 %s 仓库中没有 %s 安装包", version, ix.Target, name)
			}
			return nil, fmt.Errorf("%s 仓库中没有 %s 安装包", ix.Target, name)
		}
		out = append(out, *best)
	}
	return out, nil
}

func comparePackage(a, b DockerPackage) int {
	if c := CompareVersions(a.Upstream, b.Upstream); c != 0 {
		return c
	}
	ra, rb := leadingInt(a.Revision), leadingInt(b.Revision)
	switch {
	case ra > rb:
		return 1
	case ra < rb:
		return -1
	}
	return strings.Compare(a.Revision, b.Revision)
}

func leadingInt(s string) int {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	n, _ := strconv.Atoi(s[:i])
	return n
}

// Fetch resolves version in t's verified index and returns the packages,
// each downloaded once, checked against the index digest and cached. The
// packages are distributed as-is (no gzip wrapping).
func (d *Docker) Fetch(ctx context.Context, client *http.Client, t DockerTarget, version string, log io.Writer) ([]*Artifact, error) {
	ix, err := d.Index(ctx, client, t, log)
	if err != nil {
		return nil, err
	}
	pkgs, err := ix.Resolve(version)
	if err != nil {
		return nil, err
	}
	var out []*Artifact
	for _, p := range pkgs {
		a, err := d.fetchPackage(ctx, client, ix, p, log)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func (d *Docker) fetchPackage(ctx context.Context, client *http.Client, ix *DockerIndex, p DockerPackage, log io.Writer) (*Artifact, error) {
	t := ix.Target
	file := path.Base(p.Filename)
	dir := filepath.Join(d.CacheDir, "docker", t.Distro, t.Release, t.Arch, p.Name, reCacheSafe.ReplaceAllString(p.Version, "_"))
	unlock := lockArtifact(dir)
	defer unlock()
	if a, err := loadCached(dir); err == nil && a.PayloadSHA256 == p.SHA256 && a.PayloadName == file {
		logf(log, "使用已缓存并校验过的 %s\n", file)
		return a, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	logf(log, "下载 %s\n", file)
	dst := filepath.Join(dir, file)
	if err := download(ctx, client, ix.repoURL+"/"+p.Filename, dst, p.SHA256); err != nil {
		return nil, err
	}
	logf(log, "%s 的 SHA256 与签名索引一致\n", file)
	return finalize(dir, dst, &Artifact{Product: p.Name, Version: p.Version, OS: t.Distro + "-" + t.Release, Arch: t.Arch,
		ArchiveSHA256: p.SHA256, PayloadName: file, Gzipped: false})
}

// getVerified downloads a metadata file and checks its size (when known) and SHA-256.
func getVerified(ctx context.Context, client *http.Client, url, wantSHA string, wantSize, max int64) ([]byte, error) {
	body, err := get(ctx, client, url, max+1)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > max {
		return nil, fmt.Errorf("%s exceeds %d bytes", path.Base(url), max)
	}
	if wantSize > 0 && int64(len(body)) != wantSize {
		return nil, fmt.Errorf("size mismatch for %s: got %d, want %d", path.Base(url), len(body), wantSize)
	}
	if got := sha256Hex(body); got != strings.ToLower(wantSHA) {
		return nil, fmt.Errorf("sha256 mismatch for %s: got %s, want %s", path.Base(url), got, wantSHA)
	}
	return body, nil
}

func decompress(body []byte, ext string) ([]byte, error) {
	var r io.Reader
	switch ext {
	case ".gz":
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		r = zr
	case ".bz2":
		r = bzip2.NewReader(bytes.NewReader(body))
	case ".zst":
		zr, err := zstd.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr
	case ".xml":
		return body, nil
	default:
		return nil, fmt.Errorf("unsupported metadata compression %q", ext)
	}
	out, err := io.ReadAll(io.LimitReader(r, maxRepoIndexOpen+1))
	if err != nil {
		return nil, err
	}
	if len(out) > maxRepoIndexOpen {
		return nil, errors.New("decompressed metadata is too large")
	}
	return out, nil
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// parseDebControl parses Debian control-format stanzas. Keys are
// lower-cased; continuation lines are joined with newlines.
func parseDebControl(b []byte) []map[string]string {
	var out []map[string]string
	cur := map[string]string{}
	last := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			if len(cur) > 0 {
				out = append(out, cur)
				cur, last = map[string]string{}, ""
			}
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			if last != "" {
				cur[last] += "\n" + strings.TrimSpace(line)
			}
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		last = strings.ToLower(strings.TrimSpace(k))
		cur[last] = strings.TrimSpace(v)
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

type releaseEntry struct {
	sha256 string
	size   int64
}

// parseReleaseSHA256 parses the SHA256 field of a Release file ("<sha> <size> <path>" lines).
func parseReleaseSHA256(field string) map[string]releaseEntry {
	out := map[string]releaseEntry{}
	for _, line := range strings.Split(field, "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || !reSHA.MatchString(strings.ToLower(f[0])) {
			continue
		}
		size, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			continue
		}
		out[f[2]] = releaseEntry{sha256: strings.ToLower(f[0]), size: size}
	}
	return out
}

// debVersionParts splits "[epoch:]upstream[-revision]" into upstream and revision.
func debVersionParts(v string) (upstream, revision string) {
	if _, rest, ok := strings.Cut(v, ":"); ok {
		v = rest
	}
	if i := strings.LastIndex(v, "-"); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}
