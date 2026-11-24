package vault

import cl "nomad-deck/internal/cluster"

// Shared driver types.
type (
	PreflightIssue  = cl.PreflightIssue
	MemberInput     = cl.MemberInput
	DeployInput     = cl.DeployInput
	JoinInput       = cl.JoinInput
	UpgradeInput    = cl.UpgradeInput
	UpgradePlan     = cl.UpgradePlan
	GateResult      = cl.GateResult
	ReconcileStep   = cl.ReconcileStep
	ReconcileReport = cl.ReconcileReport
	UninstallPlan   = cl.UninstallPlan
	Check           = cl.Check
	DoctorReport    = cl.DoctorReport
	RestoreInput    = cl.RestoreInput
)
