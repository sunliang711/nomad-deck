package nomad

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/sshx"
)

// newUUID returns a random version 4 UUID (the Nomad secret ID format).
func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// ErrBootstrappedElsewhere means the ACL system was bootstrapped by
// another party; the cluster stays init_in_doubt for controlled recovery.
var ErrBootstrappedElsewhere = errors.New("ACL bootstrapped by another party")

// prepareSecret makes sure a management secret is persisted (encrypted)
// together with init_in_doubt before any bootstrap call.
func (s *Service) prepareSecret(ctx context.Context, cl *nomadCluster) (string, error) {
	if cl.AdminTokenEncrypted != "" {
		if cl.InitState == db.InitUninitialized {
			if err := db.SetClusterInitState(ctx, s.DB.Writer, cl.ID, db.InitInDoubt, s.DB.Now()); err != nil {
				return "", err
			}
			cl.InitState = db.InitInDoubt
		}
		return s.managementToken(cl)
	}
	secret, err := newUUID()
	if err != nil {
		return "", err
	}
	enc, err := s.Keys.EncryptString(secret, db.ClusterAdminTokenAAD(cl.ID))
	if err != nil {
		return "", err
	}
	if err := db.SetClusterAdminToken(ctx, s.DB.Writer, cl.ID, enc, db.InitInDoubt, s.DB.Now()); err != nil {
		return "", err
	}
	cl.AdminTokenEncrypted, cl.InitState = enc, db.InitInDoubt
	return secret, nil
}

// bootstrapClient returns an unauthenticated client on the server that
// currently answers with a leader.
func (s *Service) bootstrapClient(ctx context.Context, cl *nomadCluster) (*Client, *db.ClusterNode, error) {
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, cl.ID)
	if err != nil {
		return nil, nil, err
	}
	var last error
	for _, m := range servers(members) {
		c, err := s.client(cl, m, "")
		if err != nil {
			last = err
			continue
		}
		if leader, err := c.Leader(ctx); err == nil && leader != "" {
			return c, m, nil
		} else if err != nil {
			last = err
		}
	}
	return nil, nil, fmt.Errorf("没有可访问且已选出 Leader 的 Server：%v", last)
}

// bootstrap runs the ACL bootstrap with the pre-generated secret and then
// confirms the outcome whether or not the call returned:
//  1. token/self with the secret succeeds -> initialized;
//  2. otherwise bootstrap again with the same secret: success ->
//     initialized; "already bootstrapped" -> bootstrapped elsewhere (stay
//     in doubt); network errors -> retry with backoff.
func (s *Service) bootstrap(ctx context.Context, cl *nomadCluster, log func(string, ...any)) error {
	secret, err := s.prepareSecret(ctx, cl)
	if err != nil {
		return err
	}
	log("Management Token Secret 已加密落库，集群置为 init_in_doubt")
	if c, _, err := s.bootstrapClient(ctx, cl); err == nil {
		if _, err := c.Bootstrap(ctx, secret); err != nil {
			log("首次 Bootstrap 调用未成功（%v），进入结果确认流程", err)
		} else {
			log("ACL Bootstrap 调用成功")
		}
	}
	return s.confirmBootstrap(ctx, cl, secret, log)
}

func (s *Service) confirmBootstrap(ctx context.Context, cl *nomadCluster, secret string, log func(string, ...any)) error {
	backoff := s.poll()
	deadline := time.Now().Add(s.joinTimeout())
	var last error
	for {
		c, _, err := s.bootstrapClient(ctx, cl)
		if err == nil {
			if _, err = c.WithToken(secret).TokenSelf(ctx); err == nil {
				log("已用预生成 Secret 通过 /v1/acl/token/self 确认 Bootstrap 成功")
				return s.markInitialized(ctx, cl)
			}
			if _, err = c.Bootstrap(ctx, secret); err == nil {
				log("再次 Bootstrap 成功")
				return s.markInitialized(ctx, cl)
			}
			var done *ErrBootstrapDone
			if errors.As(err, &done) {
				log("集群已被其他来源 Bootstrap（reset index %d），保持 init_in_doubt 并转入受控恢复", done.ResetIndex)
				return fmt.Errorf("%w（reset index %d）：请补录已有 Management Token，或按官方流程重置 Bootstrap", ErrBootstrappedElsewhere, done.ResetIndex)
			}
		}
		last = err
		if time.Now().After(deadline) {
			return fmt.Errorf("无法确认 ACL Bootstrap 结果，集群保持 init_in_doubt：%v", last)
		}
		log("确认 Bootstrap 结果失败（%v），%s 后重试", err, backoff)
		if err := sleep(ctx, backoff); err != nil {
			return err
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (s *Service) markInitialized(ctx context.Context, cl *nomadCluster) error {
	if err := db.SetClusterInitState(ctx, s.DB.Writer, cl.ID, db.InitInitialized, s.DB.Now()); err != nil {
		return err
	}
	cl.InitState = db.InitInitialized
	return nil
}

func (s *Service) bootstrapStep(ctx context.Context, t *ops.Task, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	step, err := t.Step("ACL Bootstrap（预生成 Secret）", "")
	if err != nil {
		return err
	}
	err = s.bootstrap(ctx, cl, step.Logf)
	step.Finish(err, nil)
	return err
}

// CredentialsInput resolves a cluster stuck in init_in_doubt.
//   - Mode "retry": run the confirmation flow again with the stored secret.
//   - Mode "token": store an existing management token (validated live).
//   - Mode "reset": follow the official bootstrap reset (write the reset
//     index on the leader) and bootstrap again with the stored secret;
//     ConfirmName must match the cluster name.
type CredentialsInput struct {
	Mode            string `json:"mode"`
	ManagementToken string `json:"management_token"`
	ConfirmName     string `json:"confirm_name"`
}

// SupplyCredentials recovers the management credential of a cluster whose
// ACL bootstrap outcome is unknown or was taken by another party. The
// recovery runs as a task that also finishes the deployment (starting
// clients) once the cluster is initialized.
func (s *Service) SupplyCredentials(ctx context.Context, actor audit.Actor, clusterID string, in CredentialsInput) (*db.OperationTask, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	switch in.Mode {
	case "retry", "reset":
		if cl.InitState != db.InitInDoubt {
			return nil, conflict("not_in_doubt", "只有处于 init_in_doubt 的集群可以重试或重置 Bootstrap")
		}
	case "token":
		if strings.TrimSpace(in.ManagementToken) == "" || len(in.ManagementToken) > 128 {
			return nil, badRequest("请填写 Management Token")
		}
	default:
		return nil, badRequest("mode 需为 retry、token 或 reset")
	}
	if in.Mode == "reset" && in.ConfirmName != cl.Name {
		return nil, badRequest("请输入集群名称以确认重置 ACL Bootstrap")
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	task, err := s.Ops.Submit(ctx, ops.Spec{Action: "nomad.credentials_" + in.Mode, TargetType: "cluster", TargetID: clusterID,
		Locks: memberLocks(clusterID, members), TriggeredBy: actor.Name, Params: map[string]any{"mode": in.Mode},
		Run: func(ctx context.Context, t *ops.Task) error {
			switch in.Mode {
			case "token":
				if err := s.storeToken(ctx, t, clusterID, in.ManagementToken); err != nil {
					return err
				}
			case "retry":
				if err := s.retryStep(ctx, t, clusterID); err != nil {
					return err
				}
			case "reset":
				if err := s.resetBootstrap(ctx, t, clusterID); err != nil {
					return err
				}
			}
			return s.finishDeploy(ctx, t, clusterID)
		}})
	if err != nil {
		return nil, err
	}
	_ = s.Audit.Record(ctx, nil, audit.Event{Actor: actor, Action: "cluster.credentials", ResourceType: "cluster", ResourceID: clusterID,
		ResourceName: cl.Name, OperationTaskID: task.ID, Summary: map[string]any{"mode": in.Mode}})
	return task, nil
}

func (s *Service) retryStep(ctx context.Context, t *ops.Task, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	step, err := t.Step("确认 ACL Bootstrap 结果", "")
	if err != nil {
		return err
	}
	secret, err := s.managementToken(cl)
	if err == nil {
		err = s.confirmBootstrap(ctx, cl, secret, step.Logf)
	}
	step.Finish(err, nil)
	return err
}

// storeToken validates a management token against the cluster and stores it.
func (s *Service) storeToken(ctx context.Context, t *ops.Task, clusterID, token string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	step, err := t.Step("校验并保存 Management Token", "")
	if err != nil {
		return err
	}
	err = func() error {
		c, _, err := s.bootstrapClient(ctx, cl)
		if err != nil {
			return err
		}
		tok, err := c.WithToken(token).TokenSelf(ctx)
		if err != nil {
			return fmt.Errorf("Token 校验失败：%w", err)
		}
		if tok.Type != "management" {
			return badRequest("提供的 Token 类型为 %s，需要 management 类型", tok.Type)
		}
		enc, err := s.Keys.EncryptString(token, db.ClusterAdminTokenAAD(cl.ID))
		if err != nil {
			return err
		}
		step.Logf("Token %s 校验通过（management）", tok.AccessorID)
		return db.SetClusterAdminToken(ctx, s.DB.Writer, cl.ID, enc, db.InitInitialized, s.DB.Now())
	}()
	step.Finish(err, nil)
	return err
}

// resetBootstrap reads the reset index from a bootstrap attempt, writes it
// to server/acl-bootstrap-reset in the leader's data directory and
// bootstraps again with the stored secret.
func (s *Service) resetBootstrap(ctx context.Context, t *ops.Task, clusterID string) error {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	secret, err := s.managementToken(cl)
	if err != nil {
		return err
	}
	c, _, err := s.bootstrapClient(ctx, cl)
	if err != nil {
		return err
	}
	_, err = c.Bootstrap(ctx, secret)
	var done *ErrBootstrapDone
	if err == nil {
		return s.markInitialized(ctx, cl)
	}
	if !errors.As(err, &done) {
		return fmt.Errorf("读取 reset index 失败：%w", err)
	}
	leaderAddr, err := c.Leader(ctx)
	if err != nil {
		return err
	}
	members, err := db.ListClusterNodes(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return err
	}
	var leader *db.ClusterNode
	for _, m := range servers(members) {
		if strings.HasPrefix(leaderAddr, m.AdvertiseAddr+":") || strings.HasPrefix(leaderAddr, "["+m.AdvertiseAddr+"]:") {
			leader = m
		}
	}
	if leader == nil {
		return fmt.Errorf("Leader %s 不是已登记的成员", leaderAddr)
	}
	nc, err := s.remote().Open(ctx, t, leader.NodeID, "写入 ACL Bootstrap 重置文件")
	if err != nil {
		return err
	}
	err = func() error {
		path := DataDir + "/server/acl-bootstrap-reset"
		if err := sshx.PutFile(ctx, nc.SSH, path, []byte(strconv.FormatUint(done.ResetIndex, 10)), "0600",
			RunUser(leader.Role)+":"+RunUser(leader.Role), "0700"); err != nil {
			return err
		}
		nc.Step.Logf("已在 Leader %s 写入 reset index %d", leader.NodeName, done.ResetIndex)
		return s.confirmBootstrap(ctx, cl, secret, nc.Step.Logf)
	}()
	nc.Done(ctx, err)
	return err
}
