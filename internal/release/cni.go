package release

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// CNIChecksums maps version -> arch -> SHA-256 of cni-plugins-linux-<arch>-<version>.tgz.
type CNIChecksums map[string]map[string]string

// BuiltinCNIChecksums were checked against the upstream release digests when
// this NomadDeck release was built. Only these versions (plus versions an
// admin registers in release.cni_checksums) can be installed.
var BuiltinCNIChecksums = CNIChecksums{
	"v1.10.0": {
		"amd64": "ce8603d6a1bd448efba5bd6dc44f38dce349f821aa57e1bb354b52628ebf1853",
		"arm64": "4f25d7f136be368746185fba6557d799cf3e1890f7556d450744ea20d300d68c",
	},
	"v1.9.1": {
		"amd64": "b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303",
		"arm64": "56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec",
	},
	"v1.9.0": {
		"amd64": "58c03705426e929658f45a851df15a86d06ef680cacbf3f2dc127731ca265c28",
		"arm64": "2596ef56329dd1269026f46b8df262f09ba43c92dbfb940e1e69fbccccd30a29",
	},
	"v1.8.0": {
		"amd64": "ab3bda535f9d90766cccc90d3dddb5482003dd744d7f22bcf98186bf8eea8be6",
		"arm64": "57ce466fc3b79db1f19b8f4c63e07a1112306efa53c94fe810a2150dd9e07ddb",
	},
}

var reCNIVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
var reSHA = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidateCNIChecksums checks admin-registered checksums.
func ValidateCNIChecksums(c CNIChecksums) error {
	for v, arches := range c {
		if !reCNIVersion.MatchString(v) {
			return fmt.Errorf("CNI 版本 %q 格式应为 vX.Y.Z", v)
		}
		for arch, sum := range arches {
			if arch != "amd64" && arch != "arm64" {
				return fmt.Errorf("CNI 架构 %q 不支持", arch)
			}
			if !reSHA.MatchString(strings.ToLower(sum)) {
				return fmt.Errorf("CNI %s/%s 的 SHA256 不合法", v, arch)
			}
		}
	}
	return nil
}

// CNI downloads CNI plugin archives verified against pinned digests.
type CNI struct {
	BaseURL  string // default https://github.com/containernetworking/plugins/releases/download
	CacheDir string
	Extra    CNIChecksums // admin-registered digests
}

// Versions lists installable versions (built-in plus registered), newest first.
func (c *CNI) Versions() []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range []CNIChecksums{BuiltinCNIChecksums, c.Extra} {
		for v := range m {
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return CompareVersions(strings.TrimPrefix(out[i], "v"), strings.TrimPrefix(out[j], "v")) > 0
	})
	return out
}

func (c *CNI) digest(version, arch string) (string, bool) {
	if m, ok := c.Extra[version]; ok {
		if s, ok := m[arch]; ok {
			return strings.ToLower(s), true
		}
	}
	if m, ok := BuiltinCNIChecksums[version]; ok {
		s, ok := m[arch]
		return s, ok
	}
	return "", false
}

// Fetch returns the verified CNI archive (installed as-is and extracted on the host).
func (c *CNI) Fetch(ctx context.Context, client *http.Client, version, arch string, log io.Writer) (*Artifact, error) {
	want, ok := c.digest(version, arch)
	if !ok {
		return nil, fmt.Errorf("CNI %s/%s 没有登记的 SHA256，不能安装", version, arch)
	}
	base := c.BaseURL
	if base == "" {
		base = "https://github.com/containernetworking/plugins/releases/download"
	}
	name := fmt.Sprintf("cni-plugins-linux-%s-%s.tgz", arch, version)
	dir := filepath.Join(c.CacheDir, "cni", version, "linux_"+arch)
	unlock := lockArtifact(dir)
	defer unlock()
	if a, err := loadCached(dir); err == nil && a.PayloadSHA256 == want {
		logf(log, "使用已缓存并校验过的 CNI %s（%s）\n", version, arch)
		return a, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name)
	logf(log, "下载 %s\n", name)
	if err := download(ctx, client, strings.TrimRight(base, "/")+"/"+version+"/"+name, path, want); err != nil {
		return nil, err
	}
	logf(log, "%s 的 SHA256 与固定摘要一致\n", name)
	return finalize(dir, path, &Artifact{Product: "cni", Version: version, OS: "linux", Arch: arch,
		ArchiveSHA256: want, PayloadName: name, Gzipped: false})
}
