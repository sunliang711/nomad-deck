package cron

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/jobs"
)

// customType is an administrator-definable job kind.
type customType struct {
	// validate checks and normalizes a payload.
	validate func(ctx context.Context, raw json.RawMessage) (any, error)
	run      Handler
}

// CustomPayload is the union of custom job payload fields.
type CustomPayload struct {
	Type          string `json:"type"`
	ClusterID     string `json:"cluster_id,omitempty"`
	NodeID        string `json:"node_id,omitempty"`
	IntegrationID string `json:"integration_id,omitempty"`
	Namespace     string `json:"namespace,omitempty"`
	Keep          int    `json:"keep,omitempty"`
}

func decodePayload(raw json.RawMessage) (*CustomPayload, error) {
	var p CustomPayload
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return nil, badRequest("payload 格式错误：%v", err)
	}
	return &p, nil
}

func (p *Platform) installCustom(s *Scheduler) {
	clusterOf := func(ctx context.Context, id string, types ...string) (*db.Cluster, error) {
		c, err := db.GetCluster(ctx, s.DB.Reader, id)
		if err != nil {
			return nil, badRequest("集群不存在")
		}
		for _, t := range types {
			if c.Type == t {
				return c, nil
			}
		}
		return nil, badRequest("集群类型不支持该任务")
	}
	s.mu.Lock()
	s.init()
	s.customs["cluster_snapshot"] = customType{
		validate: func(ctx context.Context, raw json.RawMessage) (any, error) {
			pl, err := decodePayload(raw)
			if err != nil {
				return nil, err
			}
			if _, err := clusterOf(ctx, pl.ClusterID, "nomad", "vault"); err != nil {
				return nil, err
			}
			return CustomPayload{Type: pl.Type, ClusterID: pl.ClusterID}, nil
		},
		run: func(ctx context.Context, r *Run) (string, error) {
			var pl CustomPayload
			_ = r.Payload(&pl)
			c, err := clusterOf(ctx, pl.ClusterID, "nomad", "vault")
			if err != nil {
				return "", err
			}
			if c.InitState != db.InitInitialized || c.MaintenanceMode {
				return "", Skip("集群 %s 未初始化或处于维护态", c.Name)
			}
			return p.snapshotTask(ctx, s, r, []*db.Cluster{c}, "cluster.snapshot", c.ID, "scheduled")
		},
	}
	s.customs["doctor"] = customType{
		validate: func(ctx context.Context, raw json.RawMessage) (any, error) {
			pl, err := decodePayload(raw)
			if err != nil {
				return nil, err
			}
			switch {
			case pl.ClusterID != "" && pl.NodeID == "":
				if _, err := clusterOf(ctx, pl.ClusterID, "nomad", "vault"); err != nil {
					return nil, err
				}
			case pl.NodeID != "" && pl.ClusterID == "":
				if _, err := db.GetNode(ctx, s.DB.Reader, pl.NodeID); err != nil {
					return nil, badRequest("主机不存在")
				}
			default:
				return nil, badRequest("cluster_id 与 node_id 需且仅需指定一个")
			}
			return CustomPayload{Type: pl.Type, ClusterID: pl.ClusterID, NodeID: pl.NodeID}, nil
		},
		run: func(ctx context.Context, r *Run) (string, error) {
			var pl CustomPayload
			_ = r.Payload(&pl)
			if pl.NodeID != "" {
				res, err := p.Hosts.Test(ctx, audit.ActorCron, pl.NodeID)
				if err != nil {
					return "", err
				}
				for _, w := range res.Warnings {
					r.Logf("警告：%s", w)
				}
				return fmt.Sprintf("主机 %s 体检完成，%d 条警告", res.Node.Name, len(res.Warnings)), nil
			}
			c, err := clusterOf(ctx, pl.ClusterID, "nomad", "vault")
			if err != nil {
				return "", err
			}
			rep, err := p.Drivers[c.Type].Doctor(ctx, c.ID)
			if err != nil {
				return "", err
			}
			fails, warns := 0, 0
			for _, ck := range rep.Checks {
				switch ck.Status {
				case "FAIL":
					fails++
				case "WARN":
					warns++
				}
				if ck.Status != "OK" {
					r.Logf("[%s] %s %s：%s", ck.Status, ck.Node, ck.Name, ck.Message)
				}
			}
			sum := fmt.Sprintf("集群 %s 体检：%d 项失败，%d 项警告", c.Name, fails, warns)
			if fails > 0 {
				return sum, errors.New("体检存在失败项")
			}
			return sum, nil
		},
	}
	s.customs["nomad_job_export"] = customType{
		validate: func(ctx context.Context, raw json.RawMessage) (any, error) {
			pl, err := decodePayload(raw)
			if err != nil {
				return nil, err
			}
			if _, err := clusterOf(ctx, pl.ClusterID, "nomad"); err != nil {
				return nil, err
			}
			if pl.Keep <= 0 {
				pl.Keep = DefaultExportRetention
			}
			if pl.Keep > 365 {
				return nil, badRequest("keep 不能超过 365")
			}
			if pl.Namespace == "" {
				pl.Namespace = "*"
			}
			return CustomPayload{Type: pl.Type, ClusterID: pl.ClusterID, Namespace: pl.Namespace, Keep: pl.Keep}, nil
		},
		run: func(ctx context.Context, r *Run) (string, error) {
			var pl CustomPayload
			_ = r.Payload(&pl)
			if p.Jobs == nil {
				return "", Skip("Job 中心不可用")
			}
			dir := filepath.Join(p.DataDir, "exports", pl.ClusterID)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return "", err
			}
			name := "jobs-" + time.Now().UTC().Format("20060102T150405Z") + ".zip"
			tmp := filepath.Join(dir, "."+name+".tmp")
			f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return "", err
			}
			err = p.Jobs.Export(ctx, audit.ActorCron, pl.ClusterID, jobs.ExportInput{Namespace: pl.Namespace}, f)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				_ = os.Remove(tmp)
				return "", err
			}
			if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
				return "", err
			}
			removed := rotateFiles(dir, "jobs-", pl.Keep)
			r.Logf("导出文件 %s，轮转删除 %d 份旧导出", name, removed)
			return "Job 定义已导出为 " + name, nil
		},
	}
	s.customs["static_jwks_sync"] = customType{
		validate: func(ctx context.Context, raw json.RawMessage) (any, error) {
			pl, err := decodePayload(raw)
			if err != nil {
				return nil, err
			}
			if _, err := db.GetIntegration(ctx, s.DB.Reader, pl.IntegrationID); err != nil {
				return nil, badRequest("联动配置不存在")
			}
			return CustomPayload{Type: pl.Type, IntegrationID: pl.IntegrationID}, nil
		},
		run: func(ctx context.Context, r *Run) (string, error) {
			var pl CustomPayload
			_ = r.Payload(&pl)
			if p.Integrations == nil {
				return "", Skip("联动模块不可用")
			}
			if err := p.Integrations.SyncStaticKeys(ctx, pl.IntegrationID, r.Logf); err != nil {
				return "", err
			}
			return "静态 JWKS 公钥已同步", nil
		},
	}
	s.mu.Unlock()
}

// JobInput creates or edits a job. Built-in jobs accept only schedule,
// policies and enabled.
type JobInput struct {
	Name          string          `json:"name"`
	CronExpr      string          `json:"cron_expr"`
	OverlapPolicy string          `json:"overlap_policy"`
	MisfirePolicy string          `json:"misfire_policy"`
	Enabled       *bool           `json:"enabled"`
	Payload       json.RawMessage `json:"payload"`
}

func (in *JobInput) apply(s *Scheduler, ctx context.Context, j *db.CronJob) error {
	if in.Name != "" {
		if len([]rune(in.Name)) > 64 {
			return badRequest("名称不能超过 64 个字符")
		}
		j.Name = in.Name
	}
	if in.CronExpr != "" {
		if _, err := ParseExpr(in.CronExpr); err != nil {
			return badRequest("%v", err)
		}
		j.CronExpr = strings.TrimSpace(in.CronExpr)
	}
	if in.OverlapPolicy != "" {
		if in.OverlapPolicy != "skip_if_running" && in.OverlapPolicy != "queue_one" {
			return badRequest("overlap_policy 需为 skip_if_running 或 queue_one")
		}
		j.OverlapPolicy = in.OverlapPolicy
	}
	if in.MisfirePolicy != "" {
		if in.MisfirePolicy != "skip" && in.MisfirePolicy != "run_once" {
			return badRequest("misfire_policy 需为 skip 或 run_once")
		}
		j.MisfirePolicy = in.MisfirePolicy
	}
	if in.Enabled != nil {
		j.Enabled = *in.Enabled
	}
	if len(in.Payload) > 0 && string(in.Payload) != "null" {
		if j.IsBuiltin {
			return badRequest("内置任务不支持修改 payload")
		}
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(in.Payload, &head)
		s.mu.Lock()
		ct, ok := s.customs[head.Type]
		s.mu.Unlock()
		if !ok {
			return badRequest("不支持的任务类型 %q（可选 cluster_snapshot、doctor、nomad_job_export、static_jwks_sync）", head.Type)
		}
		norm, err := ct.validate(ctx, in.Payload)
		if err != nil {
			return err
		}
		b, _ := json.Marshal(norm)
		j.PayloadJSON = string(b)
	}
	return nil
}

// Create adds a custom job.
func (s *Scheduler) Create(ctx context.Context, actor audit.Actor, in JobInput) (*db.CronJob, error) {
	if in.Name == "" || in.CronExpr == "" || len(in.Payload) == 0 {
		return nil, badRequest("name、cron_expr 与 payload 必填")
	}
	j := &db.CronJob{ID: db.NewID(), OverlapPolicy: "skip_if_running", MisfirePolicy: "skip", Enabled: true}
	j.JobKey = "custom-" + strings.ToLower(j.ID)
	if err := in.apply(s, ctx, j); err != nil {
		return nil, err
	}
	j.UpdatedAt = s.DB.Now()
	if j.Enabled {
		j.NextRunAt = s.next(ctx, j, s.now())
	}
	if err := db.InsertCronJob(ctx, s.DB.Writer, j); err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cron.create", ResourceType: "cron_job", ResourceID: j.ID,
		ResourceName: j.Name, Summary: map[string]any{"cron_expr": j.CronExpr, "payload": json.RawMessage(j.PayloadJSON)}})
	s.poke()
	return j, nil
}

// Update edits a job.
func (s *Scheduler) Update(ctx context.Context, actor audit.Actor, id string, in JobInput) (*db.CronJob, error) {
	j, err := db.GetCronJob(ctx, s.DB.Reader, id)
	if err != nil {
		return nil, notFound()
	}
	if j.IsBuiltin && in.Name != "" && in.Name != j.Name {
		return nil, badRequest("内置任务不支持改名")
	}
	if err := in.apply(s, ctx, j); err != nil {
		return nil, err
	}
	j.UpdatedAt = s.DB.Now()
	j.NextRunAt = time.Time{}
	if j.Enabled {
		j.NextRunAt = s.next(ctx, j, s.now())
	}
	if err := db.UpdateCronJob(ctx, s.DB.Writer, j); err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cron.update", ResourceType: "cron_job", ResourceID: j.ID,
		ResourceName: j.JobKey, Summary: map[string]any{"cron_expr": j.CronExpr, "enabled": j.Enabled,
			"overlap_policy": j.OverlapPolicy, "misfire_policy": j.MisfirePolicy}})
	s.poke()
	return j, nil
}

// Delete removes a custom job.
func (s *Scheduler) Delete(ctx context.Context, actor audit.Actor, id string) error {
	j, err := db.GetCronJob(ctx, s.DB.Reader, id)
	if err != nil {
		return notFound()
	}
	if j.IsBuiltin {
		return &auth.Error{Status: 409, Code: "builtin_job", Message: "内置任务不能删除，可将其停用"}
	}
	if s.Running(id) {
		return ErrAlreadyRunning
	}
	if err := db.DeleteCronJob(ctx, s.DB.Writer, id); err != nil {
		return err
	}
	return s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cron.delete", ResourceType: "cron_job", ResourceID: id,
		ResourceName: j.Name})
}

// JobView is a job with its running state.
type JobView struct {
	*db.CronJob
	Payload json.RawMessage `json:"payload"`
	Running bool            `json:"running"`
}

// List returns all jobs.
func (s *Scheduler) List(ctx context.Context) ([]JobView, error) {
	js, err := db.ListCronJobs(ctx, s.DB.Reader)
	if err != nil {
		return nil, err
	}
	out := []JobView{}
	for _, j := range js {
		out = append(out, JobView{CronJob: j, Payload: json.RawMessage(j.PayloadJSON), Running: s.Running(j.ID)})
	}
	return out, nil
}

// Runs returns a job's history.
func (s *Scheduler) Runs(ctx context.Context, id string, limit int) ([]*db.CronRun, error) {
	if _, err := db.GetCronJob(ctx, s.DB.Reader, id); err != nil {
		return nil, notFound()
	}
	runs, err := db.ListCronRuns(ctx, s.DB.Reader, id, limit)
	if runs == nil {
		runs = []*db.CronRun{}
	}
	return runs, err
}
