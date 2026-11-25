// Package cluster defines the product-neutral cluster driver contract.
// Nomad and Vault each register a driver; a future Consul driver plugs in
// by implementing the same interface, without changing the HTTP layer or
// the data model.
package cluster

import (
	"context"
	"io"
	"time"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/db"
	"nomad-deck/internal/release"
)

// PreflightIssue is one problem found before changing hosts.
type PreflightIssue struct {
	NodeID   string `json:"node_id"`
	Node     string `json:"node"`
	Severity string `json:"severity"` // block | confirm | warn
	Message  string `json:"message"`
}

// MemberInput adds a host to a cluster.
type MemberInput struct {
	NodeID        string `json:"node_id"`
	AdvertiseAddr string `json:"advertise_addr"`
	// Role is the Nomad role (server, client, server_client); Vault
	// members are always Raft nodes and ignore it.
	Role string `json:"role,omitempty"`
}

// DeployInput starts a deployment.
type DeployInput struct {
	Version     string `json:"version"`
	UseProxy    *bool  `json:"use_proxy"`
	ConfirmSwap bool   `json:"confirm_swap"`
}

// JoinInput adds a node to a running cluster.
type JoinInput struct {
	AdvertiseAddr string `json:"advertise_addr"`
	Role          string `json:"role,omitempty"`
	UseProxy      *bool  `json:"use_proxy"`
	ConfirmSwap   bool   `json:"confirm_swap"`
}

// UpgradeInput starts a rolling upgrade.
type UpgradeInput struct {
	Version       string `json:"version"`
	UseProxy      *bool  `json:"use_proxy"`
	Confirm       bool   `json:"confirm"`
	ConfirmSingle bool   `json:"confirm_single_node"`
	// DrainClients drains each Nomad client before upgrading it.
	DrainClients bool `json:"drain_clients,omitempty"`
	// ClientBatch is how many Nomad clients are upgraded at a time.
	ClientBatch int `json:"client_batch,omitempty"`
}

// UpgradePlan is the dry-run preview of a rolling upgrade.
type UpgradePlan struct {
	Check   release.UpgradeCheck `json:"check"`
	Order   []string             `json:"order"`
	Current string               `json:"current_version"`
	Target  string               `json:"target_version"`
}

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

// ReconcileStep is the observed state of one remote step.
type ReconcileStep struct {
	TaskID string `json:"task_id"`
	Action string `json:"action"`
	Node   string `json:"node"`
	Unit   string `json:"unit"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// ReconcileReport is the outcome of a reconciliation.
type ReconcileReport struct {
	Steps    []ReconcileStep `json:"steps"`
	Resolved bool            `json:"resolved"`
	Message  string          `json:"message"`
}

// UninstallPlan lists what an uninstall removes.
type UninstallPlan struct {
	Nodes     []string `json:"nodes"`
	Snapshots int      `json:"snapshots"`
	Warnings  []string `json:"warnings"`
}

// Check is one Doctor finding.
type Check struct {
	Node    string `json:"node,omitempty"`
	Name    string `json:"name"`
	Status  string `json:"status"` // OK | WARN | FAIL
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

// DoctorReport is a structured health check of a cluster.
type DoctorReport struct {
	Cluster string    `json:"cluster"`
	RanAt   time.Time `json:"ran_at"`
	Summary string    `json:"summary"`
	Checks  []Check   `json:"checks"`
}

// RestoreInput starts a snapshot restore.
type RestoreInput struct {
	Force        bool   `json:"force"`
	ResumeTaskID string `json:"resume_task_id"`
}

// Driver is implemented by every managed product. Product-specific
// capabilities (Vault custody, Nomad governance) live on the concrete
// services; everything a generic cluster page needs is here.
type Driver interface {
	// Lifecycle of the cluster record and its members.
	AddMembers(ctx context.Context, actor audit.Actor, clusterID string, in []MemberInput) error
	DeleteUndeployed(ctx context.Context, actor audit.Actor, clusterID string) error
	Preflight(ctx context.Context, clusterID string, confirmSwap bool) ([]PreflightIssue, error)
	Deploy(ctx context.Context, actor audit.Actor, clusterID string, in DeployInput) (*db.OperationTask, error)
	PlanUninstall(ctx context.Context, clusterID string) (*UninstallPlan, error)
	Uninstall(ctx context.Context, actor audit.Actor, clusterID, confirmName string) (*db.OperationTask, error)

	// Membership changes and single-node actions.
	NodeJoin(ctx context.Context, actor audit.Actor, clusterID, nodeID string, in JoinInput) (*db.OperationTask, error)
	NodeRemove(ctx context.Context, actor audit.Actor, clusterID, nodeID string) (*db.OperationTask, error)
	NodeService(ctx context.Context, actor audit.Actor, clusterID, nodeID, action string, confirmSingle bool) (*db.OperationTask, error)
	RollbackGeneration(ctx context.Context, actor audit.Actor, clusterID, nodeID string, confirmSingle bool) (*db.OperationTask, error)
	CheckGate(ctx context.Context, clusterID, nodeID string) (*GateResult, error)

	// Upgrades and certificates.
	PlanUpgrade(ctx context.Context, clusterID, version string) (*UpgradePlan, error)
	Upgrade(ctx context.Context, actor audit.Actor, clusterID string, in UpgradeInput) (*db.OperationTask, error)
	RenewCerts(ctx context.Context, actor audit.Actor, clusterID string, confirmSingle bool) (*db.OperationTask, error)
	RotateCA(ctx context.Context, actor audit.Actor, clusterID string, confirmSingle bool) (*db.OperationTask, error)

	// Operations state.
	Reconcile(ctx context.Context, actor audit.Actor, clusterID string) (*ReconcileReport, error)
	SetMaintenance(ctx context.Context, actor audit.Actor, clusterID string, on bool) error
	Doctor(ctx context.Context, clusterID string) (*DoctorReport, error)
	Status(ctx context.Context, clusterID string) (any, error)

	// Raft snapshots.
	CreateSnapshot(ctx context.Context, actor audit.Actor, clusterID string) (*db.OperationTask, error)
	// TakeSnapshot exports and stores a snapshot synchronously; the caller
	// holds the shared cluster lock.
	TakeSnapshot(ctx context.Context, clusterID, trigger, by string) (*db.Snapshot, error)
	ListSnapshots(ctx context.Context, clusterID string) (any, error)
	DeleteSnapshot(ctx context.Context, actor audit.Actor, clusterID, snapID string) error
	WriteArchive(ctx context.Context, actor audit.Actor, clusterID, snapID, passphrase string, w io.Writer) error
	ImportArchive(ctx context.Context, actor audit.Actor, clusterID string, src io.ReadCloser, passphrase string) (*db.Snapshot, error)
	Restore(ctx context.Context, actor audit.Actor, clusterID, snapID string, in RestoreInput) (*db.OperationTask, error)
}
