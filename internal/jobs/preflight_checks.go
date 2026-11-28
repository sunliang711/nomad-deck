package jobs

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// PreflightCheck is a single structured prerequisite/environment check item
// evaluated against the target Nomad cluster.
type PreflightCheck struct {
	ID        string              `json:"id"`
	Kind      string              `json:"kind"`
	Status    string              `json:"status"` // "ok", "error", "warning"
	Title     string              `json:"title"`
	TitleEn   string              `json:"title_en,omitempty"`
	Detail    string              `json:"detail"`
	DetailEn  string              `json:"detail_en,omitempty"`
	FixAction *PreflightFixAction `json:"fix_action,omitempty"`
}

// PreflightFixAction describes an in-place quick fix or direct navigation link
// for an unsatisfied prerequisite check.
type PreflightFixAction struct {
	Type    string `json:"type"` // "vault_role", "vault_kv", "link"
	Label   string `json:"label,omitempty"`
	LabelEn string `json:"label_en,omitempty"`

	// For Type == "link"
	Path string `json:"path,omitempty"`

	// For Type == "vault_role"
	IntegrationID   string   `json:"integration_id,omitempty"`
	IntegrationName string   `json:"integration_name,omitempty"`
	RoleID          string   `json:"role_id,omitempty"`
	RoleName        string   `json:"role_name,omitempty"`
	PolicyName      string   `json:"policy_name,omitempty"`
	TokenPeriod     string   `json:"token_period,omitempty"`
	Namespace       string   `json:"namespace,omitempty"`
	PolicyMode      string   `json:"policy_mode,omitempty"`
	SecretPaths     []string `json:"secret_paths,omitempty"`
	CustomPolicyHCL string   `json:"custom_policy_hcl,omitempty"`
	NeedsApplyOnly  bool     `json:"needs_apply_only,omitempty"`

	// For Type == "vault_kv"
	VaultClusterID string   `json:"vault_cluster_id,omitempty"`
	VaultCluster   string   `json:"vault_cluster,omitempty"`
	Mount          string   `json:"mount,omitempty"`
	SecretPath     string   `json:"secret_path,omitempty"`
	RequiredKeys   []string `json:"required_keys,omitempty"`
	OptionalKeys   []string `json:"optional_keys,omitempty"`
	ExistingKeys   []string `json:"existing_keys,omitempty"`
	MissingKeys    []string `json:"missing_keys,omitempty"`
}

var reVaultKVPathDefault = regexp.MustCompile(`VAULT_KV_PATH=\{\{\s*or\s+\.Data\.data\.[A-Za-z0-9_]+\s+"([^"]+)"`)

func detectVaultWritePaths(templates []any) []string {
	seen := map[string]bool{}
	var out []string
	for _, tplRaw := range templates {
		tpl := obj(tplRaw)
		if tpl == nil {
			continue
		}
		tmpl := str(tpl["EmbeddedTmpl"])
		if tmpl == "" {
			continue
		}
		for _, m := range reVaultKVPathDefault.FindAllStringSubmatch(tmpl, -1) {
			p := strings.Trim(strings.TrimSpace(m[1]), "/")
			if p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	sort.Strings(out)
	return out
}

func buildWriteRolePolicyHCL(readLogicalPaths []string, writeDataPaths []string) string {
	var blocks []string
	seenPath := map[string]bool{}
	mounts := map[string]bool{}

	for _, logical := range readLogicalPaths {
		logical = strings.Trim(logical, "/")
		mnt, sub, ok := strings.Cut(logical, "/")
		if !ok || mnt == "" || sub == "" {
			continue
		}
		mounts[mnt] = true
		dataPath := mnt + "/data/" + sub
		if !seenPath[dataPath] {
			seenPath[dataPath] = true
			blocks = append(blocks, fmt.Sprintf("path %q {\n  capabilities = [\"read\"]\n}", dataPath))
		}
	}

	if len(writeDataPaths) == 0 {
		writeDataPaths = []string{"secret/data/certs/tls"}
	}
	for _, wp := range writeDataPaths {
		wp = strings.Trim(wp, "/")
		if wp == "" {
			continue
		}
		mnt, rest, ok := strings.Cut(wp, "/")
		if ok && mnt != "" {
			mounts[mnt] = true
			if !strings.HasPrefix(rest, "data/") {
				wp = mnt + "/data/" + rest
			}
		}
		if !seenPath[wp] {
			seenPath[wp] = true
			blocks = append(blocks, fmt.Sprintf("path %q {\n  capabilities = [\"create\", \"update\", \"read\"]\n}", wp))
		}
	}

	// Add metadata read/list for touched mounts/prefixes.
	metaAdded := map[string]bool{}
	for p := range seenPath {
		mnt, rest, ok := strings.Cut(p, "/data/")
		if !ok {
			continue
		}
		prefix := rest
		if idx := strings.LastIndex(rest, "/"); idx > 0 {
			prefix = rest[:idx] + "/*"
		}
		mp := mnt + "/metadata/" + prefix
		if !metaAdded[mp] {
			metaAdded[mp] = true
			blocks = append(blocks, fmt.Sprintf("path %q {\n  capabilities = [\"read\", \"list\"]\n}", mp))
		}
	}
	if len(metaAdded) == 0 {
		for mnt := range mounts {
			blocks = append(blocks, fmt.Sprintf("path %q {\n  capabilities = [\"read\", \"list\"]\n}", mnt+"/metadata/*"))
		}
	}
	return strings.Join(blocks, "\n\n")
}

func mergeSortedUnique(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, item := range l {
			item = strings.TrimSpace(item)
			if item == "" || seen[item] {
				continue
			}
			seen[item] = true
			out = append(out, item)
		}
	}
	sort.Strings(out)
	return out
}

func mapKeysSorted(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, ok := range m {
		if ok && k != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}
