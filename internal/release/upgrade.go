package release

import (
	"fmt"
	"strconv"
	"strings"
)

// UpgradeNotice is a version whose upgrade guide has breaking changes or
// special steps; upgrade paths crossing it need explicit acknowledgement.
type UpgradeNotice struct {
	Product string `json:"product"`
	Version string `json:"version"` // MAJOR.MINOR
	Note    string `json:"note"`
}

// UpgradeNotices is the list shipped with this NomadDeck release. Entries
// are curated at release time from the official upgrade guides; only
// versions with breaking changes or special upgrade steps are listed.
var UpgradeNotices = []UpgradeNotice{
	{Product: "nomad", Version: "1.10", Note: "Nomad 1.10 移除了基于 Token 的旧版 Vault 集成方式，只支持 Workload Identity"},
}

// UpgradeCheck is the outcome of the version span rules.
type UpgradeCheck struct {
	From              string          `json:"from"`
	To                string          `json:"to"`
	Allowed           bool            `json:"allowed"`
	Reason            string          `json:"reason,omitempty"`
	MinorSkip         int             `json:"minor_skip"`
	NeedsConfirmation bool            `json:"needs_confirmation"`
	Notices           []UpgradeNotice `json:"notices"`
}

func parseVer(v string) (major, minor, patch int, err error) {
	parts := strings.Split(strings.SplitN(v, "+", 2)[0], ".")
	if len(parts) != 3 {
		return 0, 0, 0, fmt.Errorf("invalid version %q", v)
	}
	nums := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid version %q", v)
		}
		nums[i] = n
	}
	return nums[0], nums[1], nums[2], nil
}

// CheckUpgrade applies the shared Nomad/Vault version span rules: no
// downgrade, no major version change, more than maxMinorSkip minor versions
// needs confirmation, and paths crossing a notice version need confirmation.
func CheckUpgrade(product, from, to string, maxMinorSkip int) UpgradeCheck {
	r := UpgradeCheck{From: from, To: to, Notices: []UpgradeNotice{}}
	fM, fm, _, err1 := parseVer(from)
	tM, tm, _, err2 := parseVer(to)
	switch {
	case err1 != nil || err2 != nil:
		r.Reason = "版本号格式无法识别"
		return r
	case CompareVersions(to, from) < 0:
		r.Reason = "禁止降级"
		return r
	case CompareVersions(to, from) == 0:
		r.Reason = "目标版本与当前版本相同"
		return r
	case tM != fM:
		r.Reason = "禁止跨主版本升级"
		return r
	}
	r.Allowed = true
	r.MinorSkip = tm - fm
	if r.MinorSkip > maxMinorSkip {
		r.NeedsConfirmation = true
	}
	for _, n := range UpgradeNotices {
		if n.Product != product {
			continue
		}
		nM, nm, _, err := parseVer(n.Version + ".0")
		if err != nil || nM != fM {
			continue
		}
		if nm > fm && nm <= tm {
			r.Notices = append(r.Notices, n)
			r.NeedsConfirmation = true
		}
	}
	return r
}
