package release

import "testing"

func TestCheckUpgrade(t *testing.T) {
	saved := UpgradeNotices
	defer func() { UpgradeNotices = saved }()
	UpgradeNotices = []UpgradeNotice{{Product: "vault", Version: "1.16", Note: "a"}, {Product: "vault", Version: "1.17", Note: "b"},
		{Product: "nomad", Version: "1.16", Note: "other product"}}
	cases := []struct {
		from, to string
		allowed  bool
		confirm  bool
		notices  int
	}{
		{"1.15.2", "1.15.4", true, false, 0},
		{"1.15.2", "1.16.0", true, true, 1},
		{"1.17.1", "1.18.3", true, false, 0},
		{"1.15.0", "1.18.0", true, true, 2}, // skip 3 > 2 and crosses 1.16, 1.17
		{"1.16.0", "1.15.9", false, false, 0},
		{"1.16.0", "2.0.0", false, false, 0},
		{"1.16.0", "1.16.0", false, false, 0},
	}
	for _, c := range cases {
		r := CheckUpgrade("vault", c.from, c.to, 2)
		if r.Allowed != c.allowed || r.NeedsConfirmation != c.confirm || len(r.Notices) != c.notices {
			t.Errorf("%s -> %s: %+v", c.from, c.to, r)
		}
	}
}
