// Package migration exports and imports passphrase-encrypted control-plane
// bundles (.ndbundle). The same format serves environment migration and
// scheduled disaster-recovery backups.
//
// A bundle holds table rows as JSON lines. Values encrypted with the
// source instance's master key are decrypted on export (the bundle itself
// is encrypted with Argon2id + AES-256-GCM) and re-encrypted with the
// target instance's master key on import.
package migration

import "strings"

// Core tables are always exported, in dependency order.
var CoreTables = []string{
	"system_settings", "ssh_keys", "nodes", "clusters", "cluster_nodes", "vault_secrets_custody",
	"vault_unseal_key_generations", "cluster_integrations", "integration_roles", "job_templates", "cron_jobs",
}

// OptionalTables may be included; operation_tasks brings its steps and
// step log files along.
var OptionalTables = []string{"admins", "job_revisions", "audit_logs", "operation_tasks", "cron_job_runs"}

// companion tables exported together with an optional table.
var companions = map[string][]string{"operation_tasks": {"operation_task_steps"}}

// mergeOrder lists the tables a merge import writes, in dependency order.
var mergeOrder = []string{
	"ssh_keys", "nodes", "clusters", "cluster_nodes", "vault_secrets_custody", "vault_unseal_key_generations",
	"cluster_integrations", "integration_roles", "job_templates", "cron_jobs",
}

// insertOrder is the dependency order of every exportable table.
var insertOrder = []string{
	"admins", "system_settings", "ssh_keys", "nodes", "clusters", "cluster_nodes", "vault_secrets_custody",
	"vault_unseal_key_generations", "cluster_integrations", "integration_roles", "job_templates", "job_revisions",
	"cron_jobs", "cron_job_runs", "operation_tasks", "operation_task_steps", "audit_logs",
}

// localSetting reports settings that belong to the instance and are never
// exported or imported.
func localSetting(key string) bool {
	switch {
	case key == "control_plane.activated", strings.HasPrefix(key, "self_update."), strings.HasPrefix(key, "server."),
		strings.HasPrefix(key, "master_key."):
		return true
	}
	return false
}

// uniqueNames lists tables whose name column is unique; merge imports
// rename clashing rows instead of failing (clusters excepted: a clash
// blocks the merge).
var uniqueNames = map[string]bool{"ssh_keys": true, "nodes": true, "cluster_integrations": true, "job_templates": true}

// jsonRefs lists references embedded in JSON columns that a merge rewrites.
var jsonRefs = map[string]map[string]map[string]string{
	"cron_jobs": {"payload_json": {"cluster_id": "clusters", "node_id": "nodes", "integration_id": "cluster_integrations"}},
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
