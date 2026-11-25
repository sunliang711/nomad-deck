package api

import (
	"net/http"
	"time"

	"nomad-deck/internal/backup"
	"nomad-deck/internal/cron"
	"nomad-deck/internal/db"
	"nomad-deck/internal/hosts"
	"nomad-deck/internal/version"
)

func (a *API) dashboardSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	activated := true
	_ = db.GetSettingJSON(ctx, a.DB.Reader, cron.SettingActivated, &activated)
	barrier := ""
	if a.Ops != nil {
		barrier = a.Ops.Barrier()
	}
	rotState := ""
	if a.Rotation != nil {
		if st, err := a.Rotation.Status(ctx); err == nil && st.Journal != nil {
			rotState = st.Journal.State
		}
	}

	nodes, err := db.ListNodes(ctx, a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	type clockAlert struct {
		NodeID      string `json:"node_id"`
		NodeName    string `json:"node_name"`
		Host        string `json:"host"`
		TimeSync    string `json:"time_sync"`
		ClockSkewMS int64  `json:"clock_skew_ms"`
	}
	onlineNodes, offlineNodes := 0, 0
	clockAlerts := []clockAlert{}
	for _, n := range nodes {
		switch n.Status {
		case "online":
			onlineNodes++
		case "offline":
			offlineNodes++
		}
		skew := n.ClockSkewMS
		if skew < 0 {
			skew = -skew
		}
		if skew > hosts.MaxClockSkew.Milliseconds() || (n.TimeSync != "" && n.TimeSync != "synced") {
			clockAlerts = append(clockAlerts, clockAlert{
				NodeID: n.ID, NodeName: n.Name, Host: n.Host, TimeSync: n.TimeSync, ClockSkewMS: n.ClockSkewMS,
			})
		}
	}

	clusters, err := db.ListClusters(ctx, a.DB.Reader, "")
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	type clusterItem struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		Type              string `json:"type"`
		Mode              string `json:"mode"`
		InitState         string `json:"init_state"`
		HealthStatus      string `json:"health_status"`
		MaintenanceMode   bool   `json:"maintenance_mode"`
		MaintenanceReason string `json:"maintenance_reason,omitempty"`
	}
	clusterByID := map[string]*db.Cluster{}
	byHealth := map[string]int{}
	clusterItems := make([]clusterItem, 0, len(clusters))
	nomadCount, vaultCount := 0, 0
	for _, c := range clusters {
		clusterByID[c.ID] = c
		byHealth[c.HealthStatus]++
		switch c.Type {
		case "nomad":
			nomadCount++
		case "vault":
			vaultCount++
		}
		clusterItems = append(clusterItems, clusterItem{
			ID: c.ID, Name: c.Name, Type: c.Type, Mode: c.Mode, InitState: c.InitState,
			HealthStatus: c.HealthStatus, MaintenanceMode: c.MaintenanceMode, MaintenanceReason: c.MaintenanceReason,
		})
	}

	type vaultAlert struct {
		ClusterID   string `json:"cluster_id"`
		ClusterName string `json:"cluster_name"`
		Kind        string `json:"kind"` // unseal_suppressed | token_expiring | health
		Message     string `json:"message"`
	}
	vaultAlerts := []vaultAlert{}
	custodies, err := db.ListAllCustody(ctx, a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	now := a.DB.Now()
	for _, cu := range custodies {
		cl := clusterByID[cu.ClusterID]
		if cl == nil {
			continue
		}
		if cu.UnsealSuppressedReason != "" {
			vaultAlerts = append(vaultAlerts, vaultAlert{
				ClusterID: cl.ID, ClusterName: cl.Name, Kind: "unseal_suppressed",
				Message: "自动解封已抑制（" + cu.UnsealSuppressedReason + "）",
			})
		}
		if cu.Initialized && !cu.AdminTokenExpiresAt.IsZero() && cu.AdminTokenExpiresAt.Before(now.Add(24*time.Hour)) {
			msg := "Vault 运维 Token 即将过期"
			if cu.AdminTokenExpiresAt.Before(now) {
				msg = "Vault 运维 Token 已过期"
			}
			vaultAlerts = append(vaultAlerts, vaultAlert{
				ClusterID: cl.ID, ClusterName: cl.Name, Kind: "token_expiring", Message: msg,
			})
		}
	}
	for _, c := range clusters {
		if c.Type == "vault" && (c.HealthStatus == "sealed" || c.HealthStatus == "degraded" || c.HealthStatus == "unreachable") {
			vaultAlerts = append(vaultAlerts, vaultAlert{
				ClusterID: c.ID, ClusterName: c.Name, Kind: "health",
				Message: "Vault 集群状态异常：" + c.HealthStatus,
			})
		}
	}

	certAlerts, err := cron.CertAlerts(ctx, a.DB)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}

	var backupAlerts *backup.AlertSummary
	if a.Backup != nil {
		backupAlerts, err = a.Backup.AlertSummary(ctx)
		if err != nil {
			a.writeErr(w, r, err)
			return
		}
	}

	reconcileTasks, err := db.ListTasks(ctx, a.DB.Reader, db.TaskFilter{Status: db.TaskNeedsReconcile, Limit: 50})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	reconcileViews := make([]taskView, 0, len(reconcileTasks))
	for _, t := range reconcileTasks {
		reconcileViews = append(reconcileViews, taskOf(t))
	}

	recentOps, err := db.ListTasks(ctx, a.DB.Reader, db.TaskFilter{Limit: 10})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	recentOpViews := make([]taskView, 0, len(recentOps))
	for _, t := range recentOps {
		recentOpViews = append(recentOpViews, taskOf(t))
	}

	recentAudit, err := db.ListAuditLogs(ctx, a.DB.Reader, db.AuditFilter{Limit: 10})
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	recentAuditViews := make([]auditView, 0, len(recentAudit))
	for _, l := range recentAudit {
		recentAuditViews = append(recentAuditViews, auditOf(l))
	}

	cronJobs, err := db.ListCronJobs(ctx, a.DB.Reader)
	if err != nil {
		a.writeErr(w, r, err)
		return
	}
	cronEnabled, cronFailed := 0, 0
	for _, j := range cronJobs {
		if j.Enabled {
			cronEnabled++
		}
		if j.LastStatus == "failed" {
			cronFailed++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"control_plane": map[string]any{
			"version":             version.Version,
			"activated":           activated,
			"maintenance_barrier": barrier,
			"key_rotation_state":  rotState,
		},
		"nodes": map[string]any{
			"total":             len(nodes),
			"online":            onlineNodes,
			"offline":           offlineNodes,
			"clock_skew_alerts": clockAlerts,
		},
		"clusters": map[string]any{
			"total":     len(clusters),
			"nomad":     nomadCount,
			"vault":     vaultCount,
			"by_health": byHealth,
			"items":     clusterItems,
		},
		"vault_alerts":            vaultAlerts,
		"cert_alerts":             certAlerts,
		"backup_alerts":           backupAlerts,
		"pending_reconcile_tasks": reconcileViews,
		"recent_operations":       recentOpViews,
		"recent_audit_logs":       recentAuditViews,
		"cron_summary": map[string]any{
			"total":   len(cronJobs),
			"enabled": cronEnabled,
			"failed":  cronFailed,
		},
	})
}
