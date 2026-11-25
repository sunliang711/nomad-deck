package auth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
)

func TestMain(m *testing.M) {
	crypto.PasswordParams = crypto.Argon2Params{Memory: 1024, Time: 1, Threads: 1, KeyLen: 32, SaltLen: 16}
	os.Exit(m.Run())
}

func newTestAuthService(t *testing.T, keys *crypto.Keyring) *Service {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := &audit.Recorder{DB: d, Log: log}
	return NewService(d, keys, rec, log, dir)
}

func TestCSRFTokenSurvivesKeyringRotation(t *testing.T) {
	keyA := bytes.Repeat([]byte{0x11}, 32)
	keyB := bytes.Repeat([]byte{0x22}, 32)

	kr1, err := crypto.NewKeyringForTest(keyA)
	if err != nil {
		t.Fatal(err)
	}
	kr2, err := crypto.NewKeyringForTest(keyB, keyA)
	if err != nil {
		t.Fatal(err)
	}
	svc1 := newTestAuthService(t, kr1)
	svc2 := newTestAuthService(t, kr2)

	sessTok := "session-token-example"
	c1 := svc1.CSRFToken(sessTok)
	c2 := svc2.CSRFToken(sessTok)
	if c1 == "" || c1 != c2 {
		t.Fatalf("CSRFToken changed across master keyring rotation: before=%q after=%q", c1, c2)
	}
	sess := &db.Session{CSRFTokenHash: crypto.SHA256Hex(c1)}
	if !VerifyCSRF(sess, c2) {
		t.Fatal("VerifyCSRF failed after keyring rotation")
	}
}

func TestConcurrentLoginFailuresReachLockout(t *testing.T) {
	kr, err := crypto.NewKeyringForTest(bytes.Repeat([]byte{0x33}, 32))
	if err != nil {
		t.Fatal(err)
	}
	svc := newTestAuthService(t, kr)
	ctx := context.Background()

	tok, err := svc.PrepareSetupToken(ctx)
	if err != nil {
		t.Fatal(err)
	}
	const adminPass = "correct-horse-battery"
	if _, err := svc.Setup(ctx, SetupInput{
		SetupToken: tok, Username: "admin", Password: adminPass, ClientIP: "127.0.0.1",
	}); err != nil {
		t.Fatal(err)
	}

	const n = LockThreshold + 2
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			ip := fmt.Sprintf("10.0.0.%d", idx+1)
			_, _ = svc.Login(ctx, "admin", "wrong-password", ip, "test-agent")
		}(i)
	}
	wg.Wait()

	_, err = svc.Login(ctx, "admin", adminPass, "10.0.1.1", "test-agent")
	var ae *Error
	if !errors.As(err, &ae) || ae.Status != http.StatusTooManyRequests {
		t.Fatalf("expected 429 lockout after concurrent failures, got err=%v", err)
	}
}
