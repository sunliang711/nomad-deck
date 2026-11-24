package nomad

import (
	"context"
	"io"

	"nomad-deck/internal/audit"
	"nomad-deck/internal/auth"
	"nomad-deck/internal/cluster"
	"nomad-deck/internal/db"
)

// Lifecycle operations that are not available for Nomad clusters yet.

var errPending = &auth.Error{Status: 501, Code: "not_implemented", Message: "Nomad 集群暂不支持该操作"}

func (driver) NodeJoin(context.Context, audit.Actor, string, string, cluster.JoinInput) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) NodeRemove(context.Context, audit.Actor, string, string) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) NodeService(context.Context, audit.Actor, string, string, string, bool) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) RollbackGeneration(context.Context, audit.Actor, string, string, bool) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) CheckGate(context.Context, string, string) (*cluster.GateResult, error) {
	return nil, errPending
}
func (driver) PlanUpgrade(context.Context, string, string) (*cluster.UpgradePlan, error) {
	return nil, errPending
}
func (driver) Upgrade(context.Context, audit.Actor, string, cluster.UpgradeInput) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) RenewCerts(context.Context, audit.Actor, string, bool) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) RotateCA(context.Context, audit.Actor, string, bool) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) Reconcile(context.Context, audit.Actor, string) (*cluster.ReconcileReport, error) {
	return nil, errPending
}
func (driver) SetMaintenance(context.Context, audit.Actor, string, bool) error { return errPending }
func (driver) Doctor(context.Context, string) (*cluster.DoctorReport, error)   { return nil, errPending }
func (driver) PlanUninstall(context.Context, string) (*cluster.UninstallPlan, error) {
	return nil, errPending
}
func (driver) Uninstall(context.Context, audit.Actor, string, string) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) CreateSnapshot(context.Context, audit.Actor, string) (*db.OperationTask, error) {
	return nil, errPending
}
func (driver) ListSnapshots(context.Context, string) (any, error) { return nil, errPending }
func (driver) DeleteSnapshot(context.Context, audit.Actor, string, string) error {
	return errPending
}
func (driver) WriteArchive(context.Context, audit.Actor, string, string, string, io.Writer) error {
	return errPending
}
func (driver) ImportArchive(context.Context, audit.Actor, string, io.ReadCloser, string) (*db.Snapshot, error) {
	return nil, errPending
}
func (driver) Restore(context.Context, audit.Actor, string, string, cluster.RestoreInput) (*db.OperationTask, error) {
	return nil, errPending
}
