package db

import (
	"fmt"
	"strconv"
)

// SecretColumn describes where master-key ciphertext lives in a table row
// and which additional data binds it to that row. Migration bundles use it
// to decrypt on export and re-encrypt on import; every EncryptedFields
// entry has a matching SecretColumn (enforced by tests).
type SecretColumn struct {
	Field  string // EncryptedFields name
	Table  string
	Column string
	// JSONPath locates the ciphertext inside a JSON column (nil = the
	// column itself).
	JSONPath []string
	// Applies filters rows holding ciphertext (nil = every non-empty value).
	Applies func(row map[string]any) bool
	AAD     func(row map[string]any) string
}

// RowString returns a row value as text.
func RowString(row map[string]any, key string) string {
	switch v := row[key].(type) {
	case nil:
		return ""
	case string:
		return v
	case []byte:
		return string(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case fmt.Stringer:
		return v.String()
	default:
		return fmt.Sprint(v)
	}
}

func byID(f func(string) string) func(map[string]any) string {
	return func(r map[string]any) string { return f(RowString(r, "id")) }
}

// SettingAAD is the additional data of an encrypted system setting.
func SettingAAD(key string) string { return "system_settings:" + key }

// NodePullProxyAAD binds a host's Docker pull proxy password.
func NodePullProxyAAD(nodeID string) string { return "nodes.docker_config_json.pull_proxy:" + nodeID }

// ClusterPullProxyAAD binds a cluster's default Docker pull proxy password.
func ClusterPullProxyAAD(clusterID string) string {
	return "clusters.config_json.docker_defaults.pull_proxy:" + clusterID
}

// SecretColumns lists every encrypted location by table.
var SecretColumns = []SecretColumn{
	{Field: "system_settings.value", Table: "system_settings", Column: "value",
		Applies: func(r map[string]any) bool { return RowString(r, "is_secret") == "1" },
		AAD:     func(r map[string]any) string { return SettingAAD(RowString(r, "key")) }},
	{Field: "ssh_keys.private_key_encrypted", Table: "ssh_keys", Column: "private_key_encrypted", AAD: byID(SSHKeyAAD)},
	{Field: "clusters.ca_key_encrypted", Table: "clusters", Column: "ca_key_encrypted", AAD: byID(ClusterCAKeyAAD)},
	{Field: "clusters.client_key_encrypted", Table: "clusters", Column: "client_key_encrypted", AAD: byID(ClusterClientKeyAAD)},
	{Field: "clusters.gossip_key_encrypted", Table: "clusters", Column: "gossip_key_encrypted", AAD: byID(ClusterGossipKeyAAD)},
	{Field: "clusters.gossip_key_pending_encrypted", Table: "clusters", Column: "gossip_key_pending_encrypted", AAD: byID(ClusterGossipPendingAAD)},
	{Field: "clusters.admin_token_encrypted", Table: "clusters", Column: "admin_token_encrypted", AAD: byID(ClusterAdminTokenAAD)},
	{Field: "clusters.config_json.docker_defaults.pull_proxy.password_encrypted", Table: "clusters", Column: "config_json",
		JSONPath: []string{"docker_defaults", "pull_proxy", "password_encrypted"}, AAD: byID(ClusterPullProxyAAD)},
	{Field: "nodes.docker_config_json.pull_proxy.password_encrypted", Table: "nodes", Column: "docker_config_json",
		JSONPath: []string{"pull_proxy", "password_encrypted"}, AAD: byID(NodePullProxyAAD)},
	{Field: "vault_secrets_custody.bootstrap_root_token_encrypted", Table: "vault_secrets_custody", Column: "bootstrap_root_token_encrypted",
		AAD: func(r map[string]any) string { return VaultRootTokenAAD(RowString(r, "cluster_id")) }},
	{Field: "vault_secrets_custody.admin_token_encrypted", Table: "vault_secrets_custody", Column: "admin_token_encrypted",
		AAD: func(r map[string]any) string { return VaultAdminTokenAAD(RowString(r, "cluster_id")) }},
	{Field: "vault_unseal_key_generations.unseal_keys_encrypted", Table: "vault_unseal_key_generations", Column: "unseal_keys_encrypted",
		AAD: func(r map[string]any) string {
			gen, _ := strconv.Atoi(RowString(r, "generation"))
			return VaultUnsealKeysAAD(RowString(r, "cluster_id"), gen)
		}},
	{Field: "job_revisions.variables_encrypted", Table: "job_revisions", Column: "variables_encrypted", AAD: byID(JobVariablesAAD)},
	{Field: "job_revisions.job_json_encrypted", Table: "job_revisions", Column: "job_json_encrypted", AAD: byID(JobJSONAAD)},
}

// SecretsOf returns the secret columns of a table.
func SecretsOf(table string) []SecretColumn {
	var out []SecretColumn
	for _, c := range SecretColumns {
		if c.Table == table {
			out = append(out, c)
		}
	}
	return out
}
