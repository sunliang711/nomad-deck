package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nomad-deck/internal/audit"
)

func strPtr(s string) *string { return &s }

func TestSafeKeepStoreAndRevealAndCronBackup(t *testing.T) {
	var (
		mu      sync.Mutex
		uploads = map[string]struct {
			name    string
			subpath string
			sha     string
			data    []byte
			created time.Time
		}{}
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "sk-secret-key" {
			http.Error(w, `{"error":{"code":"unauthorized","message":"bad api key"}}`, http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/upstreams":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{{"id": "up1", "name": "local"}},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/backups":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			sum := sha256.Sum256(body)
			sumHex := hex.EncodeToString(sum[:])
			if want := r.Header.Get("X-Content-SHA256"); want != "" && !strings.EqualFold(want, sumHex) {
				http.Error(w, `{"error":{"code":"checksum_mismatch","message":"sha mismatch"}}`, http.StatusBadRequest)
				return
			}
			id := "task_sk_1"
			mu.Lock()
			uploads[id] = struct {
				name    string
				subpath string
				sha     string
				data    []byte
				created time.Time
			}{
				name:    r.Header.Get("X-File-Name"),
				subpath: r.Header.Get("X-Backup-Path"),
				sha:     sumHex,
				data:    body,
				created: time.Now().UTC(),
			}
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"task": map[string]any{
					"id":     id,
					"status": "succeeded",
					"sha256": sumHex,
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/backups":
			mu.Lock()
			var items []map[string]any
			for id, u := range uploads {
				items = append(items, map[string]any{
					"id":                id,
					"original_filename": u.name,
					"custom_subpath":    u.subpath,
					"file_size":         len(u.data),
					"created_at":        u.created,
				})
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/backups/") && strings.HasSuffix(r.URL.Path, "/download"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/backups/"), "/download")
			mu.Lock()
			u, ok := uploads[id]
			mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(u.data)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc, _ := newTestService(t, 0x33)
	ctx := t.Context()
	actor := audit.Actor{ID: "a1", Name: "admin"}

	cfgIn := ConfigInput{
		Enabled:    true,
		Passphrase: strPtr("super-strong-passphrase-123"),
		Targets: []TargetInput{
			{
				ID:              "tgt_sk1",
				Name:            "SafeKeep-Primary",
				Type:            TargetSafeKeep,
				Enabled:         true,
				RetentionCount:  7,
				SafeKeepURL:     srv.URL,
				SafeKeepAPIKey:  strPtr("sk-secret-key"),
				SafeKeepSubpath: "nomad-deck",
				SafeKeepMode:    "sync",
				SafeKeepTargets: "local",
			},
		},
	}

	view, err := svc.SaveConfig(ctx, actor, cfgIn)
	if err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if !view.PassphraseSet || len(view.Targets) != 1 || !view.Targets[0].SafeKeepAPIKeySet {
		t.Fatalf("unexpected ConfigView: %+v", view)
	}

	// Reveal secrets via RevealSecret.
	pass, err := svc.RevealSecret(ctx, actor, "passphrase", "")
	if err != nil || pass != *cfgIn.Passphrase {
		t.Fatalf("RevealSecret passphrase = %q, err=%v", pass, err)
	}
	apiKey, err := svc.RevealSecret(ctx, actor, "target_secret", "tgt_sk1")
	if err != nil || apiKey != "sk-secret-key" {
		t.Fatalf("RevealSecret target_secret = %q, err=%v", apiKey, err)
	}

	// Test target connection against mock SafeKeep API.
	tr, err := svc.TestTarget(ctx, actor, TargetInput{
		Name:           "SafeKeep-Test",
		Type:           TargetSafeKeep,
		SafeKeepURL:    srv.URL,
		SafeKeepAPIKey: strPtr("sk-secret-key"),
	})
	if err != nil || !tr.OK {
		t.Fatalf("TestTarget failed: %+v err=%v", tr, err)
	}

	// Trigger scheduled control-plane backup directly to SafeKeep target.
	summary, err := svc.CronBackupTarget(ctx, nil, "tgt_sk1", "")
	if err != nil {
		t.Fatalf("CronBackupTarget failed: %v", err)
	}
	if !strings.Contains(summary, "SafeKeep-Primary") {
		t.Fatalf("unexpected CronBackupTarget summary: %q", summary)
	}

	// Verify List and Open round-trip through SafeKeep store.
	loaded, err := svc.loadConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	st, err := svc.newStore(loaded.Targets[0])
	if err != nil {
		t.Fatal(err)
	}
	objs, err := st.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(objs) != 1 {
		t.Fatalf("List got %+v err=%v", objs, err)
	}
	rc, err := st.Open(ctx, objs[0].Object)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(rc)
	_ = rc.Close()
	if int64(len(raw)) != objs[0].SizeBytes {
		t.Fatalf("downloaded %d bytes, want %d", len(raw), objs[0].SizeBytes)
	}

	// Also test PutAndVerify mismatch detection cleanly.
	tmp := filepath.Join(t.TempDir(), "dummy.bin")
	_ = os.WriteFile(tmp, []byte("hello"), 0o600)
	if _, err := st.PutAndVerify(ctx, "control-plane", "dummy.bin", tmp, strings.Repeat("0", 64), 5); err == nil {
		t.Fatal("expected sha mismatch error")
	}
}
