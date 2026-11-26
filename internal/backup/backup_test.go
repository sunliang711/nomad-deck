package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/migration"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/snapstore"
	"nomad-deck/internal/vaultbackup"
)

func TestMain(m *testing.M) {
	vaultbackup.DefaultMemory = 8 * 1024
	os.Exit(m.Run())
}

func newTestService(t *testing.T, keyByte byte) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(context.Background(), filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, err := crypto.NewKeyringForTest(bytes.Repeat([]byte{keyByte}, 32))
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := &audit.Recorder{DB: d, Log: log}
	engine := ops.NewEngine(d, log, dir)
	mig := &migration.Service{DB: d, Keys: keys, Audit: rec, Ops: engine, DataDir: dir, Log: log}
	svc := &Service{DB: d, Keys: keys, Audit: rec, Migration: mig, Drivers: map[string]cluster.Driver{}, DataDir: dir, Log: log}
	return svc, dir
}

type fakeClusterDriver struct {
	cluster.Driver
	keys    *crypto.Keyring
	payload []byte
	gotSnap []byte
	db      *db.DB
}

func (f *fakeClusterDriver) WriteArchive(_ context.Context, _ audit.Actor, _, _ string, passphrase string, w io.Writer) error {
	return snapstore.WriteArchive(w, bytes.NewReader(f.payload), snapstore.ArchiveMeta{
		ClusterName: "v1", ClusterType: "vault", ProductVersion: "1.21.1", CreatedAt: time.Now().UTC(),
	}, passphrase)
}

func (f *fakeClusterDriver) ImportArchive(ctx context.Context, _ audit.Actor, clusterID string, src io.ReadCloser, passphrase string) (*db.Snapshot, error) {
	meta, r, err := snapstore.ReadArchive(src, passphrase)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	f.gotSnap = b
	sn := &db.Snapshot{
		ID: db.NewID(), ClusterID: clusterID, ClusterType: meta.ClusterType,
		ProductVersion: meta.ProductVersion, FilePath: filepath.Join(os.TempDir(), "imp"), SizeBytes: int64(len(b)),
		SHA256: "abc", TriggerType: "uploaded", TriggeredBy: "test", CreatedAt: f.db.Now(),
	}
	return sn, db.InsertSnapshot(ctx, f.db.Writer, sn)
}

func TestRejectsNonSafeKeepTargetTypes(t *testing.T) {
	svc, _ := newTestService(t, 4)
	ctx := context.Background()
	actor := audit.Actor{Name: "root"}
	for _, typ := range []string{"local", "sftp", "s3"} {
		if _, err := svc.SaveConfig(ctx, actor, ConfigInput{
			Targets: []TargetInput{{Name: "legacy-" + typ, Type: typ, Enabled: true}},
		}); err == nil {
			t.Fatalf("expected SaveConfig to reject target type %q", typ)
		}
		if _, err := svc.TestTarget(ctx, actor, TargetInput{
			Name: "legacy-" + typ, Type: typ, Enabled: true,
		}); err == nil {
			t.Fatalf("expected TestTarget to reject target type %q", typ)
		}
	}
}

func TestDisasterRecoveryAndOffsiteSnapshotRestore(t *testing.T) {
	ctx := context.Background()
	src, _ := newTestService(t, 1)
	now := src.DB.Now()

	if _, err := src.DB.Writer.Exec(`INSERT INTO admins (id, username, password_hash, role, is_disabled, created_at, updated_at)
		VALUES ('a1', 'root', 'hash', 'admin', 0, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertCluster(ctx, src.DB.Writer, &db.Cluster{
		ID: "c1", Name: "v1", Type: "vault", Mode: "single", TLSConfigJSON: "{}",
		APIEndpointsJSON: "[]", ConfigJSON: "{}", InitState: db.InitInitialized,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	var (
		mu      sync.Mutex
		nextSeq int
		uploads = map[string]struct {
			name    string
			subpath string
			data    []byte
			created time.Time
		}{}
	)
	skSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "dr-api-key" {
			http.Error(w, `{"error":{"code":"unauthorized","message":"bad api key"}}`, http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/upstreams":
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{{"id": "up1", "name": "s3"}}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/backups":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			sum := sha256.Sum256(body)
			sumHex := hex.EncodeToString(sum[:])
			mu.Lock()
			nextSeq++
			id := fmt.Sprintf("task_%d", nextSeq)
			uploads[id] = struct {
				name    string
				subpath string
				data    []byte
				created time.Time
			}{
				name:    r.Header.Get("X-File-Name"),
				subpath: r.Header.Get("X-Backup-Path"),
				data:    body,
				created: time.Now().UTC(),
			}
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{"id": id, "status": "succeeded", "sha256": sumHex}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/backups":
			mu.Lock()
			var items []map[string]any
			for id, u := range uploads {
				items = append(items, map[string]any{
					"id": id, "original_filename": u.name, "custom_subpath": u.subpath,
					"file_size": len(u.data), "created_at": u.created,
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
			_, _ = w.Write(u.data)
		default:
			http.NotFound(w, r)
		}
	}))
	defer skSrv.Close()

	pass := "backup-passphrase-123"
	apiKey := "dr-api-key"
	if _, err := src.SaveConfig(ctx, audit.Actor{Name: "root"}, ConfigInput{
		Enabled:    true,
		Passphrase: &pass,
		Targets: []TargetInput{
			{
				ID: "t-sk", Name: "safekeep", Type: TargetSafeKeep, Enabled: true,
				SafeKeepURL: skSrv.URL, SafeKeepAPIKey: &apiKey, SafeKeepSubpath: "nomad-deck", SafeKeepMode: "sync",
				RetentionCount: 2, SnapshotRetentionCount: 2,
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Offsite Raft snapshot archival.
	snapPayload := []byte("vault-raft-snapshot-bytes-123456")
	src.Drivers["vault"] = &fakeClusterDriver{keys: src.Keys, payload: snapPayload, db: src.DB}
	snap := &db.Snapshot{ID: "sn1", ClusterID: "c1", ClusterType: "vault", ProductVersion: "1.21.1", CreatedAt: now}
	if err := src.OffsiteSnapshot(ctx, nil, snap, "v1"); err != nil {
		t.Fatalf("OffsiteSnapshot: %v", err)
	}

	// Scheduled control-plane backup.
	summary, err := src.CronBackup(ctx, nil)
	if err != nil || summary == "" {
		t.Fatalf("CronBackup summary=%q err=%v", summary, err)
	}
	runs, err := src.ListHistory(ctx, "control_plane", 10)
	if err != nil || len(runs) != 1 || runs[0].Status != "success" {
		t.Fatalf("ListHistory: %+v err=%v", runs, err)
	}

	// Recover into a fresh control plane with a different master key.
	dst, _ := newTestService(t, 2)
	dstDrv := &fakeClusterDriver{keys: dst.Keys, db: dst.DB}
	dst.Drivers["vault"] = dstDrv

	skSt, _ := src.newStore(Target{Type: TargetSafeKeep, SafeKeepURL: skSrv.URL, SafeKeepAPIKey: apiKey, SafeKeepSubpath: "nomad-deck"})
	objs, err := skSt.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(objs) != 1 {
		t.Fatalf("safekeep bundle list: %+v err=%v", objs, err)
	}
	rc, err := skSt.Open(ctx, objs[0].Object)
	if err != nil {
		t.Fatal(err)
	}
	rep, err := dst.Migration.Preview(ctx, "s1", "a1", rc, pass, migration.StrategyReplace)
	rc.Close()
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if len(rep.Manifest.OffsiteSnapshots) != 1 || rep.Manifest.OffsiteSnapshots[0].SnapshotID != "sn1" {
		t.Fatalf("expected offsite snapshot metadata in manifest, got %+v", rep.Manifest.OffsiteSnapshots)
	}
	if _, err := dst.Migration.Apply(ctx, audit.Actor{Name: "root"}, "s1", "a1", rep.PreviewToken); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// backup.enabled must be disabled after restore so two instances don't clobber targets.
	cfgView, err := dst.GetConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if cfgView.Enabled {
		t.Fatal("backup.enabled must be false after disaster recovery import")
	}

	snapsOnTarget, err := dst.ListTargetSnapshots(ctx, "t-sk")
	if err != nil || len(snapsOnTarget) != 1 {
		t.Fatalf("ListTargetSnapshots: %+v err=%v", snapsOnTarget, err)
	}
	if _, err := dst.ImportSnapshotFromTarget(ctx, audit.Actor{Name: "root"}, "t-sk", snapsOnTarget[0].Object, "c1", ""); err != nil {
		t.Fatalf("ImportSnapshotFromTarget: %v", err)
	}
	if !bytes.Equal(dstDrv.gotSnap, snapPayload) {
		t.Fatalf("recovered snapshot payload mismatch: %q", dstDrv.gotSnap)
	}
}

func TestSaveConfigEmptyPassphrasePassesKeyCheck(t *testing.T) {
	svc, _ := newTestService(t, 3)
	ctx := context.Background()
	actor := audit.Actor{Name: "root"}

	pass := "long-enough-backup-passphrase"
	if _, err := svc.SaveConfig(ctx, actor, ConfigInput{Enabled: false, Passphrase: &pass}); err != nil {
		t.Fatalf("SaveConfig non-empty passphrase: %v", err)
	}
	empty := ""
	view, err := svc.SaveConfig(ctx, actor, ConfigInput{Enabled: false, Passphrase: &empty})
	if err != nil {
		t.Fatalf("SaveConfig empty passphrase: %v", err)
	}
	if view.PassphraseSet {
		t.Fatal("expected PassphraseSet=false after clearing passphrase")
	}
	probs, err := db.CheckKeyIDs(ctx, svc.DB.Reader, crypto.KeyIDOf, svc.Keys.Has)
	if err != nil {
		t.Fatalf("CheckKeyIDs: %v", err)
	}
	if len(probs) > 0 {
		t.Fatalf("unexpected key check problems: %+v", probs)
	}
}
