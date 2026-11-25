package nomad

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/snapstore"
)

func (s *Service) snapshotDir(ctx context.Context, clusterID string) string {
	var dir string
	_ = db.GetSettingJSON(ctx, s.DB.Reader, "snapshot.dir", &dir)
	if dir == "" {
		dir = filepath.Join(s.DataDir, "snapshots")
	}
	return filepath.Join(dir, clusterID)
}

// takeSnapshot streams a Raft snapshot (GET /v1/operator/snapshot) into an
// encrypted file, verifies it decrypts end to end and records it.
func (s *Service) takeSnapshot(ctx context.Context, cl *nomadCluster, trigger, by string) (*db.Snapshot, error) {
	api, m, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return nil, err
	}
	version := m.InstalledVersion
	if self, err := api.Self(ctx); err == nil {
		version = self.Version
	}
	credGen := ""
	if tok, err := api.TokenSelf(ctx); err == nil {
		credGen = "management-token:" + tok.AccessorID
	}
	id := db.NewID()
	path := filepath.Join(s.snapshotDir(ctx, cl.ID), id+".snap")
	var w *snapstore.Writer
	for attempt := 1; ; attempt++ {
		if w, err = snapstore.Create(s.Keys, path, id); err != nil {
			return nil, err
		}
		_, err = api.SnapshotSave(ctx, w)
		if err == nil {
			break
		}
		w.Abort()
		// Right after a membership change Raft refuses snapshots until the
		// configuration entry is applied; that clears within seconds.
		if attempt >= 10 || !strings.Contains(MessageOf(err), "cannot take snapshot now") {
			return nil, fmt.Errorf("导出 Raft 快照失败：%w", err)
		}
		if attempt == 1 {
			_ = api.NudgeRaft(ctx)
		}
		if err := sleep(ctx, s.poll()); err != nil {
			return nil, err
		}
	}
	if w.Size() == 0 {
		w.Abort()
		return nil, errors.New("Raft 快照为空")
	}
	sha, err := w.Close()
	if err != nil {
		return nil, err
	}
	r, err := snapstore.Open(s.Keys, path, id, sha)
	if err == nil {
		var n int64
		n, err = io.Copy(io.Discard, r)
		r.Close()
		if err == nil && n != w.Size() {
			err = errors.New("snapshot length mismatch")
		}
	}
	if err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("快照回读校验失败：%w", err)
	}
	snap := &db.Snapshot{ID: id, ClusterID: cl.ID, ClusterType: "nomad", ProductVersion: version, CredentialGeneration: credGen,
		FilePath: path, SizeBytes: w.Size(), SHA256: sha, TriggerType: trigger, TriggeredBy: by, CreatedAt: s.DB.Now()}
	if err := db.InsertSnapshot(ctx, s.DB.Writer, snap); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return snap, nil
}

// TakeSnapshot exports and stores a snapshot; the caller holds the shared
// cluster lock.
func (s *Service) TakeSnapshot(ctx context.Context, clusterID, trigger, by string) (*db.Snapshot, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成部署与 ACL Bootstrap")
	}
	return s.takeSnapshot(ctx, cl, trigger, by)
}

// CreateSnapshot takes a manual snapshot (shared cluster lock).
func (s *Service) CreateSnapshot(ctx context.Context, actor audit.Actor, clusterID string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成部署与 ACL Bootstrap")
	}
	trigger := "manual"
	if actor.Name == audit.ActorCron.Name {
		trigger = "scheduled"
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.snapshot", TargetType: "cluster", TargetID: clusterID,
		Locks: []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}, TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
			if err != nil {
				return err
			}
			step, err := t.Step("导出并加密 Raft 快照", "")
			if err != nil {
				return err
			}
			snap, err := s.takeSnapshot(ctx, cl, trigger, actor.Name)
			if err == nil {
				step.Logf("快照 %s 已加密保存（%d 字节）", snap.ID, snap.SizeBytes)
				_ = t.Checkpoint(map[string]any{"snapshot_id": snap.ID})
			}
			step.Finish(err, nil)
			return err
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID})
	return task, nil
}

// SnapshotView is a snapshot record without file paths.
type SnapshotView struct {
	ID                   string    `json:"id"`
	ProductVersion       string    `json:"product_version"`
	CredentialGeneration string    `json:"credential_generation"`
	SizeBytes            int64     `json:"size_bytes"`
	SHA256               string    `json:"sha256"`
	TriggerType          string    `json:"trigger_type"`
	TriggeredBy          string    `json:"triggered_by"`
	CreatedAt            time.Time `json:"created_at"`
}

// ListSnapshots lists a cluster's snapshots.
func (s *Service) ListSnapshots(ctx context.Context, clusterID string) ([]SnapshotView, error) {
	snaps, err := db.ListSnapshots(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	out := []SnapshotView{}
	for _, sn := range snaps {
		out = append(out, SnapshotView{ID: sn.ID, ProductVersion: sn.ProductVersion, CredentialGeneration: sn.CredentialGeneration,
			SizeBytes: sn.SizeBytes, SHA256: sn.SHA256, TriggerType: sn.TriggerType, TriggeredBy: sn.TriggeredBy, CreatedAt: sn.CreatedAt})
	}
	return out, nil
}

func (s *Service) snapshotOf(ctx context.Context, clusterID, snapID string) (*db.Snapshot, error) {
	sn, err := db.GetSnapshot(ctx, s.DB.Reader, snapID)
	if err != nil || sn.ClusterID != clusterID {
		return nil, &auth.Error{Status: 404, Code: "not_found", Message: "快照不存在"}
	}
	return sn, nil
}

// DeleteSnapshot removes a snapshot record and file.
func (s *Service) DeleteSnapshot(ctx context.Context, actor audit.Actor, clusterID, snapID string) error {
	sn, err := s.snapshotOf(ctx, clusterID, snapID)
	if err != nil {
		return err
	}
	release, err := s.lockSnapshots(ctx, clusterID, ops.Exclusive)
	if err != nil {
		return err
	}
	defer release()
	if err := db.DeleteSnapshot(ctx, s.DB.Writer, sn.ID); err != nil {
		return err
	}
	_ = os.Remove(sn.FilePath)
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_delete", ResourceType: "cluster",
		ResourceID: clusterID, Summary: map[string]any{"snapshot_id": sn.ID}})
}

// WriteArchive streams a passphrase-encrypted portable archive of a snapshot.
func (s *Service) WriteArchive(ctx context.Context, actor audit.Actor, clusterID, snapID, passphrase string, w io.Writer) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	sn, err := s.snapshotOf(ctx, clusterID, snapID)
	if err != nil {
		return err
	}
	release, err := s.lockSnapshots(ctx, clusterID, ops.Shared)
	if err != nil {
		return err
	}
	defer release()
	r, err := snapstore.Open(s.Keys, sn.FilePath, sn.ID, sn.SHA256)
	if err != nil {
		return err
	}
	defer r.Close()
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_download", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"snapshot_id": sn.ID}})
	return snapstore.WriteArchive(w, r, snapstore.ArchiveMeta{ClusterName: cl.Name, ClusterType: "nomad",
		ProductVersion: sn.ProductVersion, CreatedAt: sn.CreatedAt}, passphrase)
}

// ImportArchive registers an uploaded portable archive as a snapshot.
func (s *Service) ImportArchive(ctx context.Context, actor audit.Actor, clusterID string, src io.ReadCloser, passphrase string) (*db.Snapshot, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		src.Close()
		return nil, err
	}
	meta, r, err := snapstore.ReadArchive(src, passphrase)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	defer r.Close()
	if meta.ClusterType != "nomad" {
		return nil, badRequest("归档不是 Nomad 快照")
	}
	id := db.NewID()
	path := filepath.Join(s.snapshotDir(ctx, cl.ID), id+".snap")
	w, err := snapstore.Create(s.Keys, path, id)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(w, r); err != nil {
		w.Abort()
		return nil, badRequest("归档解密失败（口令错误或文件损坏）：%v", err)
	}
	sha, err := w.Close()
	if err != nil {
		return nil, err
	}
	snap := &db.Snapshot{ID: id, ClusterID: cl.ID, ClusterType: "nomad", ProductVersion: meta.ProductVersion,
		CredentialGeneration: "uploaded:" + meta.ArchiveID, FilePath: path, SizeBytes: w.Size(), SHA256: sha,
		TriggerType: "uploaded", TriggeredBy: actor.Name, CreatedAt: s.DB.Now()}
	if err := db.InsertSnapshot(ctx, s.DB.Writer, snap); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_upload", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"snapshot_id": id, "source_cluster": meta.ClusterName}})
	return snap, nil
}

// Restore restores a snapshot through PUT /v1/operator/snapshot with the
// cluster in maintenance. When the servers were rebuilt (ACL not
// bootstrapped), a temporary bootstrap token performs the restore; the
// stored management token must be valid afterwards, otherwise the cluster
// stays in maintenance until the snapshot's management token is supplied.
func (s *Service) Restore(ctx context.Context, actor audit.Actor, clusterID, snapID string, in cluster.RestoreInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState == db.InitUninitialized {
		return nil, conflict("not_deployed", "集群尚未部署")
	}
	sn, err := s.snapshotOf(ctx, clusterID, snapID)
	if err != nil {
		return nil, err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.snapshot_restore", TargetType: "cluster", TargetID: clusterID,
		Locks: append(memberLocks(clusterID, members), ops.LockReq{Key: ops.SnapshotLock(clusterID), Mode: ops.Shared}), TriggeredBy: actor.Name, Params: map[string]any{"snapshot_id": sn.ID},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRestore(ctx, t, clusterID, sn)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_restore", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"snapshot_id": sn.ID}})
	return task, nil
}

func (s *Service) runRestore(ctx context.Context, t *ops.Task, clusterID string, sn *db.Snapshot) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	if err := db.SetClusterMaintenance(ctx, s.DB.Writer, clusterID, true, "snapshot_restore", s.DB.Now()); err != nil {
		return err
	}
	step, err := t.Step("恢复 Raft 快照", "")
	if err != nil {
		return err
	}
	err = func() error {
		c, _, err := s.bootstrapClient(ctx, cl)
		if err != nil {
			return err
		}
		token, _ := s.managementToken(cl)
		if _, err := c.WithToken(token).TokenSelf(ctx); err != nil {
			// Rebuilt servers: ACLs are not bootstrapped yet.
			tmp, uerr := newUUID()
			if uerr != nil {
				return uerr
			}
			if _, berr := c.Bootstrap(ctx, tmp); berr != nil {
				return fmt.Errorf("托管的 Management Token 无效，且无法以临时 Token Bootstrap（%v）：请先补录可用的 Management Token", berr)
			}
			step.Logf("集群 ACL 未初始化（Server 已重建），以临时 Bootstrap Token 执行恢复")
			token = tmp
		}
		r, err := snapstore.Open(s.Keys, sn.FilePath, sn.ID, sn.SHA256)
		if err != nil {
			return err
		}
		defer r.Close()
		if err := c.WithToken(token).SnapshotRestore(ctx, r); err != nil {
			return fmt.Errorf("恢复快照失败：%w", err)
		}
		step.Logf("快照 %s 已恢复", sn.ID)
		return nil
	}()
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	step, err = t.Step("核对集群与管理凭据", "")
	if err != nil {
		return err
	}
	err = func() error {
		members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
		if err != nil {
			return err
		}
		if _, err := s.waitLeader(ctx, cl, members, step.Logf); err != nil {
			return err
		}
		token, err := s.managementToken(cl)
		if err != nil {
			return err
		}
		c, _, err := s.bootstrapClient(ctx, cl)
		if err != nil {
			return err
		}
		if _, err := c.WithToken(token).TokenSelf(ctx); err != nil {
			return fmt.Errorf("快照中不包含当前托管的 Management Token（%v）：请通过凭据补录提供该快照对应的 Management Token，集群保持维护态", err)
		}
		step.Logf("托管的 Management Token 在恢复后的集群中有效")
		if cl.InitState != db.InitInitialized {
			return s.markInitialized(ctx, cl)
		}
		return nil
	}()
	step.Finish(err, nil)
	if err != nil {
		return err
	}
	if err := db.SetClusterMaintenance(ctx, s.DB.Writer, clusterID, false, "", s.DB.Now()); err != nil {
		return err
	}
	_, _ = s.StatusDetail(ctx, clusterID)
	return nil
}

// lockSnapshots takes the cluster's snapshot-store lock, waiting at most
// 30 seconds.
func (s *Service) lockSnapshots(ctx context.Context, clusterID string, mode ops.LockMode) (func(), error) {
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	release, err := s.Ops.Locks.Acquire(wctx, []ops.LockReq{{Key: ops.SnapshotLock(clusterID), Mode: mode}})
	if err != nil {
		return nil, conflict("snapshots_busy", "该集群的快照正在被轮转、下载或恢复，请稍后再试")
	}
	return release, nil
}
