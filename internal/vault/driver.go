package vault

import (
	"context"

	cl "nomad-deck/internal/cluster"
)

// driver adapts the Vault service to the generic cluster driver contract.
type driver struct{ *Service }

// Driver returns the Vault cluster driver.
func (s *Service) Driver() cl.Driver { return driver{s} }

func (d driver) Status(ctx context.Context, clusterID string) (any, error) {
	rep, err := d.StatusDetail(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	return rep, nil
}

func (d driver) ListSnapshots(ctx context.Context, clusterID string) (any, error) {
	snaps, err := d.Service.ListSnapshots(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	if snaps == nil {
		snaps = []SnapshotView{}
	}
	return snaps, nil
}
