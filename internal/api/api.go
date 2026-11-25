package api

import (
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/backup"
	"nomad-deck/internal/cron"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/integration"
	"nomad-deck/internal/jobs"
	"nomad-deck/internal/migration"
	"nomad-deck/internal/netx"
	"nomad-deck/internal/nomad"
	"nomad-deck/internal/ops"
	"nomad-deck/internal/release"
	"nomad-deck/internal/rotation"
	"nomad-deck/internal/selfupdate"
	"nomad-deck/internal/vault"
	"nomad-deck/internal/version"
	"nomad-deck/internal/workbench"
)

// API holds handler dependencies.
type API struct {
	DB           *db.DB
	Auth         *auth.Service
	Hosts        *hosts.Service
	Proxy        *netx.Manager
	Ops          *ops.Engine
	Releases     *release.Provider
	Vault        *vault.Service
	Nomad        *nomad.Service
	Integrations *integration.Service
	Jobs         *jobs.Service
	Workbench    *workbench.Service
	Cron         *cron.Scheduler
	Migration    *migration.Service
	Backup       *backup.Service
	Rotation     *rotation.Service
	SelfUpdate   *selfupdate.Service
	UI           http.Handler
	// jobOpExtra serves job-ops added by other components (e.g. render).
	jobOpExtra     func(w http.ResponseWriter, r *http.Request) bool
	Log            *slog.Logger
	AllowedOrigins map[string]bool
	TrustedProxies []netip.Prefix
	HTTPS          bool // cookies and HSTS assume the browser uses HTTPS
	Ready          *atomic.Bool

	logStreamMu       sync.Mutex
	logStreamsGlobal  int
	logStreamsSession map[string]int
	logStreamsNode    map[string]int
}

func (a *API) acquireLogStream(sessionID, nodeID string) (func(), bool) {
	const (
		maxGlobalLogStreams  = 32
		maxSessionLogStreams = 4
		maxNodeLogStreams    = 4
	)
	a.logStreamMu.Lock()
	defer a.logStreamMu.Unlock()
	if a.logStreamsGlobal >= maxGlobalLogStreams {
		return nil, false
	}
	if a.logStreamsSession == nil {
		a.logStreamsSession = map[string]int{}
	}
	if a.logStreamsNode == nil {
		a.logStreamsNode = map[string]int{}
	}
	if a.logStreamsSession[sessionID] >= maxSessionLogStreams {
		return nil, false
	}
	if a.logStreamsNode[nodeID] >= maxNodeLogStreams {
		return nil, false
	}
	a.logStreamsGlobal++
	a.logStreamsSession[sessionID]++
	a.logStreamsNode[nodeID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			a.logStreamMu.Lock()
			defer a.logStreamMu.Unlock()
			a.logStreamsGlobal--
			if a.logStreamsSession[sessionID] <= 1 {
				delete(a.logStreamsSession, sessionID)
			} else {
				a.logStreamsSession[sessionID]--
			}
			if a.logStreamsNode[nodeID] <= 1 {
				delete(a.logStreamsNode, nodeID)
			} else {
				a.logStreamsNode[nodeID]--
			}
		})
	}, true
}

// Handler builds the HTTP handler tree.
func (a *API) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(a.recoverer, a.securityHeaders, a.clientIP, a.accessLog)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.Version})
	})
	r.Get("/readyz", a.readyz)

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(a.sameOrigin, a.authenticate, a.barrierGuard)
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "not_found", "接口不存在")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不被允许")
		})

		r.Get("/auth/status", a.authStatus)
		r.Post("/auth/setup", a.authSetup)
		r.Post("/auth/login", a.authLogin)

		r.Group(func(r chi.Router) {
			r.Use(a.requireSession)
			r.Post("/auth/logout", a.authLogout)
			r.Put("/auth/password", a.authChangePassword)
			r.Get("/auth/sessions", a.listSessions)
			r.Delete("/auth/sessions/{id}", a.revokeSession)

			r.Get("/audit-logs", a.listAuditLogs)
			r.Get("/audit-logs/export", a.exportAuditLogs)
			r.Get("/audit-logs/{id}", a.getAuditLog)

			r.Get("/dashboard/summary", a.dashboardSummary)
			r.Get("/system/version", a.systemVersion)
			r.Get("/system/self-update/result", a.getSelfUpdateResult)
			r.Get("/system/self-update/schedule", a.getSelfUpdateSchedule)
			r.Get("/ssh-keys", a.listSSHKeys)
			r.Get("/nodes", a.listNodes)
			r.Get("/nodes/{id}", a.getNode)
			r.Get("/settings", a.getSettings)
			r.Get("/settings/proxy", a.getProxy)
			r.Get("/releases/{product}", a.listReleases)
			r.Get("/operations", a.listOperations)
			r.Get("/cron-jobs", a.listCronJobs)
			r.Post("/cron-jobs/preview", a.previewCronSchedule)
			r.Get("/cron-jobs/{id}/runs", a.listCronRuns)
			r.Get("/operations/{id}", a.getOperation)
			r.Get("/operations/{id}/stream", a.streamOperation)

			r.Get("/clusters", a.listClusters)
			r.Get("/clusters/{id}", a.getCluster)
			r.Get("/clusters/{id}/status", a.clusterStatus)
			r.Get("/clusters/{id}/gate", a.clusterGate)
			r.Get("/clusters/{id}/nodes/{node_id}/logs/stream", a.streamNodeLogs)
			r.Get("/clusters/{id}/snapshots", a.listSnapshots)
			r.Get("/vault/{id}/key-generations", a.vaultKeyGenerations)
			r.Get("/vault/{id}/auth", a.vaultListAuth)
			r.Get("/vault/{id}/policies", a.vaultListPolicies)
			r.Get("/vault/{id}/policies/{name}", a.vaultGetPolicy)
			r.Get("/vault/{id}/kv/mounts", a.vaultKVMounts)
			r.Get("/vault/{id}/kv/list", a.vaultKVList)
			r.Get("/vault/{id}/kv/metadata", a.vaultKVMetadata)
			r.Get("/nodes/{id}/docker", a.getDocker)
			r.Get("/integrations", a.listIntegrations)
			r.Get("/nomad/{id}/jobs", a.listJobs)
			r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}", a.getJob)
			r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/versions", a.jobVersions)
			r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/revisions", a.jobRevisions)
			r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/{view}", a.jobView)
			r.Get("/nomad/{id}/watch", a.watch)
			r.Get("/nomad/{id}/search", a.search)
			r.Get("/nomad/{id}/allocs/{alloc_id}", a.allocDetail)
			r.Get("/nomad/{id}/allocs/{alloc_id}/stats", a.allocStats)
			r.Get("/nomad/{id}/allocs/{alloc_id}/checks", a.allocChecks)
			r.Get("/nomad/{id}/allocs/{alloc_id}/fs/{op}", a.allocFiles)
			r.Get("/nomad/{id}/allocs/{alloc_id}/logs/stream", a.allocLogStream)
			r.Get("/nomad/{id}/allocs/{alloc_id}/logs/download", a.allocLogDownload)
			r.Get("/nomad/{id}/clients", a.listClients)
			r.Get("/nomad/{id}/clients/{node_id}", a.clientDetail)
			r.Get("/nomad/{id}/clients/{node_id}/stats", a.clientStats)
			r.Get("/nomad/{id}/servers", a.nomadServers)
			r.Get("/nomad/{id}/topology", a.topology)
			r.Get("/nomad/{id}/evaluations", a.evaluations)
			r.Get("/nomad/{id}/evaluations/{eval_id}", a.evaluation)
			r.Get("/nomad/{id}/volumes", a.volumes)
			r.Get("/nomad/{id}/volumes/{volume_id}", a.volume)
			r.Get("/nomad/{id}/plugins", a.plugins)
			r.Get("/nomad/{id}/variables", a.listVariables)
			r.Get("/nomad/{id}/variables/item", a.getVariable)
			r.Get("/integrations/{id}", a.getIntegration)
			r.Get("/integrations/{id}/roles", a.listIntegrationRoles)
			r.Get("/nomad/{id}/namespaces", a.nomadListNamespaces)
			r.Get("/nomad/{id}/node-pools", a.nomadListNodePools)
			r.Get("/nomad/{id}/acl/policies", a.nomadListPolicies)
			r.Get("/nomad/{id}/acl/policies/{name}", a.nomadGetPolicy)
			r.Get("/nomad/{id}/acl/roles", a.nomadListRoles)
			r.Get("/nomad/{id}/acl/tokens", a.nomadListTokens)

			r.Group(func(r chi.Router) {
				r.Use(a.requireAdmin)
				r.Get("/admins", a.listAdmins)
				r.Post("/admins", a.createAdmin)
				r.Put("/admins/{id}", a.updateAdmin)
				r.Put("/admins/{id}/role", a.changeRole)
				r.Post("/admins/{id}/reset-password", a.resetPassword)
				r.Post("/admins/{id}/disable", a.disableAdmin)
				r.Post("/admins/{id}/enable", a.enableAdmin)

				r.Post("/ssh-keys", a.importSSHKey)
				r.Post("/ssh-keys/generate", a.generateSSHKey)
				r.Put("/ssh-keys/{id}/default", a.setDefaultSSHKey)
				r.Delete("/ssh-keys/{id}", a.deleteSSHKey)

				r.Post("/nodes", a.createNode)
				r.Put("/nodes/{id}", a.updateNode)
				r.Delete("/nodes/{id}", a.deleteNode)
				r.Put("/nodes/{id}/aliases", a.setNodeAliases)
				r.Post("/nodes/{id}/push-key", a.pushNodeKey)
				r.Post("/nodes/{id}/test", a.testNode)
				r.Post("/nodes/{id}/metrics", a.refreshNodeMetrics)
				r.Post("/nodes/metrics/refresh", a.refreshAllNodeMetrics)
				r.Post("/nodes/{id}/reset-fingerprint", a.resetNodeFingerprint)

				r.Post("/clusters", a.createCluster)
				r.Delete("/clusters/{id}", a.deleteCluster)
				r.Post("/clusters/{id}/nodes", a.addClusterNodes)
				r.Post("/clusters/{id}/preflight", a.clusterPreflight)
				r.Post("/clusters/{id}/deploy", a.deployCluster)
				r.Post("/clusters/{id}/nodes/{node_id}/join", a.joinClusterNode)
				r.Post("/clusters/{id}/nodes/{node_id}/remove", a.removeClusterNode)
				r.Post("/clusters/{id}/nodes/{node_id}/service/{action}", a.clusterNodeService)
				r.Post("/clusters/{id}/upgrade/plan", a.upgradePlan)
				r.Post("/clusters/{id}/upgrade", a.upgradeCluster)
				r.Post("/clusters/{id}/certs/renew", a.renewCerts)
				r.Post("/clusters/{id}/ca/rotate", a.rotateCA)
				r.Post("/clusters/{id}/gossip/rotate", a.rotateGossip)
				r.Put("/clusters/{id}", a.updateCluster)
				r.Put("/clusters/{id}/nodes/{node_id}/config", a.updateNodeConfig)
				r.Put("/clusters/{id}/credentials", a.supplyCredentials)
				r.Post("/clusters/{id}/reconcile", a.reconcileCluster)
				r.Put("/clusters/{id}/maintenance", a.setMaintenance)
				r.Put("/clusters/{id}/proxy", a.setClusterProxy)
				r.Post("/clusters/{id}/uninstall/plan", a.uninstallPlan)
				r.Post("/clusters/{id}/uninstall", a.uninstallCluster)
				r.Post("/clusters/{id}/doctor", a.doctorCluster)
				r.Post("/clusters/{id}/snapshots", a.createSnapshot)
				r.Post("/clusters/{id}/snapshots/upload", a.uploadSnapshot)
				r.Post("/clusters/{id}/snapshots/{snapshot_id}/download", a.downloadSnapshot)
				r.Post("/clusters/{id}/snapshots/{snapshot_id}/restore", a.restoreSnapshot)
				r.Delete("/clusters/{id}/snapshots/{snapshot_id}", a.deleteSnapshot)

				r.Post("/clusters/{id}/nodes/{node_id}/config/rollback", a.rollbackNodeConfig)
				r.Post("/vault/{id}/init", a.vaultInit)
				r.Post("/vault/{id}/init/reset", a.vaultInitReset)
				r.Post("/vault/{id}/unseal", a.vaultUnseal)
				r.Post("/vault/{id}/seal", a.vaultSeal)
				r.Put("/vault/{id}/custody", a.vaultCustody)
				r.Post("/vault/{id}/custody/backup", a.vaultBackup)
				r.Post("/vault/{id}/custody/recover-token", a.vaultRecoverToken)
				r.Post("/vault/{id}/root-token", a.vaultGenerateRootToken)
				r.Post("/vault/{id}/root-token/revoke", a.vaultRevokeRootToken)
				r.Post("/vault/{id}/rekey", a.vaultRekey)
				r.Post("/vault/{id}/auth", a.vaultEnableAuth)
				r.Delete("/vault/{id}/auth", a.vaultDisableAuth)
				r.Put("/vault/{id}/policies/{name}", a.vaultPutPolicy)
				r.Delete("/vault/{id}/policies/{name}", a.vaultDeletePolicy)
				r.Post("/vault/{id}/kv/mounts", a.vaultEnableKVMount)
				r.Get("/vault/{id}/kv/item", a.vaultKVRead)
				r.Put("/vault/{id}/kv/item", a.vaultKVWrite)
				r.Delete("/vault/{id}/kv/item", a.vaultKVDelete)

				r.Post("/nomad/{id}/namespaces", a.nomadPutNamespace(true))
				r.Put("/nomad/{id}/namespaces/{name}", a.nomadPutNamespace(false))
				r.Delete("/nomad/{id}/namespaces/{name}", a.nomadDeleteNamespace)
				r.Post("/nomad/{id}/node-pools", a.nomadPutNodePool(true))
				r.Put("/nomad/{id}/node-pools/{name}", a.nomadPutNodePool(false))
				r.Delete("/nomad/{id}/node-pools/{name}", a.nomadDeleteNodePool)
				r.Put("/nomad/{id}/acl/policies/{name}", a.nomadPutPolicy)
				r.Delete("/nomad/{id}/acl/policies/{name}", a.nomadDeletePolicy)
				r.Post("/nomad/{id}/acl/roles", a.nomadPutRole)
				r.Put("/nomad/{id}/acl/roles/{role_id}", a.nomadPutRole)
				r.Delete("/nomad/{id}/acl/roles/{role_id}", a.nomadDeleteRole)
				r.Post("/nomad/{id}/acl/tokens", a.nomadCreateToken)
				r.Delete("/nomad/{id}/acl/tokens/{accessor_id}", a.nomadRevokeToken)
				r.Post("/nomad/{id}/management-token/reveal", a.nomadRevealManagementToken)

				r.Post("/nodes/{id}/docker/{action}", a.dockerAction)
				r.Put("/nodes/{id}/docker/config", a.putDockerConfig)
				r.Post("/nodes/{id}/docker/proxy-test", a.dockerProxyTest)
				r.Post("/clusters/{id}/docker/upgrade/plan", a.clusterDockerPlan)
				r.Post("/clusters/{id}/docker/upgrade", a.clusterDockerUpgrade)
				r.Put("/clusters/{id}/docker/defaults", a.putDockerDefaults)

				r.Post("/integrations", a.createIntegration)
				r.Put("/integrations/{id}", a.updateIntegration)
				r.Delete("/integrations/{id}", a.deleteIntegration)
				r.Post("/integrations/{id}/roles", a.putIntegrationRole)
				r.Put("/integrations/{id}/roles/{role_id}", a.putIntegrationRole)
				r.Delete("/integrations/{id}/roles/{role_id}", a.deleteIntegrationRole)
				r.Post("/integrations/{id}/plan", a.planIntegration)
				r.Post("/integrations/{id}/apply", a.applyIntegration)
				r.Post("/integrations/{id}/doctor", a.doctorIntegration)
				r.Post("/integrations/{id}/job-example", a.integrationJobExample)

				r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/definition", a.jobDefinition)
				r.Get("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/edit-source", a.jobEditSource)
				r.Post("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/{action}", a.jobAction)
				r.Post("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/periodic/force", a.forcePeriodic)
				r.Post("/nomad/{id}/namespaces/{namespace}/jobs/{job_id}/dispatch", a.dispatchJob)
				r.Post("/nomad/{id}/deployments/{dep_id}/{action}", a.deploymentAction)
				r.Post("/nomad/{id}/allocs/{alloc_id}/{action}", a.allocAction)
				r.Get("/nomad/{id}/allocs/{alloc_id}/fs/content/{op}", a.allocFileContent)
				r.Post("/nomad/{id}/allocs/{alloc_id}/exec-ticket", a.execTicket)
				r.Get("/nomad/{id}/allocs/{alloc_id}/exec", a.execTerminal)
				r.Post("/nomad/{id}/clients/{node_id}/{action}", a.clientAction)
				r.Delete("/nomad/{id}/volumes/{volume_id}", a.deleteVolume)
				r.Put("/nomad/{id}/variables/item", a.putVariable)
				r.Delete("/nomad/{id}/variables/item", a.deleteVariable)
				r.Post("/nomad/{id}/variables/item/reveal", a.revealVariable)
				r.Get("/nomad/{id}/revisions/{revision_id}/variables", a.revisionVariables)
				r.Post("/nomad/{id}/revisions/{revision_id}/review", a.reviewRevision)
				r.Post("/nomad/{id}/job-ops/{op}", a.jobOp)
				r.Get("/nomad/{id}/builder-options", a.builderOptions)
				r.Get("/job-templates", a.listTemplates)
				r.Post("/job-templates", a.putTemplate)
				r.Get("/job-templates/{tid}", a.getTemplate)
				r.Put("/job-templates/{tid}", a.putTemplate)
				r.Delete("/job-templates/{tid}", a.deleteTemplate)

				r.Put("/settings", a.putSettings)
				r.Get("/settings/master-key", a.getMasterKeyStatus)
				r.Post("/settings/master-key/rotate", a.rotateMasterKey)
				r.Get("/settings/master-key/rotation", a.getMasterKeyRotation)
				r.Post("/cron-jobs", a.createCronJob)
				r.Post("/migration/export", a.migrationExport)
				r.Post("/migration/import/preview", a.migrationPreview)
				r.Post("/migration/import/apply", a.migrationApply)
				r.Post("/migration/activate", a.migrationActivate)
				r.Get("/backup/config", a.getBackupConfig)
				r.Put("/backup/config", a.putBackupConfig)
				r.Post("/backup/targets/test", a.testBackupTarget)
				r.Post("/backup/secrets/reveal", a.revealBackupSecret)
				r.Post("/backup/run", a.runBackup)
				r.Get("/backup/history", a.listBackupHistory)
				r.Get("/backup/targets/{id}/snapshots", a.listTargetSnapshots)
				r.Post("/backup/snapshots/import", a.importTargetSnapshot)
				r.Post("/system/self-update", a.startSelfUpdate)
				r.Post("/system/self-update/schedule", a.createSelfUpdateSchedule)
				r.Delete("/system/self-update/schedule", a.cancelSelfUpdateSchedule)
				r.Post("/system/self-update/rollback", a.rollbackSelfUpdate)
				r.Put("/cron-jobs/{id}", a.updateCronJob)
				r.Delete("/cron-jobs/{id}", a.deleteCronJob)
				r.Post("/cron-jobs/{id}/run", a.runCronJob)
				r.Put("/settings/proxy", a.putProxy)
				r.Post("/settings/proxy/test", a.testProxy)
				r.Post("/settings/proxy/reveal", a.revealProxyPassword)
			})
		})
	})
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api" || strings.HasPrefix(req.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "not_found", "API 接口不存在")
			return
		}
		if a.UI != nil {
			a.UI.ServeHTTP(w, req)
			return
		}
		http.NotFound(w, req)
	})
	return r
}

func (a *API) readyz(w http.ResponseWriter, r *http.Request) {
	if a.Ready == nil || !a.Ready.Load() {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "服务尚未就绪")
		return
	}
	if err := a.DB.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "db_unavailable", "数据库不可用")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func fmtTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
