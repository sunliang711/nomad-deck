package release

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"

	"nomad-deck/internal/db"
)

// Provider builds release sources from the current system settings
// (mirror URL, rotated signing key, registered CNI digests) while sharing
// download locks and the artifact cache.
type Provider struct {
	DB       *db.DB
	CacheDir string

	once sync.Once
	hc   *HashiCorp
	cni  *CNI
	dk   *Docker
}

func (p *Provider) init() {
	p.once.Do(func() {
		p.hc = &HashiCorp{CacheDir: filepath.Join(p.CacheDir, "hashicorp")}
		p.cni = &CNI{CacheDir: p.CacheDir}
		p.dk = &Docker{CacheDir: p.CacheDir}
	})
}

func (p *Provider) str(ctx context.Context, key string) string {
	var v string
	if raw, _, err := db.GetSetting(ctx, p.DB.Reader, key); err == nil {
		_ = json.Unmarshal([]byte(raw), &v)
	}
	return v
}

// HashiCorp returns the HashiCorp source configured from settings.
func (p *Provider) HashiCorp(ctx context.Context) *HashiCorp {
	p.init()
	return &HashiCorp{BaseURL: p.str(ctx, "release.mirror_url"), ArmoredKey: p.str(ctx, "release.pgp_public_key"),
		CacheDir: p.hc.CacheDir}
}

// CNI returns the CNI source including admin-registered digests.
func (p *Provider) CNI(ctx context.Context) *CNI {
	p.init()
	var extra CNIChecksums
	if raw, _, err := db.GetSetting(ctx, p.DB.Reader, "release.cni_checksums"); err == nil {
		_ = json.Unmarshal([]byte(raw), &extra)
	}
	return &CNI{CacheDir: p.cni.CacheDir, Extra: extra}
}

// Docker returns the Docker repository source with the configured signing keys.
func (p *Provider) Docker(ctx context.Context) *Docker {
	p.init()
	return &Docker{CacheDir: p.dk.CacheDir, ArmoredKeys: p.str(ctx, "release.docker_pgp_public_key")}
}
