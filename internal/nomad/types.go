package nomad

import "nomad-deck/internal/cluster"

// Shared driver types.
type (
	PreflightIssue  = cluster.PreflightIssue
	MemberInput     = cluster.MemberInput
	DeployInput     = cluster.DeployInput
	JoinInput       = cluster.JoinInput
	UpgradeInput    = cluster.UpgradeInput
	UpgradePlan     = cluster.UpgradePlan
	GateResult      = cluster.GateResult
	ReconcileReport = cluster.ReconcileReport
	UninstallPlan   = cluster.UninstallPlan
	Check           = cluster.Check
	DoctorReport    = cluster.DoctorReport
	RestoreInput    = cluster.RestoreInput
)
