package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

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

func TestLocalStoreVerifyAndRotate(t *testing.T) {
	ctx := context.Background()
	base := filepath.Join(t.TempDir(), "backups")
	st := &localStore{baseDir: base}

	res, err := st.Test(ctx)
	if err != nil || !res.OK {
		t.Fatalf("local Test: %+v err=%v", res, err)
	}

	tmpDir := t.TempDir()
	for i := 1; i <= 4; i++ {
		data := []byte(fmt.Sprintf("bundle-%d-payload", i))
		sum := sha256.Sum256(data)
		src := filepath.Join(tmpDir, fmt.Sprintf("f%d", i))
		_ = os.WriteFile(src, data, 0o600)
		name := fmt.Sprintf("nomad-deck-backup-2026112%dT000000Z-id%d.ndbundle", i, i)
		if _, err := st.PutAndVerify(ctx, "control-plane", name, src, hex.EncodeToString(sum[:]), int64(len(data))); err != nil {
			t.Fatalf("PutAndVerify %d: %v", i, err)
		}
	}
	// Wrong SHA must fail verification and clean up.
	badSrc := filepath.Join(tmpDir, "bad")
	_ = os.WriteFile(badSrc, []byte("abc"), 0o600)
	if _, err := st.PutAndVerify(ctx, "control-plane", "nomad-deck-backup-bad.ndbundle", badSrc, strings.Repeat("0", 64), 3); err == nil {
		t.Fatal("expected sha mismatch error")
	}

	deleted, err := st.Rotate(ctx, "control-plane", "nomad-deck-backup-", 2)
	if err != nil || deleted != 2 {
		t.Fatalf("Rotate deleted=%d err=%v", deleted, err)
	}
	items, err := st.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(items) != 2 {
		t.Fatalf("List after rotate: %+v err=%v", items, err)
	}
}

func startTestSFTPServer(t *testing.T, rootDir string, authorizedPub ssh.PublicKey) (host string, port int, fp string) {
	t.Helper()
	hostPriv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	fp = ssh.FingerprintSHA256(hostSigner.PublicKey())

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), authorizedPub.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("unauthorized key")
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for newChan := range chans {
					if newChan.ChannelType() != "session" {
						_ = newChan.Reject(ssh.UnknownChannelType, "unknown")
						continue
					}
					ch, reqs, err := newChan.Accept()
					if err != nil {
						continue
					}
					go func(in <-chan *ssh.Request) {
						for req := range in {
							ok := req.Type == "subsystem" && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp"
							if req.WantReply {
								_ = req.Reply(ok, nil)
							}
							if ok {
								srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(rootDir))
								if err == nil {
									_ = srv.Serve()
									srv.Close()
								}
								return
							}
						}
					}(reqs)
				}
			}(conn)
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port, fp
}

func TestSFTPStoreVerifyAndRotate(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t, 1)

	pair, err := crypto.GenerateEd25519("test")
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(pair.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	encKey, _ := svc.Keys.Encrypt(pair.PrivatePEM, db.SSHKeyAAD("k1"))
	if err := db.InsertSSHKey(ctx, svc.DB.Writer, &db.SSHKey{
		ID: "k1", Name: "sftp-key", Algorithm: "ed25519", PublicKey: pair.PublicKey,
		PrivateKeyEncrypted: encKey, Fingerprint: pair.Fingerprint, IsDefault: true,
		CreatedAt: svc.DB.Now(), UpdatedAt: svc.DB.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	sftpRoot := t.TempDir()
	host, port, fp := startTestSFTPServer(t, sftpRoot, pub)
	target := Target{
		ID: "t-sftp", Name: "sftp-offsite", Type: TargetSFTP, Enabled: true,
		Host: host, Port: port, Username: "backup", SSHKeyID: "k1",
		HostKeyFingerprint: fp, RemoteDir: filepath.Join(sftpRoot, "repo"),
		RetentionCount: 2, SnapshotRetentionCount: 2,
	}
	st, err := svc.newStore(target)
	if err != nil {
		t.Fatal(err)
	}
	res, err := st.Test(ctx)
	if err != nil || !res.OK || res.HostKeyFingerprint != fp {
		t.Fatalf("SFTP Test: %+v err=%v", res, err)
	}

	tmp := t.TempDir()
	for i := 1; i <= 3; i++ {
		data := []byte(fmt.Sprintf("sftp-item-%d", i))
		sum := sha256.Sum256(data)
		p := filepath.Join(tmp, fmt.Sprintf("f%d", i))
		_ = os.WriteFile(p, data, 0o600)
		name := fmt.Sprintf("nomad-deck-backup-2026112%dT000000Z-s%d.ndbundle", i, i)
		if _, err := st.PutAndVerify(ctx, "control-plane", name, p, hex.EncodeToString(sum[:]), int64(len(data))); err != nil {
			t.Fatalf("SFTP PutAndVerify %d: %v", i, err)
		}
	}
	deleted, err := st.Rotate(ctx, "control-plane", "nomad-deck-backup-", 1)
	if err != nil || deleted != 2 {
		t.Fatalf("SFTP Rotate deleted=%d err=%v", deleted, err)
	}
	list, err := st.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(list) != 1 {
		t.Fatalf("SFTP List: %+v err=%v", list, err)
	}
	rc, err := st.Open(ctx, list[0].Object)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "sftp-item-3" {
		t.Fatalf("SFTP Open got %q", got)
	}
}

func decodeAWSChunked(b []byte) []byte {
	var out bytes.Buffer
	for len(b) > 0 {
		idx := bytes.Index(b, []byte("\r\n"))
		if idx < 0 {
			break
		}
		hdr := string(b[:idx])
		if semi := strings.IndexByte(hdr, ';'); semi >= 0 {
			hdr = hdr[:semi]
		}
		var n int
		if _, err := fmt.Sscanf(hdr, "%x", &n); err != nil {
			break
		}
		b = b[idx+2:]
		if n == 0 {
			break
		}
		if n > len(b) {
			n = len(b)
		}
		out.Write(b[:n])
		b = b[n:]
		if bytes.HasPrefix(b, []byte("\r\n")) {
			b = b[2:]
		}
	}
	return out.Bytes()
}

func startTestS3Server(t *testing.T, bucket string) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	objects := map[string][]byte{}
	modTimes := map[string]time.Time{}

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			w.WriteHeader(http.StatusOK)
			return
		}
		parts := strings.SplitN(p, "/", 2)
		if parts[0] != bucket {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// Bucket HEAD / GET ListObjectsV2.
		if len(parts) == 1 || parts[1] == "" {
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusOK)
				return
			}
			if r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
				prefix := r.URL.Query().Get("prefix")
				mu.Lock()
				var keys []string
				for k := range objects {
					if strings.HasPrefix(k, prefix) {
						keys = append(keys, k)
					}
				}
				sort.Strings(keys)
				type item struct {
					Key          string `xml:"Key"`
					LastModified string `xml:"LastModified"`
					Size         int    `xml:"Size"`
					ETag         string `xml:"ETag"`
				}
				type listResp struct {
					XMLName     xml.Name `xml:"ListBucketResult"`
					Name        string   `xml:"Name"`
					Prefix      string   `xml:"Prefix"`
					KeyCount    int      `xml:"KeyCount"`
					MaxKeys     int      `xml:"MaxKeys"`
					IsTruncated bool     `xml:"IsTruncated"`
					Contents    []item   `xml:"Contents"`
				}
				resp := listResp{Name: bucket, Prefix: prefix, KeyCount: len(keys), MaxKeys: 1000}
				for _, k := range keys {
					resp.Contents = append(resp.Contents, item{
						Key: k, LastModified: modTimes[k].UTC().Format(time.RFC3339), Size: len(objects[k]), ETag: `"etag"`,
					})
				}
				mu.Unlock()
				w.Header().Set("Content-Type", "application/xml")
				_ = xml.NewEncoder(w).Encode(resp)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}

		key := parts[1]
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			if strings.HasPrefix(r.Header.Get("X-Amz-Content-Sha256"), "STREAMING-") {
				b = decodeAWSChunked(b)
			}
			mu.Lock()
			objects[key] = b
			modTimes[key] = time.Now().UTC()
			mu.Unlock()
			w.Header().Set("ETag", `"etag"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			mu.Lock()
			b, ok := objects[key]
			mt := modTimes[key]
			mu.Unlock()
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Last-Modified", mt.UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"etag"`)
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(b)))
			_, _ = w.Write(b)
		case http.MethodHead:
			mu.Lock()
			b, ok := objects[key]
			mt := modTimes[key]
			mu.Unlock()
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Last-Modified", mt.UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"etag"`)
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(b)))
			w.WriteHeader(http.StatusOK)
		case http.MethodDelete:
			mu.Lock()
			delete(objects, key)
			delete(modTimes, key)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
}

func TestS3StoreVerifyAndRotate(t *testing.T) {
	ctx := context.Background()
	srv := startTestS3Server(t, "nd-bucket")
	defer srv.Close()

	st, err := newS3Store(Target{
		ID: "t-s3", Name: "s3-offsite", Type: TargetS3, Enabled: true,
		Endpoint: srv.URL, Region: "us-east-1", Bucket: "nd-bucket", Prefix: "prod",
		AccessKeyID: "ak", SecretAccessKey: "sk", PathStyle: true,
		RetentionCount: 2, SnapshotRetentionCount: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := st.Test(ctx)
	if err != nil || !res.OK {
		t.Fatalf("S3 Test: %+v err=%v", res, err)
	}

	tmp := t.TempDir()
	for i := 1; i <= 3; i++ {
		data := []byte(fmt.Sprintf("s3-item-%d", i))
		sum := sha256.Sum256(data)
		p := filepath.Join(tmp, fmt.Sprintf("f%d", i))
		_ = os.WriteFile(p, data, 0o600)
		name := fmt.Sprintf("nomad-deck-backup-2026112%dT000000Z-k%d.ndbundle", i, i)
		if _, err := st.PutAndVerify(ctx, "control-plane", name, p, hex.EncodeToString(sum[:]), int64(len(data))); err != nil {
			t.Fatalf("S3 PutAndVerify %d: %v", i, err)
		}
	}
	deleted, err := st.Rotate(ctx, "control-plane", "nomad-deck-backup-", 2)
	if err != nil || deleted != 1 {
		t.Fatalf("S3 Rotate deleted=%d err=%v", deleted, err)
	}
	list, err := st.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(list) != 2 {
		t.Fatalf("S3 List: %+v err=%v", list, err)
	}
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

func TestDisasterRecoveryAndOffsiteSnapshotRestore(t *testing.T) {
	ctx := context.Background()
	src, _ := newTestService(t, 1)
	now := src.DB.Now()

	// Seed admin, ssh key, node, cluster, and offsite backup targets (local + SFTP).
	if _, err := src.DB.Writer.Exec(`INSERT INTO admins (id, username, password_hash, role, is_disabled, created_at, updated_at)
		VALUES ('a1', 'root', 'hash', 'admin', 0, ?, ?)`, db.FormatTime(now), db.FormatTime(now)); err != nil {
		t.Fatal(err)
	}
	pair, _ := crypto.GenerateEd25519("dr")
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(pair.PublicKey))
	encSSH, _ := src.Keys.Encrypt(pair.PrivatePEM, db.SSHKeyAAD("k1"))
	if err := db.InsertSSHKey(ctx, src.DB.Writer, &db.SSHKey{
		ID: "k1", Name: "dr-key", Algorithm: "ed25519", PublicKey: pair.PublicKey,
		PrivateKeyEncrypted: encSSH, Fingerprint: pair.Fingerprint, IsDefault: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertCluster(ctx, src.DB.Writer, &db.Cluster{
		ID: "c1", Name: "v1", Type: "vault", Mode: "single", TLSConfigJSON: "{}",
		APIEndpointsJSON: "[]", ConfigJSON: "{}", InitState: db.InitInitialized,
		HealthStatus: "healthy", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	sftpRoot := t.TempDir()
	host, port, fp := startTestSFTPServer(t, sftpRoot, pub)
	localDir := filepath.Join(t.TempDir(), "local-dr")
	pass := "backup-passphrase-123"
	if _, err := src.SaveConfig(ctx, audit.Actor{Name: "root"}, ConfigInput{
		Enabled:    true,
		Passphrase: &pass,
		Targets: []TargetInput{
			{ID: "t-loc", Name: "local", Type: TargetLocal, Enabled: true, Path: localDir, RetentionCount: 2, SnapshotRetentionCount: 2},
			{ID: "t-sftp", Name: "sftp", Type: TargetSFTP, Enabled: true, Host: host, Port: port, Username: "ops",
				SSHKeyID: "k1", HostKeyFingerprint: fp, RemoteDir: filepath.Join(sftpRoot, "dr"),
				RetentionCount: 2, SnapshotRetentionCount: 2},
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

	// Pick the bundle from the SFTP target.
	sftpSt, _ := src.newStore(Target{Type: TargetSFTP, Host: host, Port: port, Username: "ops", SSHKeyID: "k1",
		HostKeyFingerprint: fp, RemoteDir: filepath.Join(sftpRoot, "dr")})
	// Open bundle from localDir (identical content).
	locSt := &localStore{baseDir: localDir}
	objs, err := locSt.List(ctx, "control-plane", "nomad-deck-backup-")
	if err != nil || len(objs) != 1 {
		t.Fatalf("local bundle list: %+v err=%v", objs, err)
	}
	rc, err := locSt.Open(ctx, objs[0].Object)
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

	// List and import the offsite Raft snapshot on the new control plane.
	_ = sftpSt
	snapsOnTarget, err := dst.ListTargetSnapshots(ctx, "t-sftp")
	if err != nil || len(snapsOnTarget) != 1 {
		t.Fatalf("ListTargetSnapshots: %+v err=%v", snapsOnTarget, err)
	}
	if _, err := dst.ImportSnapshotFromTarget(ctx, audit.Actor{Name: "root"}, "t-sftp", snapsOnTarget[0].Object, "c1", ""); err != nil {
		t.Fatalf("ImportSnapshotFromTarget: %v", err)
	}
	if !bytes.Equal(dstDrv.gotSnap, snapPayload) {
		t.Fatalf("recovered snapshot payload mismatch: %q", dstDrv.gotSnap)
	}
}
