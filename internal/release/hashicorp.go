// Package release resolves, downloads and verifies product releases on the
// control plane: HashiCorp products via PGP-signed SHA256SUMS and CNI
// plugins via pinned SHA-256 tables. Verified artifacts are cached and
// prepared (decompressed, re-compressed with gzip) for relay distribution.
package release

import (
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/ProtonMail/go-crypto/openpgp"
)

//go:embed hashicorp-release.asc
var builtinHashiCorpKey string

// HashiCorpKeyFingerprint is the expected primary key fingerprint.
const HashiCorpKeyFingerprint = "C874011F0AB405110D02105534365D9472D7468F"

// Minimum supported versions.
var MinVersions = map[string]string{"nomad": "1.9.0", "vault": "1.15.0"}

// DefaultBaseURL is the official HashiCorp release site.
const DefaultBaseURL = "https://releases.hashicorp.com"

// Artifact is a verified, cached release ready for distribution.
type Artifact struct {
	Product       string `json:"product"`
	Version       string `json:"version"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	ArchiveSHA256 string `json:"archive_sha256"`
	// Payload is what gets installed on hosts (the binary, or the archive for CNI).
	PayloadName   string `json:"payload_name"`
	PayloadSHA256 string `json:"payload_sha256"`
	PayloadSize   int64  `json:"payload_size"`
	// GzipPath is the gzip-compressed payload used for transfer.
	GzipPath string `json:"-"`
	// Gzipped reports whether GzipPath must be decompressed on the host.
	Gzipped bool `json:"gzipped"`
}

// HashiCorp downloads HashiCorp products.
type HashiCorp struct {
	BaseURL  string
	CacheDir string
	// ArmoredKey overrides the built-in signing key (key rotation).
	ArmoredKey string
}

func (h *HashiCorp) base() string {
	if h.BaseURL == "" {
		return DefaultBaseURL
	}
	return strings.TrimRight(h.BaseURL, "/")
}

// Keyring parses the signing key and checks its fingerprint when built in.
func (h *HashiCorp) Keyring() (openpgp.EntityList, error) {
	armored := h.ArmoredKey
	if armored == "" {
		armored = builtinHashiCorpKey
	}
	kr, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armored))
	if err != nil {
		return nil, fmt.Errorf("parse release signing key: %w", err)
	}
	if h.ArmoredKey == "" {
		fp := strings.ToUpper(hex.EncodeToString(kr[0].PrimaryKey.Fingerprint))
		if fp != HashiCorpKeyFingerprint {
			return nil, fmt.Errorf("built-in signing key fingerprint mismatch: %s", fp)
		}
	}
	return kr, nil
}

// Versions lists stable versions at or above the supported minimum, newest first.
func (h *HashiCorp) Versions(ctx context.Context, client *http.Client, product string) ([]string, error) {
	if _, ok := MinVersions[product]; !ok {
		return nil, fmt.Errorf("unsupported product %q", product)
	}
	body, err := get(ctx, client, h.base()+"/"+product+"/index.json", 32<<20)
	if err != nil {
		return nil, err
	}
	var idx struct {
		Versions map[string]json.RawMessage `json:"versions"`
	}
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, fmt.Errorf("parse release index: %w", err)
	}
	min := MinVersions[product]
	var out []string
	for v := range idx.Versions {
		if isStable(v) && CompareVersions(v, min) >= 0 {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return CompareVersions(out[i], out[j]) > 0 })
	return out, nil
}

// Fetch returns a verified artifact, downloading it when not cached.
func (h *HashiCorp) Fetch(ctx context.Context, client *http.Client, product, version, goos, arch string, log io.Writer) (*Artifact, error) {
	if _, ok := MinVersions[product]; !ok {
		return nil, fmt.Errorf("unsupported product %q", product)
	}
	if !isStable(version) {
		return nil, fmt.Errorf("invalid or unsupported version %q", version)
	}
	if CompareVersions(version, MinVersions[product]) < 0 {
		return nil, fmt.Errorf("%s %s is below the supported minimum %s", product, version, MinVersions[product])
	}
	dir := filepath.Join(h.CacheDir, product, version, goos+"_"+arch)
	unlock := lockArtifact(dir)
	defer unlock()
	if a, err := loadCached(dir); err == nil {
		logf(log, "使用已缓存并校验过的 %s %s（%s/%s）\n", product, version, goos, arch)
		return a, nil
	}
	kr, err := h.Keyring()
	if err != nil {
		return nil, err
	}
	prefix := fmt.Sprintf("%s/%s/%s/%s_%s", h.base(), product, version, product, version)
	logf(log, "下载 %s_SHA256SUMS 与签名\n", filepath.Base(prefix))
	sums, err := get(ctx, client, prefix+"_SHA256SUMS", 1<<20)
	if err != nil {
		return nil, err
	}
	sig, err := get(ctx, client, prefix+"_SHA256SUMS.sig", 1<<20)
	if err != nil {
		return nil, err
	}
	if _, err := openpgp.CheckDetachedSignature(kr, bytes.NewReader(sums), bytes.NewReader(sig), nil); err != nil {
		return nil, fmt.Errorf("SHA256SUMS signature verification failed: %w", err)
	}
	logf(log, "SHA256SUMS 的 PGP 签名校验通过\n")
	zipName := fmt.Sprintf("%s_%s_%s_%s.zip", product, version, goos, arch)
	want, err := lookupSum(sums, zipName)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	zipPath := filepath.Join(dir, zipName)
	logf(log, "下载 %s\n", zipName)
	if err := download(ctx, client, prefix+"_"+goos+"_"+arch+".zip", zipPath, want); err != nil {
		return nil, err
	}
	logf(log, "%s 的 SHA256 与签名摘要一致\n", zipName)
	binPath := filepath.Join(dir, product)
	if err := extractZipMember(zipPath, product, binPath); err != nil {
		return nil, err
	}
	a, err := finalize(dir, binPath, &Artifact{Product: product, Version: version, OS: goos, Arch: arch,
		ArchiveSHA256: want, PayloadName: product, Gzipped: true})
	if err != nil {
		return nil, err
	}
	_ = os.Remove(zipPath)
	return a, nil
}

var (
	artifactMu    sync.Mutex
	artifactLocks = map[string]*sync.Mutex{}
)

// lockArtifact serializes downloads of the same artifact across the process.
func lockArtifact(key string) func() {
	artifactMu.Lock()
	l := artifactLocks[key]
	if l == nil {
		l = &sync.Mutex{}
		artifactLocks[key] = l
	}
	artifactMu.Unlock()
	l.Lock()
	return l.Unlock
}

// finalize computes the payload digest, writes the gzip transfer copy and
// the cache metadata. payloadPath is removed when gzipping is requested.
func finalize(dir, payloadPath string, a *Artifact) (*Artifact, error) {
	sum, size, err := fileSHA256(payloadPath)
	if err != nil {
		return nil, err
	}
	a.PayloadSHA256, a.PayloadSize = sum, size
	if a.Gzipped {
		a.GzipPath = payloadPath + ".gz"
		if err := gzipFile(payloadPath, a.GzipPath); err != nil {
			return nil, err
		}
		_ = os.Remove(payloadPath)
	} else {
		a.GzipPath = payloadPath
	}
	meta, _ := json.Marshal(a)
	if err := os.WriteFile(filepath.Join(dir, "artifact.json"), meta, 0o600); err != nil {
		return nil, err
	}
	return a, nil
}

func loadCached(dir string) (*Artifact, error) {
	b, err := os.ReadFile(filepath.Join(dir, "artifact.json"))
	if err != nil {
		return nil, err
	}
	var a Artifact
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	if a.Gzipped {
		a.GzipPath = filepath.Join(dir, a.PayloadName+".gz")
	} else {
		a.GzipPath = filepath.Join(dir, a.PayloadName)
	}
	// Re-verify the cached payload before trusting it.
	if a.Gzipped {
		f, err := os.Open(a.GzipPath)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		zr, err := gzip.NewReader(f)
		if err != nil {
			return nil, err
		}
		hsh := sha256.New()
		if _, err := io.Copy(hsh, zr); err != nil {
			return nil, err
		}
		if hex.EncodeToString(hsh.Sum(nil)) != a.PayloadSHA256 {
			return nil, errors.New("cached artifact corrupted")
		}
	} else if sum, _, err := fileSHA256(a.GzipPath); err != nil || sum != a.PayloadSHA256 {
		return nil, errors.New("cached artifact corrupted")
	}
	return &a, nil
}

func lookupSum(sums []byte, name string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			if len(f[0]) != 64 {
				return "", fmt.Errorf("malformed checksum for %s", name)
			}
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("%s not found in SHA256SUMS", name)
}

func get(ctx context.Context, client *http.Client, url string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, max))
}

// download streams url to dst and verifies its SHA-256.
func download(ctx context.Context, client *http.Client, url, dst, wantSHA string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	tmp := dst + ".part"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, 2<<30)); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		os.Remove(tmp)
		return fmt.Errorf("sha256 mismatch for %s: got %s, want %s", filepath.Base(dst), got, wantSHA)
	}
	return os.Rename(tmp, dst)
}

func extractZipMember(zipPath, member, dst string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != member {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o700)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, io.LimitReader(rc, 2<<30)); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("%s not found in archive", member)
}

func fileSHA256(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func gzipFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	zw, _ := gzip.NewWriterLevel(out, gzip.BestCompression)
	if _, err := io.Copy(zw, in); err != nil {
		out.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func logf(w io.Writer, format string, args ...any) {
	if w != nil {
		fmt.Fprintf(w, format, args...)
	}
}

// isStable accepts plain MAJOR.MINOR.PATCH versions (no pre-release, no enterprise).
func isStable(v string) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil || p == "" {
			return false
		}
	}
	return true
}

// CompareVersions compares MAJOR.MINOR.PATCH strings numerically.
func CompareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(strings.SplitN(pa[i], "-", 2)[0])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(strings.SplitN(pb[i], "-", 2)[0])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
