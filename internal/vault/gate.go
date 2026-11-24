package vault

import (
	"context"
	"fmt"

	"nomad-deck/internal/db"
)

// GateResult is the outcome of the Raft quorum gate for one node.
type GateResult struct {
	Allowed          bool   `json:"allowed"`
	Reason           string `json:"reason"`
	Target           string `json:"target"`
	TargetHealthy    bool   `json:"target_healthy"`
	TargetVoter      bool   `json:"target_voter"`
	Voters           int    `json:"voters"`
	HealthyVoters    int    `json:"healthy_voters"`
	FailureTolerance int    `json:"failure_tolerance"`
	SingleNode       bool   `json:"single_node"`
}

// gate evaluates whether target may go down: a healthy voter needs a
// failure tolerance of at least one; an unhealthy target needs the other
// healthy voters to form a majority. A single-node cluster needs explicit
// confirmation.
func (s *Service) gate(ctx context.Context, admin *Client, target *db.ClusterNode, confirmSingle bool) (*GateResult, error) {
	ap, err := admin.AutopilotState(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取 Autopilot 状态失败：%w", err)
	}
	cfg, err := admin.RaftConfiguration(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取 Raft 成员失败：%w", err)
	}
	id := memberConfig(target).RaftNodeID
	r := &GateResult{Target: target.NodeName, FailureTolerance: ap.FailureTolerance}
	inConfig := false
	for _, sv := range cfg {
		if sv.Voter {
			r.Voters++
		}
		if sv.NodeID == id {
			inConfig = true
			r.TargetVoter = sv.Voter
		}
	}
	for sid, sv := range ap.Servers {
		voter := sv.Status == "voter" || sv.Status == "leader"
		if sv.Healthy && voter {
			r.HealthyVoters++
		}
		if sid == id {
			r.TargetHealthy = sv.Healthy
		}
	}
	switch {
	case len(cfg) <= 1:
		r.SingleNode = true
		r.Allowed = confirmSingle
		if !confirmSingle {
			r.Reason = "单节点集群停服会中断服务，需管理员显式确认"
		} else {
			r.Reason = "单节点集群，管理员已确认维护窗口"
		}
	case !inConfig || !r.TargetVoter:
		r.Allowed, r.Reason = true, "目标节点不是 Raft 投票成员"
	case r.TargetHealthy:
		r.Allowed = ap.FailureTolerance >= 1
		if r.Allowed {
			r.Reason = fmt.Sprintf("当前可容忍 %d 台故障", ap.FailureTolerance)
		} else {
			r.Reason = "当前容错数为 0，目标节点下线将失去多数派"
		}
	default:
		others := r.HealthyVoters
		r.Allowed = others > r.Voters/2
		if r.Allowed {
			r.Reason = fmt.Sprintf("目标节点已不健康，其余 %d/%d 台健康投票成员仍构成多数派", others, r.Voters)
		} else {
			r.Reason = fmt.Sprintf("其余健康投票成员 %d/%d 台不足多数派", others, r.Voters)
		}
	}
	return r, nil
}

// CheckGate evaluates the quorum gate for one member (preview for the UI).
func (s *Service) CheckGate(ctx context.Context, clusterID, nodeID string) (*GateResult, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	m, err := db.GetClusterNode(ctx, s.DB.Reader, clusterID, nodeID)
	if err != nil {
		return nil, badRequest("主机不是该集群的成员")
	}
	admin, _, err := s.adminClient(ctx, cl)
	if err != nil {
		return nil, err
	}
	return s.gate(ctx, admin, m, false)
}

func gateError(r *GateResult) error {
	return conflict("quorum_gate", "Raft 仲裁门禁拒绝对 %s 的操作：%s", r.Target, r.Reason)
}
