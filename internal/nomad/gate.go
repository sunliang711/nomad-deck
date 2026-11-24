package nomad

import (
	"context"
	"fmt"
	"net"
	"strconv"

	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
)

// raftServerOf finds the Raft entry of a server member (by RPC address or
// by "<node name>.<region>").
func raftServerOf(cl *nomadCluster, m *db.ClusterNode, raft []RaftServer) (RaftServer, bool) {
	want := net.JoinHostPort(m.AdvertiseAddr, strconv.Itoa(cl.Settings.RPCPort))
	name := memberConfig(m).NodeName
	for _, sv := range raft {
		if sv.Address == want || sv.Node == name+"."+cl.Region || sv.Node == name {
			return sv, true
		}
	}
	return RaftServer{}, false
}

// gate evaluates whether target may go down: a healthy voter needs a
// failure tolerance of at least one; an unhealthy voter needs the other
// healthy voters to form a majority; non-voters and clients pass. A
// single-server cluster needs explicit confirmation.
func (s *Service) gate(ctx context.Context, api *Client, cl *nomadCluster, target *db.ClusterNode, confirmSingle bool) (*cluster.GateResult, error) {
	r := &cluster.GateResult{Target: target.NodeName}
	if !IsServer(target.Role) {
		r.Allowed, r.Reason = true, "目标节点不是 Server，不影响 Raft 仲裁"
		return r, nil
	}
	ap, err := api.Autopilot(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取 Autopilot 健康状态失败：%w", err)
	}
	raft, err := api.RaftConfiguration(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取 Raft 成员失败：%w", err)
	}
	sv, inConfig := raftServerOf(cl, target, raft)
	r.TargetVoter = inConfig && sv.Voter
	voters := map[string]bool{}
	for _, x := range raft {
		if x.Voter {
			voters[x.ID] = true
		}
	}
	r.Voters = len(voters)
	healthy := map[string]bool{}
	for _, h := range ap.Servers {
		if h.Healthy && voters[h.ID] {
			healthy[h.ID] = true
		}
	}
	r.HealthyVoters = len(healthy)
	r.TargetHealthy = inConfig && healthy[sv.ID]
	// Autopilot's tolerance can lag behind the Raft configuration (e.g.
	// right after dead-server cleanup), so the stricter of the reported and
	// the computed tolerance applies.
	quorum := r.Voters/2 + 1
	r.FailureTolerance = r.HealthyVoters - quorum
	if ap.FailureTolerance < r.FailureTolerance {
		r.FailureTolerance = ap.FailureTolerance
	}
	if r.FailureTolerance < 0 {
		r.FailureTolerance = 0
	}
	switch {
	case len(raft) <= 1:
		r.SingleNode, r.Allowed = true, confirmSingle
		if confirmSingle {
			r.Reason = "单 Server 集群，管理员已确认维护窗口"
		} else {
			r.Reason = "单 Server 集群停服会中断调度与 API，需管理员显式确认"
		}
	case !r.TargetVoter:
		r.Allowed, r.Reason = true, "目标节点不是 Raft 投票成员"
	case r.TargetHealthy:
		r.Allowed = r.FailureTolerance >= 1
		if r.Allowed {
			r.Reason = fmt.Sprintf("当前可容忍 %d 台故障", r.FailureTolerance)
		} else {
			r.Reason = "当前容错数为 0，目标节点下线将失去多数派"
		}
	default:
		r.Allowed = r.HealthyVoters >= quorum
		if r.Allowed {
			r.Reason = fmt.Sprintf("目标节点已不健康，其余 %d/%d 台健康投票成员仍构成多数派", r.HealthyVoters, r.Voters)
		} else {
			r.Reason = fmt.Sprintf("其余健康投票成员 %d/%d 台不足多数派", r.HealthyVoters, r.Voters)
		}
	}
	return r, nil
}

// CheckGate evaluates the quorum gate for one member (preview for the UI).
func (s *Service) CheckGate(ctx context.Context, clusterID, nodeID string) (*cluster.GateResult, error) {
	cl, err := s.loadCluster(ctx, s.DB.Reader, clusterID)
	if err != nil {
		return nil, err
	}
	m, err := db.GetClusterNode(ctx, s.DB.Reader, clusterID, nodeID)
	if err != nil {
		return nil, badRequest("主机不是该集群的成员")
	}
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return nil, err
	}
	return s.gate(ctx, api, cl, m, false)
}

// gateFor checks the quorum gate for a member about to go down.
func (s *Service) gateFor(ctx context.Context, cl *nomadCluster, m *db.ClusterNode, confirmSingle bool, log func(string, ...any)) error {
	if !IsServer(m.Role) {
		return nil
	}
	api, _, err := s.apiClient(ctx, cl, "")
	if err != nil {
		return err
	}
	r, err := s.gate(ctx, api, cl, m, confirmSingle)
	if err != nil {
		return err
	}
	log("仲裁门禁：%s", r.Reason)
	if !r.Allowed {
		return conflict("quorum_gate", "Raft 仲裁门禁拒绝对 %s 的操作：%s", r.Target, r.Reason)
	}
	return nil
}
