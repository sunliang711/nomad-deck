package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"nomad-deck/internal/db"
	"nomad-deck/internal/sshx"
)

// ObjectInfo describes a stored object on a backup target.
type ObjectInfo struct {
	Object    string    `json:"object"`
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	ModTime   time.Time `json:"mod_time"`
}

// TestResult describes a backup target connectivity test outcome.
type TestResult struct {
	OK                 bool   `json:"ok"`
	Type               string `json:"type"`
	Target             string `json:"target"`
	HostKeyFingerprint string `json:"host_key_fingerprint,omitempty"`
	LatencyMS          int64  `json:"latency_ms"`
	Error              string `json:"error,omitempty"`
}

// Store reads, writes, verifies and rotates objects on one backup target.
type Store interface {
	PutAndVerify(ctx context.Context, subdir, name, localPath, wantSHA string, wantSize int64) (object string, err error)
	Rotate(ctx context.Context, subdir, prefix string, keep int) (deleted int, err error)
	List(ctx context.Context, subdir, prefix string) ([]ObjectInfo, error)
	Open(ctx context.Context, object string) (io.ReadCloser, error)
	Test(ctx context.Context) (*TestResult, error)
}

func (s *Service) newStore(t Target) (Store, error) {
	switch t.Type {
	case TargetLocal:
		return &localStore{baseDir: t.Path}, nil
	case TargetSFTP:
		return &sftpStore{svc: s, target: t}, nil
	case TargetS3:
		return newS3Store(t)
	case TargetSafeKeep:
		return newSafeKeepStore(t), nil
	default:
		return nil, fmt.Errorf("不支持的备份目标类型：%s", t.Type)
	}
}

func probeContent() ([]byte, string) {
	b := make([]byte, 256)
	_, _ = rand.Read(b)
	sum := sha256.Sum256(b)
	return b, hex.EncodeToString(sum[:])
}

func verifyReader(r io.Reader, wantSHA string, wantSize int64) error {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return err
	}
	if n != wantSize {
		return fmt.Errorf("回读大小不一致（期望 %d 字节，实际 %d 字节）", wantSize, n)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return fmt.Errorf("回读 SHA-256 校验失败（期望 %s，实际 %s）", wantSHA, got)
	}
	return nil
}

// ---- Local directory store ----

type localStore struct {
	baseDir string
}

func (l *localStore) cleanSubdir(subdir string) (string, error) {
	rel := filepath.Clean(filepath.FromSlash(subdir))
	if rel == "." {
		return l.baseDir, nil
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
		return "", errors.New("invalid subdir")
	}
	return filepath.Join(l.baseDir, rel), nil
}

func (l *localStore) resolveObject(object string) (string, error) {
	rel := filepath.Clean(filepath.FromSlash(object))
	if rel == "." || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
		return "", errors.New("invalid object path")
	}
	return filepath.Join(l.baseDir, rel), nil
}

func (l *localStore) PutAndVerify(_ context.Context, subdir, name, localPath, wantSHA string, wantSize int64) (string, error) {
	dir, err := l.cleanSubdir(subdir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	src, err := os.Open(localPath)
	if err != nil {
		return "", err
	}
	defer src.Close()

	dstPath := filepath.Join(dir, name)
	tmpPath := dstPath + ".tmp"
	dst, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	if err := os.Rename(tmpPath, dstPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}
	rd, err := os.Open(dstPath)
	if err != nil {
		return "", err
	}
	err = verifyReader(rd, wantSHA, wantSize)
	rd.Close()
	if err != nil {
		_ = os.Remove(dstPath)
		return "", err
	}
	return path.Join(subdir, name), nil
}

func (l *localStore) Rotate(_ context.Context, subdir, prefix string, keep int) (int, error) {
	if keep <= 0 {
		return 0, nil
	}
	dir, err := l.cleanSubdir(subdir)
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasPrefix(n, prefix) && !strings.HasSuffix(n, ".tmp") {
			names = append(names, n)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	deleted := 0
	var delErrs []error
	for i := keep; i < len(names); i++ {
		if err := os.Remove(filepath.Join(dir, names[i])); err != nil {
			delErrs = append(delErrs, err)
		} else {
			deleted++
		}
	}
	return deleted, errors.Join(delErrs...)
}

func (l *localStore) List(_ context.Context, subdir, prefix string) ([]ObjectInfo, error) {
	dir, err := l.cleanSubdir(subdir)
	if err != nil {
		return nil, err
	}
	var out []ObjectInfo
	err = filepath.WalkDir(dir, func(p string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if d.IsDir() || strings.HasSuffix(d.Name(), ".tmp") {
			return nil
		}
		if prefix != "" && !strings.HasPrefix(d.Name(), prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(l.baseDir, p)
		if err != nil {
			return nil
		}
		out = append(out, ObjectInfo{
			Object:    filepath.ToSlash(rel),
			Name:      d.Name(),
			SizeBytes: info.Size(),
			ModTime:   info.ModTime().UTC(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Object > out[j].Object })
	return out, nil
}

func (l *localStore) Open(_ context.Context, object string) (io.ReadCloser, error) {
	p, err := l.resolveObject(object)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (l *localStore) Test(ctx context.Context) (*TestResult, error) {
	start := time.Now()
	if err := os.MkdirAll(l.baseDir, 0o700); err != nil {
		return &TestResult{Type: TargetLocal, Target: l.baseDir, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	data, sum := probeContent()
	tmp, err := os.CreateTemp("", "nd-probe-*")
	if err != nil {
		return &TestResult{Type: TargetLocal, Target: l.baseDir, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	tmpPath := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	defer os.Remove(tmpPath)
	if werr != nil || cerr != nil {
		err = errors.Join(werr, cerr)
		return &TestResult{Type: TargetLocal, Target: l.baseDir, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	name := ".nomad-deck-probe-" + sum[:12]
	obj, err := l.PutAndVerify(ctx, "", name, tmpPath, sum, int64(len(data)))
	if p, rerr := l.resolveObject(obj); rerr == nil && obj != "" {
		_ = os.Remove(p)
	}
	if err != nil {
		return &TestResult{Type: TargetLocal, Target: l.baseDir, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	return &TestResult{OK: true, Type: TargetLocal, Target: l.baseDir, LatencyMS: time.Since(start).Milliseconds()}, nil
}

// ---- SFTP store ----

type sftpStore struct {
	svc    *Service
	target Target
}

func (s *sftpStore) dial(ctx context.Context) (*sshx.Client, *sftp.Client, error) {
	key, err := db.GetSSHKey(ctx, s.svc.DB.Reader, s.target.SSHKeyID)
	if err != nil {
		return nil, nil, fmt.Errorf("加载 SSH 密钥失败：%w", err)
	}
	pemBytes, err := s.svc.Keys.Decrypt(key.PrivateKeyEncrypted, db.SSHKeyAAD(key.ID))
	if err != nil {
		return nil, nil, fmt.Errorf("解密 SSH 密钥失败：%w", err)
	}
	signer, err := ssh.ParsePrivateKey(pemBytes)
	if err != nil {
		return nil, nil, fmt.Errorf("解析 SSH 密钥失败：%w", err)
	}
	timeout := time.Duration(db.IntSetting(ctx, s.svc.DB.Reader, "ssh.timeout_sec", 15)) * time.Second
	client, err := sshx.Dial(ctx, sshx.Target{
		Host:               s.target.Host,
		Port:               s.target.Port,
		User:               s.target.Username,
		Signer:             signer,
		HostKeyFingerprint: s.target.HostKeyFingerprint,
		Timeout:            timeout,
	})
	if err != nil {
		return nil, nil, err
	}
	sf, err := client.SFTP()
	if err != nil {
		client.Close()
		return nil, nil, err
	}
	return client, sf, nil
}

func sftpJoin(base, rel string) (string, error) {
	cleaned := path.Clean("/" + strings.TrimPrefix(rel, "/"))
	if strings.Contains(cleaned, "..") {
		return "", errors.New("invalid remote path")
	}
	if cleaned == "/" {
		return path.Clean(base), nil
	}
	return path.Join(path.Clean(base), strings.TrimPrefix(cleaned, "/")), nil
}

func sftpUploadAndVerify(sf *sftp.Client, remotePath, localPath, wantSHA string, wantSize int64) error {
	src, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer src.Close()
	if err := sf.MkdirAll(path.Dir(remotePath)); err != nil {
		return err
	}
	tmpPath := remotePath + ".tmp"
	dst, err := sf.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = sf.Remove(tmpPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = sf.Remove(tmpPath)
		return err
	}
	_ = sf.Chmod(tmpPath, 0o600)
	if err := sf.PosixRename(tmpPath, remotePath); err != nil {
		_ = sf.Remove(remotePath)
		if rerr := sf.Rename(tmpPath, remotePath); rerr != nil {
			_ = sf.Remove(tmpPath)
			return rerr
		}
	}
	rd, err := sf.Open(remotePath)
	if err != nil {
		return err
	}
	err = verifyReader(rd, wantSHA, wantSize)
	rd.Close()
	if err != nil {
		_ = sf.Remove(remotePath)
		return err
	}
	return nil
}

func (s *sftpStore) PutAndVerify(ctx context.Context, subdir, name, localPath, wantSHA string, wantSize int64) (string, error) {
	c, sf, err := s.dial(ctx)
	if err != nil {
		return "", err
	}
	defer c.Close()
	obj := path.Join(subdir, name)
	remotePath, err := sftpJoin(s.target.RemoteDir, obj)
	if err != nil {
		return "", err
	}
	if err := sftpUploadAndVerify(sf, remotePath, localPath, wantSHA, wantSize); err != nil {
		return "", err
	}
	return strings.TrimPrefix(obj, "/"), nil
}

func (s *sftpStore) Rotate(ctx context.Context, subdir, prefix string, keep int) (int, error) {
	if keep <= 0 {
		return 0, nil
	}
	c, sf, err := s.dial(ctx)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	dir, err := sftpJoin(s.target.RemoteDir, subdir)
	if err != nil {
		return 0, err
	}
	entries, err := sf.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasPrefix(n, prefix) && !strings.HasSuffix(n, ".tmp") {
			names = append(names, n)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	deleted := 0
	var delErrs []error
	for i := keep; i < len(names); i++ {
		if err := sf.Remove(path.Join(dir, names[i])); err != nil {
			delErrs = append(delErrs, err)
		} else {
			deleted++
		}
	}
	return deleted, errors.Join(delErrs...)
}

func (s *sftpStore) List(ctx context.Context, subdir, prefix string) ([]ObjectInfo, error) {
	c, sf, err := s.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rootDir, err := sftpJoin(s.target.RemoteDir, subdir)
	if err != nil {
		return nil, err
	}
	var out []ObjectInfo
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := sf.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, e := range entries {
			p := path.Join(dir, e.Name())
			if e.IsDir() {
				if err := walk(p); err != nil {
					return err
				}
				continue
			}
			if strings.HasSuffix(e.Name(), ".tmp") {
				continue
			}
			if prefix != "" && !strings.HasPrefix(e.Name(), prefix) {
				continue
			}
			rel := strings.TrimPrefix(strings.TrimPrefix(p, path.Clean(s.target.RemoteDir)), "/")
			out = append(out, ObjectInfo{
				Object:    rel,
				Name:      e.Name(),
				SizeBytes: e.Size(),
				ModTime:   e.ModTime().UTC(),
			})
		}
		return nil
	}
	if err := walk(rootDir); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Object > out[j].Object })
	return out, nil
}

func (s *sftpStore) Open(ctx context.Context, object string) (io.ReadCloser, error) {
	c, sf, err := s.dial(ctx)
	if err != nil {
		return nil, err
	}
	remotePath, err := sftpJoin(s.target.RemoteDir, object)
	if err != nil {
		c.Close()
		return nil, err
	}
	f, err := sf.Open(remotePath)
	if err != nil {
		c.Close()
		return nil, err
	}
	return &sftpFileCloser{file: f, client: c}, nil
}

type sftpFileCloser struct {
	file   *sftp.File
	client *sshx.Client
}

func (f *sftpFileCloser) Read(p []byte) (int, error) { return f.file.Read(p) }
func (f *sftpFileCloser) Close() error               { return errors.Join(f.file.Close(), f.client.Close()) }

func (s *sftpStore) Test(ctx context.Context) (*TestResult, error) {
	start := time.Now()
	targetDesc := fmt.Sprintf("sftp://%s@%s:%d%s", s.target.Username, s.target.Host, s.target.Port, s.target.RemoteDir)
	c, sf, err := s.dial(ctx)
	if err != nil {
		return &TestResult{Type: TargetSFTP, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	fp := c.HostKeyFingerprint
	defer c.Close()

	data, sum := probeContent()
	tmp, err := os.CreateTemp("", "nd-probe-*")
	if err != nil {
		return &TestResult{Type: TargetSFTP, Target: targetDesc, HostKeyFingerprint: fp, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	tmpPath := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	defer os.Remove(tmpPath)
	if werr != nil || cerr != nil {
		err = errors.Join(werr, cerr)
		return &TestResult{Type: TargetSFTP, Target: targetDesc, HostKeyFingerprint: fp, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	remotePath, err := sftpJoin(s.target.RemoteDir, ".nomad-deck-probe-"+sum[:12])
	if err != nil {
		return &TestResult{Type: TargetSFTP, Target: targetDesc, HostKeyFingerprint: fp, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	err = sftpUploadAndVerify(sf, remotePath, tmpPath, sum, int64(len(data)))
	_ = sf.Remove(remotePath)
	if err != nil {
		return &TestResult{Type: TargetSFTP, Target: targetDesc, HostKeyFingerprint: fp, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	return &TestResult{OK: true, Type: TargetSFTP, Target: targetDesc, HostKeyFingerprint: fp, LatencyMS: time.Since(start).Milliseconds()}, nil
}

// ---- S3-compatible store ----

type s3Store struct {
	client *minio.Client
	target Target
}

func newS3Store(t Target) (*s3Store, error) {
	host, useSSL, err := parseS3Endpoint(t.Endpoint, t.UseSSL)
	if err != nil {
		return nil, err
	}
	lookup := minio.BucketLookupAuto
	if t.PathStyle {
		lookup = minio.BucketLookupPath
	}
	mc, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(t.AccessKeyID, t.SecretAccessKey, ""),
		Secure:       useSSL,
		Region:       t.Region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, err
	}
	return &s3Store{client: mc, target: t}, nil
}

func (s *s3Store) keyFor(rel string) string {
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if s.target.Prefix == "" {
		return rel
	}
	if rel == "" {
		return s.target.Prefix
	}
	return path.Join(s.target.Prefix, rel)
}

func (s *s3Store) stripPrefix(key string) string {
	if s.target.Prefix == "" {
		return strings.TrimPrefix(key, "/")
	}
	return strings.TrimPrefix(strings.TrimPrefix(key, s.target.Prefix), "/")
}

func (s *s3Store) PutAndVerify(ctx context.Context, subdir, name, localPath, wantSHA string, wantSize int64) (string, error) {
	rel := path.Join(subdir, name)
	key := s.keyFor(rel)
	if _, err := s.client.FPutObject(ctx, s.target.Bucket, key, localPath, minio.PutObjectOptions{ContentType: "application/octet-stream"}); err != nil {
		return "", err
	}
	obj, err := s.client.GetObject(ctx, s.target.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return "", err
	}
	err = verifyReader(obj, wantSHA, wantSize)
	obj.Close()
	if err != nil {
		_ = s.client.RemoveObject(ctx, s.target.Bucket, key, minio.RemoveObjectOptions{})
		return "", err
	}
	return strings.TrimPrefix(rel, "/"), nil
}

func (s *s3Store) Rotate(ctx context.Context, subdir, prefix string, keep int) (int, error) {
	if keep <= 0 {
		return 0, nil
	}
	fullPrefix := s.keyFor(path.Join(subdir, prefix))
	var keys []string
	for obj := range s.client.ListObjects(ctx, s.target.Bucket, minio.ListObjectsOptions{Prefix: fullPrefix, Recursive: true}) {
		if obj.Err != nil {
			return 0, obj.Err
		}
		if strings.HasPrefix(path.Base(obj.Key), prefix) {
			keys = append(keys, obj.Key)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	deleted := 0
	var delErrs []error
	for i := keep; i < len(keys); i++ {
		if err := s.client.RemoveObject(ctx, s.target.Bucket, keys[i], minio.RemoveObjectOptions{}); err != nil {
			delErrs = append(delErrs, err)
		} else {
			deleted++
		}
	}
	return deleted, errors.Join(delErrs...)
}

func (s *s3Store) List(ctx context.Context, subdir, prefix string) ([]ObjectInfo, error) {
	fullPrefix := s.keyFor(subdir)
	if fullPrefix != "" && !strings.HasSuffix(fullPrefix, "/") {
		fullPrefix += "/"
	}
	var out []ObjectInfo
	for obj := range s.client.ListObjects(ctx, s.target.Bucket, minio.ListObjectsOptions{Prefix: fullPrefix, Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		base := path.Base(obj.Key)
		if prefix != "" && !strings.HasPrefix(base, prefix) {
			continue
		}
		out = append(out, ObjectInfo{
			Object:    s.stripPrefix(obj.Key),
			Name:      base,
			SizeBytes: obj.Size,
			ModTime:   obj.LastModified.UTC(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Object > out[j].Object })
	return out, nil
}

func (s *s3Store) Open(ctx context.Context, object string) (io.ReadCloser, error) {
	return s.client.GetObject(ctx, s.target.Bucket, s.keyFor(object), minio.GetObjectOptions{})
}

func (s *s3Store) Test(ctx context.Context) (*TestResult, error) {
	start := time.Now()
	targetDesc := fmt.Sprintf("s3://%s/%s", s.target.Bucket, s.target.Prefix)
	ok, err := s.client.BucketExists(ctx, s.target.Bucket)
	if err != nil {
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	if !ok {
		err = fmt.Errorf("Bucket %s 不存在或无权限访问", s.target.Bucket)
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	data, sum := probeContent()
	key := s.keyFor(".nomad-deck-probe-" + sum[:12])
	if _, err := s.client.PutObject(ctx, s.target.Bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: "application/octet-stream"}); err != nil {
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	defer func() {
		_ = s.client.RemoveObject(ctx, s.target.Bucket, key, minio.RemoveObjectOptions{})
	}()
	obj, err := s.client.GetObject(ctx, s.target.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	err = verifyReader(obj, sum, int64(len(data)))
	obj.Close()
	if err != nil {
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: err.Error()}, err
	}
	if rerr := s.client.RemoveObject(ctx, s.target.Bucket, key, minio.RemoveObjectOptions{}); rerr != nil {
		return &TestResult{Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds(), Error: "清理探测对象失败: " + rerr.Error()}, rerr
	}
	return &TestResult{OK: true, Type: TargetS3, Target: targetDesc, LatencyMS: time.Since(start).Milliseconds()}, nil
}
