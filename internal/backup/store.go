package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"time"
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
	if t.Type != TargetSafeKeep {
		return nil, fmt.Errorf("不支持的备份目标类型：%s（仅支持 safekeep）", t.Type)
	}
	return newSafeKeepStore(t), nil
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
