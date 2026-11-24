package nomad

import (
	"context"

	"nomad-deck/internal/cluster"
)

// driver adapts the Nomad service to the generic cluster driver contract.
type driver struct{ *Service }

// Driver returns the Nomad cluster driver.
func (s *Service) Driver() cluster.Driver { return driver{s} }

func (d driver) Status(ctx context.Context, clusterID string) (any, error) {
	rep, err := d.StatusDetail(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	return rep, nil
}
