package selfupdate

import (
	"fmt"
	"strconv"
	"strings"
)

// Semver represents a parsed semantic version (vMAJOR.MINOR.PATCH[-pre]).
type Semver struct {
	Major int
	Minor int
	Patch int
	Pre   string
}

// ParseSemver parses "[v]MAJOR.MINOR.PATCH[-prerelease]".
func ParseSemver(s string) (Semver, error) {
	raw := strings.TrimSpace(s)
	raw = strings.TrimPrefix(raw, "v")
	if raw == "" || raw == "dev" {
		return Semver{}, fmt.Errorf("invalid semver %q", s)
	}
	if i := strings.IndexByte(raw, '+'); i >= 0 {
		raw = raw[:i]
	}
	core, pre, _ := strings.Cut(raw, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Semver{}, fmt.Errorf("invalid semver %q", s)
	}
	nums := make([]int, 3)
	for i, p := range parts {
		if p == "" || !isDigits(p) {
			return Semver{}, fmt.Errorf("invalid semver %q", s)
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return Semver{}, fmt.Errorf("invalid semver %q", s)
		}
		nums[i] = n
	}
	return Semver{Major: nums[0], Minor: nums[1], Patch: nums[2], Pre: pre}, nil
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// String formats v with a leading "v".
func (v Semver) String() string {
	if v.Pre != "" {
		return fmt.Sprintf("v%d.%d.%d-%s", v.Major, v.Minor, v.Patch, v.Pre)
	}
	return fmt.Sprintf("v%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// Compare compares v with other (-1, 0, +1).
func (v Semver) Compare(other Semver) int {
	for _, pair := range [][2]int{{v.Major, other.Major}, {v.Minor, other.Minor}, {v.Patch, other.Patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if v.Pre == other.Pre {
		return 0
	}
	if v.Pre == "" {
		return 1
	}
	if other.Pre == "" {
		return -1
	}
	return comparePre(v.Pre, other.Pre)
}

func comparePre(a, b string) int {
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	n := len(pa)
	if len(pb) < n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		if pa[i] == pb[i] {
			continue
		}
		aNum := pa[i] != "" && isDigits(pa[i])
		bNum := pb[i] != "" && isDigits(pb[i])
		switch {
		case aNum && bNum:
			na, ea := strconv.Atoi(pa[i])
			nb, eb := strconv.Atoi(pb[i])
			if ea == nil && eb == nil {
				if na < nb {
					return -1
				}
				if na > nb {
					return 1
				}
			}
			if len(pa[i]) != len(pb[i]) {
				if len(pa[i]) < len(pb[i]) {
					return -1
				}
				return 1
			}
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		case aNum:
			return -1
		case bNum:
			return 1
		default:
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	if len(pa) < len(pb) {
		return -1
	}
	if len(pa) > len(pb) {
		return 1
	}
	return 0
}

// CompareSemver parses a and b and returns -1, 0, or +1.
func CompareSemver(a, b string) (int, error) {
	va, err := ParseSemver(a)
	if err != nil {
		return 0, err
	}
	vb, err := ParseSemver(b)
	if err != nil {
		return 0, err
	}
	return va.Compare(vb), nil
}

// NormalizeTag returns "vMAJOR.MINOR.PATCH[-pre]" for valid semvers.
func NormalizeTag(s string) string {
	v, err := ParseSemver(s)
	if err != nil {
		return strings.TrimSpace(s)
	}
	return v.String()
}
