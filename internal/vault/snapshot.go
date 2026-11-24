package vault

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
)

func (s *Service) snapshotDir(ctx context.Context, clusterID string) string {
	var dir string
	_ = db.GetSettingJSON(ctx, s.DB.Reader, "snapshot.dir", &dir)
	if dir == "" {
		dir = filepath.Join(s.DataDir, "snapshots")
	}
	return filepath.Join(dir, clusterID)
}

// takeSnapshot streams a Raft snapshot from the active node into an
// encrypted file and records it.
func (s *Service) takeSnapshot(ctx context.Context, cl *cluster, admin *Client, trigger, by string) (*db.Snapshot, error) {
	h, err := admin.Health(ctx)
	if err != nil {
		return nil, err
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, err
	}
	credGen := ""
	if info, err := admin.LookupSelf(ctx); err == nil {
		credGen = "admin-token:" + info.Accessor
	}
	id := db.NewID()
	path := filepath.Join(s.snapshotDir(ctx, cl.ID), id+".snap")
	w, err := createSnapshotFile(s.Keys, path, id)
	if err != nil {
		return nil, err
	}
	if _, err := admin.SnapshotSave(ctx, w); err != nil {
		w.Abort()
		return nil, fmt.Errorf("导出 Raft 快照失败：%w", err)
	}
	if w.size == 0 {
		w.Abort()
		return nil, errors.New("Raft 快照为空")
	}
	sha, err := w.Close()
	if err != nil {
		return nil, err
	}
	gen := cu.SealGeneration
	snap := &db.Snapshot{ID: id, ClusterID: cl.ID, ClusterType: "vault", ProductVersion: h.Version, SealGeneration: &gen,
		CredentialGeneration: credGen, FilePath: path, SizeBytes: w.size, SHA256: sha, TriggerType: trigger, TriggeredBy: by,
		CreatedAt: s.DB.Now()}
	// Verify the stored file decrypts end to end before registering it.
	r, err := openSnapshotFile(s.Keys, path, id, sha)
	if err == nil {
		var n int64
		n, err = io.Copy(io.Discard, r)
		r.Close()
		if err == nil && n != w.size {
			err = errors.New("snapshot length mismatch")
		}
	}
	if err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("快照回读校验失败：%w", err)
	}
	if err := db.InsertSnapshot(ctx, s.DB.Writer, snap); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return snap, nil
}

// CreateSnapshot takes a manual snapshot (shared cluster lock).
func (s *Service) CreateSnapshot(ctx context.Context, actor audit.Actor, clusterID string) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if cl.InitState != db.InitInitialized {
		return nil, conflict("not_initialized", "集群尚未完成初始化")
	}
	trigger := "manual"
	if actor.Name == audit.ActorCron.Name {
		trigger = "scheduled"
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "cluster.snapshot", TargetType: "cluster", TargetID: clusterID,
		Locks: []ops.LockReq{{Key: ops.ClusterLock(clusterID), Mode: ops.Shared}}, TriggeredBy: actor.Name,
		Run: func(ctx context.Context, t *ops.Task) error {
			step, err := t.Step("导出并加密 Raft 快照", "")
			if err != nil {
				return err
			}
			admin, _, err := s.adminClient(ctx, cl)
			var snap *db.Snapshot
			if err == nil {
				snap, err = s.takeSnapshot(ctx, cl, admin, trigger, actor.Name)
			}
			if err == nil {
				step.Logf("快照 %s 已加密保存（%d 字节，代际 %d）", snap.ID, snap.SizeBytes, *snap.SealGeneration)
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
	SealGeneration       *int      `json:"seal_generation"`
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
		out = append(out, SnapshotView{ID: sn.ID, ProductVersion: sn.ProductVersion, SealGeneration: sn.SealGeneration,
			CredentialGeneration: sn.CredentialGeneration, SizeBytes: sn.SizeBytes, SHA256: sn.SHA256, TriggerType: sn.TriggerType,
			TriggeredBy: sn.TriggeredBy, CreatedAt: sn.CreatedAt})
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
		return notFound(err)
	}
	if err := db.DeleteSnapshot(ctx, s.DB.Writer, sn.ID); err != nil {
		return err
	}
	_ = os.Remove(sn.FilePath)
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_delete", ResourceType: "cluster",
		ResourceID: clusterID, Summary: map[string]any{"snapshot_id": sn.ID}})
}

func notFound(err error) error { return err }

// WriteArchive streams a passphrase-encrypted portable archive of a snapshot.
func (s *Service) WriteArchive(ctx context.Context, actor audit.Actor, clusterID, snapID, passphrase string, w io.Writer) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	sn, err := s.snapshotOf(ctx, clusterID, snapID)
	if err != nil {
		return notFound(err)
	}
	r, err := openSnapshotFile(s.Keys, sn.FilePath, sn.ID, sn.SHA256)
	if err != nil {
		return err
	}
	defer r.Close()
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_download", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"snapshot_id": sn.ID}})
	return writeArchive(w, r, ArchiveMeta{ClusterName: cl.Name, ClusterType: "vault", ProductVersion: sn.ProductVersion,
		SealGeneration: sn.SealGeneration, CreatedAt: sn.CreatedAt}, passphrase)
}

// ImportArchive registers an uploaded portable archive as a snapshot.
func (s *Service) ImportArchive(ctx context.Context, actor audit.Actor, clusterID string, src io.ReadCloser, passphrase string) (*db.Snapshot, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		src.Close()
		return nil, err
	}
	meta, r, err := readArchive(src, passphrase)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	defer r.Close()
	if meta.ClusterType != "vault" {
		return nil, badRequest("归档不是 Vault 快照")
	}
	id := db.NewID()
	path := filepath.Join(s.snapshotDir(ctx, cl.ID), id+".snap")
	w, err := createSnapshotFile(s.Keys, path, id)
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
	snap := &db.Snapshot{ID: id, ClusterID: cl.ID, ClusterType: "vault", ProductVersion: meta.ProductVersion,
		SealGeneration: meta.SealGeneration, CredentialGeneration: "uploaded:" + meta.ArchiveID, FilePath: path, SizeBytes: w.size,
		SHA256: sha, TriggerType: "uploaded", TriggeredBy: actor.Name, CreatedAt: s.DB.Now()}
	if err := db.InsertSnapshot(ctx, s.DB.Writer, snap); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.snapshot_upload", ResourceType: "cluster",
		ResourceID: clusterID, ResourceName: cl.Name, Summary: map[string]any{"snapshot_id": id, "source_cluster": meta.ClusterName,
			"seal_generation": meta.SealGeneration}})
	return snap, nil
}

// ---- Restore ----

// RestoreInput starts or resumes a restore.
type RestoreInput struct {
	Force        bool   `json:"force"`
	ResumeTaskID string `json:"resume_task_id"`
}

type restoreIntent struct {
	Phase      string `json:"phase"`
	SnapshotID string `json:"snapshot_id"`
	Generation int    `json:"generation"`
	Force      bool   `json:"force"`
}

var restorePhases = []string{"preflight", "maintenance", "restored", "recovered", "generation", "credentials", "done"}

func phaseIndex(p string) int {
	for i, v := range restorePhases {
		if v == p {
			return i
		}
	}
	return 0
}

// Restore restores a snapshot through the checkpointed state machine.
func (s *Service) Restore(ctx context.Context, actor audit.Actor, clusterID, snapID string, in RestoreInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	intent := restoreIntent{Phase: "preflight", SnapshotID: snapID, Force: in.Force}
	if in.ResumeTaskID != "" {
		prev, err := db.GetTask(ctx, s.DB.Reader, in.ResumeTaskID)
		if err != nil || prev.Action != "snapshot.restore" || prev.TargetID != clusterID {
			return nil, badRequest("要续做的恢复任务不存在")
		}
		if prev.Status == db.TaskSuccess || prev.Status == db.TaskRunning || prev.Status == db.TaskPending {
			return nil, conflict("not_resumable", "该恢复任务状态为 %s，无需续做", prev.Status)
		}
		var pi restoreIntent
		if err := json.Unmarshal([]byte(prev.IntentJSON), &pi); err != nil || pi.SnapshotID == "" {
			return nil, conflict("not_resumable", "该恢复任务没有可用的检查点")
		}
		intent = pi
		snapID = pi.SnapshotID
	}
	sn, err := s.snapshotOf(ctx, clusterID, snapID)
	if err != nil {
		return nil, notFound(err)
	}
	if sn.SealGeneration == nil {
		return nil, conflict("no_generation", "快照没有记录密钥代际，无法恢复")
	}
	if _, _, err := s.keysOf(ctx, s.DB.Reader, clusterID, *sn.SealGeneration); err != nil {
		return nil, conflict("generation_missing", "找不到快照对应的第 %d 代 Unseal Key，拒绝恢复", *sn.SealGeneration)
	}
	cu, err := db.GetCustody(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	if phaseIndex(intent.Phase) < phaseIndex("restored") {
		if *sn.SealGeneration != cu.SealGeneration && !intent.Force {
			return nil, conflict("force_required", "快照使用第 %d 代密钥，当前生效第 %d 代：需要以 force 模式恢复并单独授权", *sn.SealGeneration, cu.SealGeneration)
		}
		if cl.Settings.Version != "" && sn.ProductVersion != "" &&
			release.CompareVersions(strings.SplitN(sn.ProductVersion, "+", 2)[0], cl.Settings.Version) > 0 {
			return nil, conflict("version_incompatible", "快照来自更高版本的 Vault（%s），当前集群为 %s", sn.ProductVersion, cl.Settings.Version)
		}
	}
	intent.Generation = *sn.SealGeneration
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "snapshot.restore", TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name,
		Params: map[string]any{"snapshot_id": sn.ID, "force": intent.Force, "resume_from": intent.Phase},
		Run: func(ctx context.Context, t *ops.Task) error {
			return s.runRestore(ctx, t, actor, cl, sn, intent)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "snapshot.restore", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"snapshot_id": sn.ID, "force": intent.Force,
			"seal_generation": intent.Generation, "resume_from": intent.Phase}})
	return task, nil
}

func (s *Service) runRestore(ctx context.Context, t *ops.Task, actor audit.Actor, cl *cluster, sn *db.Snapshot, in restoreIntent) error {
	at := phaseIndex(in.Phase)
	checkpoint := func(phase string) {
		in.Phase = phase
		_ = t.Checkpoint(in)
	}
	checkpoint(restorePhases[at])
	step := func(name string, f func(log func(string, ...any)) error) error {
		st, err := t.Step(name, "")
		if err != nil {
			return err
		}
		err = f(st.Logf)
		st.Finish(err, nil)
		return err
	}
	// 2. Maintenance and suppression are persisted before anything else.
	if at < phaseIndex("maintenance") {
		if err := step("进入维护态", func(log func(string, ...any)) error {
			return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
				if err := db.SetClusterMaintenance(ctx, tx, cl.ID, true, "snapshot_restore", s.DB.Now()); err != nil {
					return err
				}
				cu, err := db.GetCustody(ctx, tx, cl.ID)
				if err != nil {
					return err
				}
				cu.UnsealSuppressedReason = "snapshot_restore"
				return db.SaveCustody(ctx, tx, cu, s.DB.Now())
			})
		}); err != nil {
			return err
		}
		checkpoint("maintenance")
	}
	// 3. Restore.
	if at < phaseIndex("restored") {
		if err := step("恢复 Raft 快照", func(log func(string, ...any)) error {
			admin, _, err := s.adminClient(ctx, cl)
			if err != nil {
				return err
			}
			r, err := openSnapshotFile(s.Keys, sn.FilePath, sn.ID, sn.SHA256)
			if err != nil {
				return err
			}
			defer r.Close()
			log("提交快照 %s（%d 字节，force=%v）", sn.ID, sn.SizeBytes, in.Force)
			return admin.SnapshotRestore(ctx, r, in.Force)
		}); err != nil {
			return err
		}
		checkpoint("restored")
	}
	keys, _, err := s.keysOf(ctx, s.DB.Reader, cl.ID, in.Generation)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return err
	}
	// 4. Wait for a leader and unseal every node with the snapshot's keys.
	if at < phaseIndex("recovered") {
		if err := step("确认集群恢复", func(log func(string, ...any)) error {
			deadline := time.Now().Add(s.joinTimeout())
			for {
				allUnsealed, active := true, false
				for _, m := range members {
					c, err := s.client(cl, m, "")
					if err != nil {
						return err
					}
					h, err := c.Health(ctx)
					if err != nil {
						allUnsealed = false
						continue
					}
					if h.Sealed {
						allUnsealed = false
						if sealed, err := unsealWith(ctx, c, keys); err != nil || sealed {
							log("解封 %s：%v", m.NodeName, err)
						} else {
							log("%s 已使用第 %d 代密钥解封", m.NodeName, in.Generation)
						}
						continue
					}
					if !h.Standby {
						active = true
					}
				}
				if allUnsealed && active {
					return nil
				}
				if time.Now().After(deadline) {
					return errors.New("等待全部节点解封并选出 Active 超时")
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(s.poll()):
				}
			}
		}); err != nil {
			return err
		}
		checkpoint("recovered")
	}
	// 5. Move the generation pointer to the snapshot's generation.
	if at < phaseIndex("generation") {
		if err := step("更新密钥代际", func(log func(string, ...any)) error {
			cu, err := db.GetCustody(ctx, s.DB.Reader, cl.ID)
			if err != nil {
				return err
			}
			if cu.SealGeneration == in.Generation {
				log("快照与当前生效代际相同（第 %d 代）", in.Generation)
				return nil
			}
			if err := s.activateGeneration(ctx, cl, in.Generation, log); err != nil {
				return err
			}
			return nil
		}); err != nil {
			return err
		}
		checkpoint("generation")
	}
	// 6. Credentials: re-issue the admin token if the snapshot predates it.
	if at < phaseIndex("credentials") {
		if err := step("核对托管凭据", func(log func(string, ...any)) error {
			am, err := s.activeMember(ctx, cl, members)
			if err != nil {
				return err
			}
			c, _ := s.client(cl, am, "")
			tok, _ := s.adminToken(ctx, cl.ID)
			if tok != "" {
				if _, err := c.WithToken(tok).LookupSelf(ctx); err == nil {
					log("运维 Token 在恢复后的集群中仍然有效")
					return s.waitVoters(ctx, cl, c.WithToken(tok), len(members), log)
				}
			}
			log("运维 Token 在快照中不存在或已失效，使用第 %d 代密钥经 generate-root 重新签发", in.Generation)
			if err := s.reissueAdminToken(ctx, cl, c, keys, log); err != nil {
				return err
			}
			_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "vault.recover_token", ResourceType: "cluster",
				ResourceID: cl.ID, ResourceName: cl.Name, OperationTaskID: t.ID, Summary: map[string]any{"reason": "snapshot_restore"}})
			tok, err = s.adminToken(ctx, cl.ID)
			if err != nil {
				return err
			}
			return s.waitVoters(ctx, cl, c.WithToken(tok), len(members), log)
		}); err != nil {
			return err
		}
		checkpoint("credentials")
	}
	// 7. Leave maintenance.
	if err := step("退出维护态", func(log func(string, ...any)) error {
		return s.DB.WithTx(ctx, func(tx *sql.Tx) error {
			if err := db.SetClusterMaintenance(ctx, tx, cl.ID, false, "", s.DB.Now()); err != nil {
				return err
			}
			cu, err := db.GetCustody(ctx, tx, cl.ID)
			if err != nil {
				return err
			}
			if cu.UnsealSuppressedReason == "snapshot_restore" {
				cu.UnsealSuppressedReason = ""
			}
			return db.SaveCustody(ctx, tx, cu, s.DB.Now())
		})
	}); err != nil {
		return err
	}
	checkpoint("done")
	_, _, _ = s.SyncStatus(ctx, cl.ID)
	return nil
}

// waitVoters waits until autopilot reports every member as a healthy voter.
func (s *Service) waitVoters(ctx context.Context, cl *cluster, admin *Client, want int, log func(string, ...any)) error {
	deadline := time.Now().Add(s.joinTimeout())
	for {
		ap, err := admin.AutopilotState(ctx)
		if err == nil {
			healthy := 0
			for _, sv := range ap.Servers {
				if sv.Healthy && (sv.Status == "voter" || sv.Status == "leader") {
					healthy++
				}
			}
			if healthy >= want {
				log("全部 %d 个 Raft 成员健康且已追平", healthy)
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待 Raft 成员恢复健康超时（%v）", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.poll()):
		}
	}
}
