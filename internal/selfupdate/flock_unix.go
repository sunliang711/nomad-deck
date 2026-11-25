//go:build unix

package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const lockFileName = "nomad-deck.lock"

// AcquireProcessLock acquires an exclusive non-blocking advisory lock on
// <dataDir>/nomad-deck.lock so rollback commands can verify the control plane
// process has completely exited.
func AcquireProcessLock(dataDir string) (func(), error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(dataDir, lockFileName)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("acquire process lock %s: %w", p, err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// CheckProcessStopped verifies that no control plane process holds the
// advisory lock, waiting briefly if it is currently shutting down.
func CheckProcessStopped(dataDir string) error {
	p := filepath.Join(dataDir, lockFileName)
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("主服务仍在运行，请等待其完全退出后再执行回退")
		}
		time.Sleep(100 * time.Millisecond)
	}
}
