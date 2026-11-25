package selfupdate

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"nomad-deck/internal/version"
)

// System settings keys for self-update.
const (
	SettingChannel         = "self_update.channel"
	SettingBackupRetention = "self_update.backup_retention"
	SettingLastResult      = "self_update.last_result"
	SettingSchedule        = "self_update.schedule"
	SettingLatestCache     = "self_update.latest_cache"
)

// Release channels.
const (
	ChannelStable     = "stable"
	ChannelPrerelease = "prerelease"
)

const (
	defaultBackupRetention = 3
	maxSumsBytes           = 1 << 20
	maxSigBytes            = 4096
)

// ReleaseAsset describes one file attached to a GitHub release.
type ReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// GitHubRelease is the subset of GitHub's release API payload we use.
type GitHubRelease struct {
	TagName     string         `json:"tag_name"`
	Name        string         `json:"name"`
	Body        string         `json:"body"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	PublishedAt time.Time      `json:"published_at"`
	Assets      []ReleaseAsset `json:"assets"`
}

// ReleaseSummary is a cached/API summary of the latest available release.
type ReleaseSummary struct {
	Version        string    `json:"version"`
	Tag            string    `json:"tag"`
	Notes          string    `json:"notes,omitempty"`
	Prerelease     bool      `json:"prerelease"`
	PublishedAt    time.Time `json:"published_at,omitempty"`
	AssetsComplete bool      `json:"assets_complete"`
	CheckedAt      time.Time `json:"checked_at,omitempty"`
}

// ReleaseInfo resolves a release together with download URLs for this host.
type ReleaseInfo struct {
	ReleaseSummary
	ArchiveName string `json:"archive_name,omitempty"`
	ArchiveURL  string `json:"archive_url,omitempty"`
	SumsURL     string `json:"sums_url,omitempty"`
	SigURL      string `json:"sig_url,omitempty"`
}

// ParsePublicKey parses a base64 or hex encoded Ed25519 public key.
func ParsePublicKey(raw string) (ed25519.PublicKey, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("empty public key")
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil && len(b) == ed25519.PublicKeySize {
		return ed25519.PublicKey(b), nil
	}
	if b, err := hex.DecodeString(s); err == nil && len(b) == ed25519.PublicKeySize {
		return ed25519.PublicKey(b), nil
	}
	return nil, errors.New("invalid Ed25519 public key")
}

// DecodeSignature decodes a raw, hex or base64 Ed25519 signature.
func DecodeSignature(raw []byte) ([]byte, error) {
	if len(raw) == ed25519.SignatureSize {
		return raw, nil
	}
	s := strings.TrimSpace(string(raw))
	if b, err := hex.DecodeString(s); err == nil && len(b) == ed25519.SignatureSize {
		return b, nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil && len(b) == ed25519.SignatureSize {
		return b, nil
	}
	return nil, errors.New("签名文件格式不合法")
}

// FetchReleases retrieves recent releases from GitHub.
func FetchReleases(ctx context.Context, client *http.Client, apiBase, repo string) ([]GitHubRelease, error) {
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	url := strings.TrimRight(apiBase, "/") + "/repos/" + strings.Trim(repo, "/") + "/releases?per_page=30"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "nomad-deck/"+version.Version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("GitHub Release 查询返回 HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out []GitHubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("解析 Release 列表失败：%w", err)
	}
	return out, nil
}

// ResolveRelease selects the matching target (or highest semver when
// target is "" or "latest") respecting the release channel.
func ResolveRelease(releases []GitHubRelease, target, channel, goos, goarch string) (*ReleaseInfo, error) {
	wantLatest := target == "" || target == "latest"
	var wantSemver Semver
	if !wantLatest {
		v, err := ParseSemver(target)
		if err != nil {
			return nil, fmt.Errorf("目标版本号不合法：%s", target)
		}
		wantSemver = v
	}
	var best *GitHubRelease
	var bestVer Semver
	for i := range releases {
		r := &releases[i]
		if r.Draft {
			continue
		}
		sv, err := ParseSemver(r.TagName)
		if err != nil {
			continue
		}
		if (r.Prerelease || sv.Pre != "") && channel != ChannelPrerelease {
			continue
		}
		if wantLatest {
			if best == nil || sv.Compare(bestVer) > 0 {
				best = r
				bestVer = sv
			}
		} else if sv.Compare(wantSemver) == 0 {
			best = r
			bestVer = sv
			break
		}
	}
	if best == nil {
		if wantLatest {
			return nil, errors.New("未找到符合发布通道的可用版本")
		}
		return nil, fmt.Errorf("未找到目标版本 %s", target)
	}
	return buildReleaseInfo(best, bestVer, goos, goarch), nil
}

func buildReleaseInfo(r *GitHubRelease, sv Semver, goos, goarch string) *ReleaseInfo {
	verStr := sv.String()
	verNoV := strings.TrimPrefix(verStr, "v")
	candidates := map[string]bool{
		fmt.Sprintf("nomad-deck_%s_%s_%s.tar.gz", verNoV, goos, goarch): true,
		fmt.Sprintf("nomad-deck_%s_%s_%s.tar.gz", verStr, goos, goarch): true,
		fmt.Sprintf("nomad-deck-%s-%s-%s.tar.gz", verNoV, goos, goarch): true,
		fmt.Sprintf("nomad-deck-%s-%s-%s.tar.gz", verStr, goos, goarch): true,
	}
	info := &ReleaseInfo{
		ReleaseSummary: ReleaseSummary{
			Version:     verStr,
			Tag:         r.TagName,
			Notes:       r.Body,
			Prerelease:  r.Prerelease,
			PublishedAt: r.PublishedAt,
			CheckedAt:   time.Now().UTC(),
		},
	}
	for _, a := range r.Assets {
		switch {
		case a.Name == "SHA256SUMS":
			info.SumsURL = a.BrowserDownloadURL
		case a.Name == "SHA256SUMS.sig":
			info.SigURL = a.BrowserDownloadURL
		case candidates[a.Name]:
			info.ArchiveName = a.Name
			info.ArchiveURL = a.BrowserDownloadURL
		}
	}
	info.AssetsComplete = info.ArchiveURL != "" && info.SumsURL != "" && info.SigURL != ""
	return info
}

func downloadBytes(ctx context.Context, client *http.Client, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "nomad-deck/"+version.Version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 %s 返回 HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func parseSums(sums []byte, wantName string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		digest := strings.ToLower(fields[0])
		name := strings.TrimPrefix(strings.TrimPrefix(fields[1], "*"), "./")
		if name == wantName && len(digest) == 64 {
			if _, err := hex.DecodeString(digest); err == nil {
				return digest, nil
			}
		}
	}
	return "", fmt.Errorf("SHA256SUMS 中未找到 %s 的摘要", wantName)
}

// VerifyAndExtract downloads SHA256SUMS, SHA256SUMS.sig and the release
// archive, verifies Ed25519 signature and SHA-256 digest, atomically extracts
// the nomad-deck binary to destPath, and dry-runs --version.
func VerifyAndExtract(ctx context.Context, client *http.Client, rel *ReleaseInfo, pubKey ed25519.PublicKey, destPath string, verifyFn func(context.Context, string, string) error) error {
	if !rel.AssetsComplete {
		return errors.New("目标版本缺少当前平台程序包或签名摘要文件")
	}
	if len(pubKey) != ed25519.PublicKeySize {
		return errors.New("发布验签公钥无效")
	}
	sums, err := downloadBytes(ctx, client, rel.SumsURL, maxSumsBytes)
	if err != nil {
		return fmt.Errorf("下载 SHA256SUMS 失败：%w", err)
	}
	sigRaw, err := downloadBytes(ctx, client, rel.SigURL, maxSigBytes)
	if err != nil {
		return fmt.Errorf("下载 SHA256SUMS.sig 失败：%w", err)
	}
	sig, err := DecodeSignature(sigRaw)
	if err != nil {
		return err
	}
	if !ed25519.Verify(pubKey, sums, sig) {
		return errors.New("SHA256SUMS Ed25519 签名校验失败，已中止更新")
	}
	wantSHA, err := parseSums(sums, rel.ArchiveName)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rel.ArchiveURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "nomad-deck/"+version.Version)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载程序包失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载程序包返回 HTTP %d", resp.StatusCode)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}
	tmpTar, err := os.CreateTemp(filepath.Dir(destPath), ".archive-*.tar.gz")
	if err != nil {
		return err
	}
	tmpTarPath := tmpTar.Name()
	defer os.Remove(tmpTarPath)

	h := sha256.New()
	if _, err := io.Copy(tmpTar, io.TeeReader(resp.Body, h)); err != nil {
		tmpTar.Close()
		return fmt.Errorf("接收程序包失败：%w", err)
	}
	if err := tmpTar.Close(); err != nil {
		return err
	}
	if gotSHA := hex.EncodeToString(h.Sum(nil)); gotSHA != wantSHA {
		return fmt.Errorf("程序包 SHA-256 校验失败（期望 %s，实际 %s）", wantSHA, gotSHA)
	}

	if err := extractBinary(tmpTarPath, destPath); err != nil {
		return err
	}
	if verifyFn == nil {
		verifyFn = defaultVerifyBinary
	}
	if err := verifyFn(ctx, destPath, rel.Version); err != nil {
		_ = os.Remove(destPath)
		return fmt.Errorf("新版本试运行校验失败：%w", err)
	}
	return nil
}

func extractBinary(tarGzPath, destPath string) error {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("解压 gzip 失败：%w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		th, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("读取 tar 归档失败：%w", err)
		}
		if th.Typeflag != tar.TypeReg {
			continue
		}
		if path.Base(path.Clean(th.Name)) != "nomad-deck" {
			continue
		}
		tmpBin := destPath + ".tmp"
		out, err := os.OpenFile(tmpBin, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			_ = os.Remove(tmpBin)
			return err
		}
		if err := out.Sync(); err != nil {
			out.Close()
			_ = os.Remove(tmpBin)
			return err
		}
		if err := out.Close(); err != nil {
			_ = os.Remove(tmpBin)
			return err
		}
		if err := os.Rename(tmpBin, destPath); err != nil {
			_ = os.Remove(tmpBin)
			return err
		}
		return nil
	}
	return errors.New("压缩包中未找到 nomad-deck 可执行文件")
}

func defaultVerifyBinary(ctx context.Context, binPath, wantVer string) error {
	vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, binPath, "version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w (%s)", err, strings.TrimSpace(string(out)))
	}
	want := strings.TrimPrefix(NormalizeTag(wantVer), "v")
	if !strings.Contains(string(out), want) {
		return fmt.Errorf("version 输出 %q 与目标版本 %s 不符", strings.TrimSpace(string(out)), wantVer)
	}
	return nil
}
