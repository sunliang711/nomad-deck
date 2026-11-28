package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"nomad-deck/internal/db"
	"nomad-deck/internal/nomad"
)

// AllocMetric mirrors the subset of Nomad's AllocationMetric returned in
// FailedTGAllocs during job plan evaluation.
type AllocMetric struct {
	NodesEvaluated     int            `json:"NodesEvaluated"`
	NodesFiltered      int            `json:"NodesFiltered"`
	NodesAvailable     map[string]int `json:"NodesAvailable"`
	ClassFiltered      map[string]int `json:"ClassFiltered"`
	ConstraintFiltered map[string]int `json:"ConstraintFiltered"`
	NodesExhausted     int            `json:"NodesExhausted"`
	ClassExhausted     map[string]int `json:"ClassExhausted"`
	DimensionExhausted map[string]int `json:"DimensionExhausted"`
	QuotaExhausted     []string       `json:"QuotaExhausted"`
}

// ExplainFailedTGAllocs translates Nomad Plan FailedTGAllocs into readable
// Chinese scheduling failure reasons.
func ExplainFailedTGAllocs(raw any) []string {
	if raw == nil {
		return nil
	}
	b, err := json.Marshal(raw)
	if err != nil || len(b) == 0 || string(b) == "null" {
		return nil
	}
	var m map[string]AllocMetric
	if err := json.Unmarshal(b, &m); err != nil || len(m) == 0 {
		return nil
	}
	groups := make([]string, 0, len(m))
	for g := range m {
		groups = append(groups, g)
	}
	sort.Strings(groups)

	var out []string
	for _, g := range groups {
		am := m[g]
		added := false
		if am.NodesEvaluated == 0 {
			out = append(out, fmt.Sprintf("任务组 %q 没有匹配的可用节点（请检查 Datacenter、Node Pool 或 Client 在线状态）", g))
			added = true
		}
		if len(am.ConstraintFiltered) > 0 {
			keys := sortedMapKeys(am.ConstraintFiltered)
			for _, k := range keys {
				cnt := am.ConstraintFiltered[k]
				lower := strings.ToLower(k)
				switch {
				case strings.Contains(lower, "missing drivers") || (strings.Contains(lower, "driver") && strings.Contains(lower, "not healthy")):
					out = append(out, fmt.Sprintf("任务组 %q 所需驱动未就绪：%s（%d 个节点不满足）", g, k, cnt))
				case strings.Contains(lower, "host volume"):
					out = append(out, fmt.Sprintf("任务组 %q 缺少 Host Volume：%s（%d 个节点不满足）", g, k, cnt))
				default:
					out = append(out, fmt.Sprintf("任务组 %q 约束条件不满足：%s（%d 个节点被过滤）", g, k, cnt))
				}
				added = true
			}
		}
		if len(am.DimensionExhausted) > 0 {
			parts := make([]string, 0, len(am.DimensionExhausted))
			for _, k := range sortedMapKeys(am.DimensionExhausted) {
				parts = append(parts, fmt.Sprintf("%s（%d 个节点）", k, am.DimensionExhausted[k]))
			}
			out = append(out, fmt.Sprintf("任务组 %q 节点资源或端口不足：%s", g, strings.Join(parts, "、")))
			added = true
		} else if am.NodesExhausted > 0 {
			out = append(out, fmt.Sprintf("任务组 %q 在 %d 个节点上资源耗尽", g, am.NodesExhausted))
			added = true
		}
		if len(am.QuotaExhausted) > 0 {
			out = append(out, fmt.Sprintf("任务组 %q 超出 Namespace Quota 配额：%s", g, strings.Join(am.QuotaExhausted, "、")))
			added = true
		}
		if !added {
			out = append(out, fmt.Sprintf("任务组 %q 当前无法在集群中调度（%d 个节点被过滤）", g, am.NodesFiltered))
		}
	}
	return out
}

func sortedMapKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// PreflightJob checks whether the target cluster currently satisfies the
// environment requirements of a parsed Nomad Job JSON.
func (s *Service) PreflightJob(ctx context.Context, clusterID string, j Job) []string {
	issues, _ := s.PreflightJobDetailed(ctx, clusterID, j)
	return issues
}

// PreflightJobDetailed checks cluster prerequisites and returns both blocking
// issue messages and structured check items with quick-fix metadata.
func (s *Service) PreflightJobDetailed(ctx context.Context, clusterID string, j Job) ([]string, []PreflightCheck) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, nil
	}
	return s.PreflightDetailed(ctx, c, clusterID, j)
}

func (s *Service) vaultInspectJob(ctx context.Context, clusterID string, j Job) (JobValidationReport, []VaultIntegrationRef) {
	if s == nil || s.VaultInspector == nil || j == nil {
		return JobValidationReport{}, nil
	}
	igs, checkKV := s.VaultInspector(ctx, clusterID)
	nomadACL := false
	if s.DB != nil {
		if cl, err := db.GetCluster(ctx, s.DB.Reader, clusterID); err == nil && cl != nil && cl.AdminTokenEncrypted != "" {
			nomadACL = true
		}
	}
	return AnalyzeJobRequirements(j, igs, str(j["Namespace"]), checkKV, nomadACL), igs
}

// InspectJobWarnings returns advisory warnings for Vault/Traefik pairing and
// privileged host static ports (e.g. 80/443).
func (s *Service) InspectJobWarnings(ctx context.Context, clusterID string, j Job) []string {
	if j == nil {
		return nil
	}
	rep, _ := s.vaultInspectJob(ctx, clusterID, j)
	out := append([]string(nil), rep.Warnings...)
	seen := map[string]bool{}
	for _, w := range out {
		seen[w] = true
	}
	for _, g := range parseGroupRequirements(j) {
		var webPorts []string
		for _, p := range g.staticPorts {
			if p == 80 || p == 443 {
				webPorts = append(webPorts, strconv.Itoa(p))
			}
		}
		if len(webPorts) > 0 {
			msg := fmt.Sprintf("任务组 %q 映射了宿主机静态端口 %s，请确保目标节点上没有被宿主机进程（如 systemd Nginx / OpenResty / Caddy）或同端口网关占用。", g.name, strings.Join(webPorts, "、"))
			if !seen[msg] {
				seen[msg] = true
				out = append(out, msg)
			}
		}
	}
	return out
}

// Preflight inspects cluster namespaces, node pools, eligible Client nodes,
// task drivers, CNI configuration, host volumes, Docker host mounts, static
// port collisions, and Vault/template prerequisites against the Job definition.
func (s *Service) Preflight(ctx context.Context, c *nomad.Client, clusterID string, j Job) []string {
	issues, _ := s.PreflightDetailed(ctx, c, clusterID, j)
	return issues
}

// PreflightDetailed runs full cluster & Vault prerequisite checks and returns
// both flat blocking error messages and structured per-requirement check items.
func (s *Service) PreflightDetailed(ctx context.Context, c *nomad.Client, clusterID string, j Job) ([]string, []PreflightCheck) {
	if j == nil {
		return nil, nil
	}
	if stop, _ := j["Stop"].(bool); stop {
		return nil, nil
	}

	var issues []string
	var checks []PreflightCheck
	seen := map[string]bool{}
	seenCheck := map[string]bool{}
	add := func(format string, args ...any) string {
		msg := fmt.Sprintf(format, args...)
		if !seen[msg] {
			seen[msg] = true
			issues = append(issues, msg)
		}
		return msg
	}
	addCheck := func(chk PreflightCheck) {
		if chk.ID == "" || seenCheck[chk.ID] {
			return
		}
		seenCheck[chk.ID] = true
		checks = append(checks, chk)
	}
	nomadClusterLink := "/nomad"
	nomadConfigLink := "/nomad?tab=ops&sub=config"
	if clusterID != "" {
		nomadClusterLink = "/nomad?id=" + url.QueryEscape(clusterID)
		nomadConfigLink = nomadClusterLink + "&tab=ops&sub=config"
	}

	// Run Vault integration, KV mount/secret/key and paired gateway config blockers first.
	vaultRep, igs := s.vaultInspectJob(ctx, clusterID, j)
	for _, msg := range vaultRep.Blocking {
		add("%s", msg)
	}
	// Vault checks are appended after cluster/driver checks for natural top-down reading,
	// so we attach them right before returning.
	finalize := func() ([]string, []PreflightCheck) {
		for _, chk := range vaultRep.Checks {
			addCheck(chk)
		}
		return issues, checks
	}

	jobNS := orDefault(str(j["Namespace"]), "default")
	var nss []struct {
		Name string `json:"Name"`
	}
	if err := c.Request(ctx, http.MethodGet, "namespaces", nil, &nss); err == nil && len(nss) > 0 {
		found := false
		for _, n := range nss {
			if n.Name == jobNS {
				found = true
				break
			}
		}
		if !found {
			msg := add("命名空间 %q 在当前 Nomad 集群中不存在（请先前往「Nomad 集群 → 治理」创建）", jobNS)
			addCheck(PreflightCheck{
				ID:       "namespace:" + jobNS,
				Kind:     "namespace",
				Status:   "error",
				Title:    fmt.Sprintf("命名空间 %q 不存在", jobNS),
				TitleEn:  fmt.Sprintf("Namespace %q missing", jobNS),
				Detail:   msg,
				DetailEn: fmt.Sprintf("Namespace %q does not exist in this Nomad cluster.", jobNS),
				FixAction: &PreflightFixAction{
					Type:    "link",
					Path:    nomadClusterLink,
					Label:   "前往集群治理",
					LabelEn: "Open Governance",
				},
			})
		}
	}

	jobPool := orDefault(str(j["NodePool"]), "default")
	if jobPool != "default" && jobPool != "all" {
		var pools []struct {
			Name string `json:"Name"`
		}
		if err := c.Request(ctx, http.MethodGet, "node/pools", nil, &pools); err == nil && len(pools) > 0 {
			found := false
			for _, p := range pools {
				if p.Name == jobPool {
					found = true
					break
				}
			}
			if !found {
				msg := add("Node Pool %q 在当前 Nomad 集群中不存在（请先前往「Nomad 集群 → 治理」创建）", jobPool)
				addCheck(PreflightCheck{
					ID:       "node_pool:" + jobPool,
					Kind:     "node_pool",
					Status:   "error",
					Title:    fmt.Sprintf("Node Pool %q 不存在", jobPool),
					TitleEn:  fmt.Sprintf("Node Pool %q missing", jobPool),
					Detail:   msg,
					DetailEn: fmt.Sprintf("Node Pool %q does not exist in this Nomad cluster.", jobPool),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    nomadClusterLink,
						Label:   "前往集群治理",
						LabelEn: "Open Governance",
					},
				})
			}
		}
	}

	nodes, err := c.Nodes(ctx)
	if err != nil {
		return finalize()
	}
	if len(nodes) == 0 {
		msg := add("当前 Nomad 集群没有 Client 节点（纯 Server 集群无法运行任务，请先扩容 Client 或 Server+Client 节点）")
		addCheck(PreflightCheck{
			ID:       "client_nodes",
			Kind:     "client_nodes",
			Status:   "error",
			Title:    "没有可用的 Client 节点",
			TitleEn:  "No Nomad Client nodes",
			Detail:   msg,
			DetailEn: "This Nomad cluster has no Client nodes to run workloads.",
			FixAction: &PreflightFixAction{
				Type:    "link",
				Path:    nomadClusterLink,
				Label:   "前往集群节点",
				LabelEn: "Open Cluster Nodes",
			},
		})
		return finalize()
	}

	var eligible []nomad.NodeStub
	for _, n := range nodes {
		if n.Status == "ready" && n.SchedulingEligibility == "eligible" && !n.Drain {
			eligible = append(eligible, n)
		}
	}
	if len(eligible) == 0 {
		msg := add("当前集群共有 %d 个 Client 节点，但均处于下线、维护排空或不可调度状态，任务无法调度", len(nodes))
		addCheck(PreflightCheck{
			ID:       "client_nodes",
			Kind:     "client_nodes",
			Status:   "error",
			Title:    "所有 Client 节点当前不可调度",
			TitleEn:  "No eligible Client nodes",
			Detail:   msg,
			DetailEn: fmt.Sprintf("All %d Client node(s) are down, draining, or ineligible.", len(nodes)),
			FixAction: &PreflightFixAction{
				Type:    "link",
				Path:    nomadClusterLink,
				Label:   "前往集群节点",
				LabelEn: "Open Cluster Nodes",
			},
		})
		return finalize()
	}

	dcs := jobStringList(j["Datacenters"])
	var scoped []nomad.NodeStub
	for _, n := range eligible {
		if !matchDatacenter(n.Datacenter, dcs) {
			continue
		}
		nPool := orDefault(n.NodePool, "default")
		if jobPool != "all" && nPool != jobPool {
			continue
		}
		scoped = append(scoped, n)
	}
	if len(scoped) == 0 {
		dcLabel := "*"
		if len(dcs) > 0 {
			dcLabel = strings.Join(dcs, ", ")
		}
		msg := add("在目标 Datacenter（%s）和 Node Pool（%s）范围内没有就绪且可调度的 Client 节点", dcLabel, jobPool)
		addCheck(PreflightCheck{
			ID:       "client_nodes",
			Kind:     "client_nodes",
			Status:   "error",
			Title:    "目标范围无可用 Client 节点",
			TitleEn:  "No matching Client nodes in scope",
			Detail:   msg,
			DetailEn: fmt.Sprintf("No ready, eligible Client nodes match Datacenter (%s) and Node Pool (%s).", dcLabel, jobPool),
			FixAction: &PreflightFixAction{
				Type:    "link",
				Path:    nomadClusterLink,
				Label:   "前往集群节点",
				LabelEn: "Open Cluster Nodes",
			},
		})
		return finalize()
	}

	groups := parseGroupRequirements(j)
	needVolumes := false
	needBridge := false
	needDockerBinds := false
	needStaticPorts := false
	for _, g := range groups {
		if len(g.hostVolumes) > 0 {
			needVolumes = true
		}
		if g.needsBridge {
			needBridge = true
		}
		if len(g.dockerHostBinds) > 0 {
			needDockerBinds = true
		}
		if len(g.staticPorts) > 0 {
			needStaticPorts = true
		}
	}

	nodeVolumes := map[string]map[string]bool{}
	nodeDetails := map[string]*nomad.NodeDetail{}
	if needVolumes || needDockerBinds {
		for _, n := range scoped {
			nd, nerr := c.Node(ctx, n.ID)
			if nerr != nil || nd == nil {
				continue
			}
			nodeDetails[n.ID] = nd
			vols := map[string]bool{}
			for vname := range nd.HostVolumes {
				vols[vname] = true
			}
			nodeVolumes[n.ID] = vols
		}
	}

	var cniByNodeID, cniByNodeName map[string]bool
	dockerVolsByNodeID := map[string]bool{}
	dockerVolsByNodeName := map[string]bool{}
	hasManagedMembers := false
	if (needBridge || needDockerBinds) && s.DB != nil {
		if members, merr := db.ListClusterNodes(ctx, s.DB.Reader, clusterID); merr == nil && len(members) > 0 {
			hasManagedMembers = true
			cniByNodeID = map[string]bool{}
			cniByNodeName = map[string]bool{}
			for _, m := range members {
				if !nomad.IsClient(m.Role) {
					continue
				}
				var mc nomad.MemberConfig
				if m.NodeConfigJSON != "" {
					_ = json.Unmarshal([]byte(m.NodeConfigJSON), &mc)
				}
				if mc.ClientNodeID != "" {
					cniByNodeID[mc.ClientNodeID] = mc.CNI
					dockerVolsByNodeID[mc.ClientNodeID] = mc.Docker.Volumes
				}
				if mc.NodeName != "" {
					cniByNodeName[mc.NodeName] = mc.CNI
					dockerVolsByNodeName[mc.NodeName] = mc.Docker.Volumes
				}
				if m.NodeName != "" {
					cniByNodeName[m.NodeName] = mc.CNI
					dockerVolsByNodeName[m.NodeName] = mc.Docker.Volumes
				}
			}
		}
	}

	nodeHasCNI := func(n nomad.NodeStub) bool {
		if !hasManagedMembers {
			return true
		}
		if v, ok := cniByNodeID[n.ID]; ok {
			return v
		}
		if v, ok := cniByNodeName[n.Name]; ok {
			return v
		}
		return false
	}

	nodeAllowsDockerVolumes := func(n nomad.NodeStub) bool {
		if nd := nodeDetails[n.ID]; nd != nil {
			if drv, ok := nd.Drivers["docker"]; ok && drv.Attributes != nil {
				if raw, ok := drv.Attributes["driver.docker.volumes.enabled"]; ok {
					return raw == "true" || raw == "1"
				}
			}
			if nd.Attributes != nil {
				if raw, ok := nd.Attributes["driver.docker.volumes.enabled"]; ok {
					return raw == "true" || raw == "1"
				}
			}
		}
		if hasManagedMembers {
			if v, ok := dockerVolsByNodeID[n.ID]; ok {
				return v
			}
			if v, ok := dockerVolsByNodeName[n.Name]; ok {
				return v
			}
			return false
		}
		return true
	}

	// Check managed node TLS CA bind-mount files if cluster/integration metadata is available.
	if needDockerBinds && s.DB != nil {
		clMeta, _ := db.GetCluster(ctx, s.DB.Reader, clusterID)
		hasTLSVaultIG := false
		for _, ig := range igs {
			if ig.Status == "applied" && ig.NomadSideEnabled && ig.VaultTLSEnabled {
				hasTLSVaultIG = true
				break
			}
		}
		for _, g := range groups {
			for _, bind := range g.dockerHostBinds {
				switch bind.src {
				case "/opt/nomad-deck/nomad/etc/nomad.d/tls/vault-ca.crt":
					if len(igs) > 0 || s.VaultInspector != nil {
						if !hasTLSVaultIG {
							msg := add("Task %q 在 docker volumes 挂载了 Vault CA（%s），但当前 Nomad 集群尚未应用带 TLS 的 Nomad-Vault 联动，节点上不存在该文件。", bind.task, bind.src)
							addCheck(PreflightCheck{
								ID:       "ca_mount:vault-ca",
								Kind:     "ca_mount",
								Status:   "error",
								Title:    "节点缺少 Vault CA 证书文件",
								TitleEn:  "Vault CA file missing on nodes",
								Detail:   msg,
								DetailEn: fmt.Sprintf("Task %q mounts Vault CA (%s), but no TLS-enabled Nomad-Vault integration is applied yet.", bind.task, bind.src),
								FixAction: &PreflightFixAction{
									Type:    "link",
									Path:    "/integrations",
									Label:   "前往集群联动",
									LabelEn: "Open Integrations",
								},
							})
						} else {
							addCheck(PreflightCheck{
								ID:       "ca_mount:vault-ca",
								Kind:     "ca_mount",
								Status:   "ok",
								Title:    "节点 Vault CA 证书已分发",
								TitleEn:  "Vault CA certificate present on nodes",
								Detail:   fmt.Sprintf("已启用带 TLS 的 Nomad-Vault 联动，节点存在 %s。", bind.src),
								DetailEn: fmt.Sprintf("TLS Nomad-Vault integration is active; %s is provisioned on nodes.", bind.src),
							})
						}
					}
				case "/opt/nomad-deck/nomad/etc/nomad.d/tls/ca.pem":
					if clMeta != nil && !clMeta.TLSEnabled {
						msg := add("Task %q 在 docker volumes 挂载了 Nomad CA（%s），但当前集群未启用 TLS，节点上不存在该文件。", bind.task, bind.src)
						addCheck(PreflightCheck{
							ID:       "ca_mount:nomad-ca",
							Kind:     "ca_mount",
							Status:   "error",
							Title:    "节点缺少 Nomad CA 证书文件",
							TitleEn:  "Nomad CA file missing on nodes",
							Detail:   msg,
							DetailEn: fmt.Sprintf("Task %q mounts Nomad CA (%s), but TLS is not enabled on this Nomad cluster.", bind.task, bind.src),
							FixAction: &PreflightFixAction{
								Type:    "link",
								Path:    nomadConfigLink,
								Label:   "查看集群配置",
								LabelEn: "Cluster Config",
							},
						})
					} else if clMeta != nil && clMeta.TLSEnabled {
						addCheck(PreflightCheck{
							ID:       "ca_mount:nomad-ca",
							Kind:     "ca_mount",
							Status:   "ok",
							Title:    "节点 Nomad CA 证书已就绪",
							TitleEn:  "Nomad CA certificate ready on nodes",
							Detail:   fmt.Sprintf("集群已启用 TLS，节点存在 %s。", bind.src),
							DetailEn: fmt.Sprintf("Nomad TLS is enabled; %s is present on nodes.", bind.src),
						})
					}
				}
			}
		}
	}

	// Query active allocations on scoped nodes when the job claims static host ports.
	nodeUsedPorts := map[string]map[int]string{}
	if needStaticPorts {
		jobID := str(j["ID"])
		for _, n := range scoped {
			var allocs []struct {
				JobID              string `json:"JobID"`
				Namespace          string `json:"Namespace"`
				ClientStatus       string `json:"ClientStatus"`
				DesiredStatus      string `json:"DesiredStatus"`
				AllocatedResources struct {
					Shared struct {
						Ports []struct {
							Value int `json:"Value"`
						} `json:"Ports"`
					} `json:"Shared"`
				} `json:"AllocatedResources"`
			}
			if err := c.Request(ctx, http.MethodGet, "node/"+url.PathEscape(n.ID)+"/allocations", nil, &allocs); err != nil {
				continue
			}
			used := map[int]string{}
			for _, al := range allocs {
				if al.ClientStatus != "running" && al.ClientStatus != "pending" {
					continue
				}
				if al.DesiredStatus == "stop" {
					continue
				}
				if orDefault(al.Namespace, "default") == jobNS && al.JobID == jobID {
					continue
				}
				for _, pt := range al.AllocatedResources.Shared.Ports {
					if pt.Value > 0 && used[pt.Value] == "" {
						used[pt.Value] = al.JobID
					}
				}
			}
			nodeUsedPorts[n.ID] = used
		}
	}

	for _, g := range groups {
		groupMissingSingle := false

		for _, dr := range g.drivers {
			healthyCount := 0
			detectedUnhealthy := false
			for _, n := range scoped {
				info, ok := n.Drivers[dr.driver]
				if !ok {
					continue
				}
				if info.Healthy {
					healthyCount++
					continue
				}
				if info.Detected {
					detectedUnhealthy = true
				}
			}
			if healthyCount == 0 {
				groupMissingSingle = true
				msg := add("%s", driverMissingMessage(dr.task, dr.driver, detectedUnhealthy))
				fix := &PreflightFixAction{
					Type:    "link",
					Path:    nomadClusterLink,
					Label:   "前往集群配置",
					LabelEn: "Cluster Config",
				}
				if dr.driver == "docker" {
					fix = &PreflightFixAction{
						Type:    "link",
						Path:    "/docker",
						Label:   "前往 Docker 管理",
						LabelEn: "Open Docker Engine",
					}
				} else if dr.driver == "raw_exec" {
					fix = &PreflightFixAction{
						Type:    "link",
						Path:    nomadClusterLink,
						Label:   "前往启用 raw_exec",
						LabelEn: "Enable raw_exec",
					}
				}
				addCheck(PreflightCheck{
					ID:        "driver:" + dr.driver,
					Kind:      "driver",
					Status:    "error",
					Title:     fmt.Sprintf("驱动 %s 未就绪", dr.driver),
					TitleEn:   fmt.Sprintf("Driver %s not ready", dr.driver),
					Detail:    msg,
					DetailEn:  fmt.Sprintf("Task %q requires driver %q, which is not healthy on any eligible Client node.", dr.task, dr.driver),
					FixAction: fix,
				})
			} else {
				addCheck(PreflightCheck{
					ID:       "driver:" + dr.driver,
					Kind:     "driver",
					Status:   "ok",
					Title:    fmt.Sprintf("驱动 %s 已就绪", dr.driver),
					TitleEn:  fmt.Sprintf("Driver %s ready", dr.driver),
					Detail:   fmt.Sprintf("%d 个可用 Client 节点的 %s 驱动健康。", healthyCount, dr.driver),
					DetailEn: fmt.Sprintf("%s driver is healthy on %d eligible Client node(s).", dr.driver, healthyCount),
				})
			}
		}

		if g.needsBridge && hasManagedMembers {
			cniCount := 0
			for _, n := range scoped {
				if nodeHasCNI(n) {
					cniCount++
				}
			}
			if cniCount == 0 {
				groupMissingSingle = true
				msg := add("任务组 %q 使用了 bridge 网络模式，但目标范围内的 Client 节点尚未启用 CNI 插件（请先在「Nomad 集群 → 集群运维 → 集群配置」选择 CNI 版本并在「集群状态详情 → 节点插件/配置」启用 CNI）", g.name)
				addCheck(PreflightCheck{
					ID:       "cni",
					Kind:     "cni",
					Status:   "error",
					Title:    "CNI 插件未启用（bridge 网络）",
					TitleEn:  "CNI plugin not enabled (bridge network)",
					Detail:   msg,
					DetailEn: fmt.Sprintf("Group %q uses bridge networking, but no eligible Client node has CNI enabled.", g.name),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    nomadClusterLink,
						Label:   "前往启用 CNI",
						LabelEn: "Configure CNI",
					},
				})
			} else {
				addCheck(PreflightCheck{
					ID:       "cni",
					Kind:     "cni",
					Status:   "ok",
					Title:    "CNI 插件已就绪（bridge 网络）",
					TitleEn:  "CNI plugin ready (bridge network)",
					Detail:   fmt.Sprintf("%d 个可用 Client 节点已启用 CNI。", cniCount),
					DetailEn: fmt.Sprintf("CNI is enabled on %d eligible Client node(s).", cniCount),
				})
			}
		}

		if len(g.dockerHostBinds) > 0 {
			allowCount := 0
			for _, n := range scoped {
				if nodeAllowsDockerVolumes(n) {
					allowCount++
				}
			}
			if allowCount == 0 {
				groupMissingSingle = true
				msg := add("Task %q 在 docker volumes 使用了宿主机路径挂载（%s），但可用 Client 节点均未开启「Docker 允许卷挂载」（请先在「Nomad 集群 → 节点插件/配置」开启 volumes）", g.dockerHostBinds[0].task, g.dockerHostBinds[0].src)
				addCheck(PreflightCheck{
					ID:       "docker_volumes",
					Kind:     "docker_volumes",
					Status:   "error",
					Title:    "未开启 Docker 宿主机卷挂载",
					TitleEn:  "Docker host volume mounts disabled",
					Detail:   msg,
					DetailEn: fmt.Sprintf("Task %q bind-mounts host path %s, but docker.volumes.enabled is false on eligible nodes.", g.dockerHostBinds[0].task, g.dockerHostBinds[0].src),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    nomadClusterLink,
						Label:   "前往开启卷挂载",
						LabelEn: "Enable Docker Volumes",
					},
				})
			} else {
				addCheck(PreflightCheck{
					ID:       "docker_volumes",
					Kind:     "docker_volumes",
					Status:   "ok",
					Title:    "Docker 宿主机卷挂载已开启",
					TitleEn:  "Docker host volume mounts enabled",
					Detail:   fmt.Sprintf("%d 个可用 Client 节点允许宿主机路径挂载。", allowCount),
					DetailEn: fmt.Sprintf("Docker host bind mounts enabled on %d eligible Client node(s).", allowCount),
				})
			}
		}

		if len(g.staticPorts) > 0 {
			portStrs := make([]string, len(g.staticPorts))
			var privPorts []string
			for i, p := range g.staticPorts {
				portStrs[i] = strconv.Itoa(p)
				if p == 80 || p == 443 {
					privPorts = append(privPorts, strconv.Itoa(p))
				}
			}
			portsLabel := strings.Join(portStrs, " / ")

			if len(nodeUsedPorts) > 0 {
				freeNodeFound := false
				conflicts := map[string]bool{}
				for _, n := range scoped {
					used, known := nodeUsedPorts[n.ID]
					if !known {
						freeNodeFound = true
						break
					}
					allFree := true
					for _, p := range g.staticPorts {
						if owner := used[p]; owner != "" {
							allFree = false
							conflicts[fmt.Sprintf("%d（被 %s 占用）", p, owner)] = true
						}
					}
					if allFree {
						freeNodeFound = true
						break
					}
				}
				if !freeNodeFound {
					groupMissingSingle = true
					list := make([]string, 0, len(conflicts))
					for c := range conflicts {
						list = append(list, c)
					}
					sort.Strings(list)
					msg := add("任务组 %q 申请的静态端口在所有可用 Client 节点上均已被占用：%s（请先停止冲突任务或更换端口）", g.name, strings.Join(list, "、"))
					addCheck(PreflightCheck{
						ID:       "ports:" + g.name,
						Kind:     "port",
						Status:   "error",
						Title:    fmt.Sprintf("静态端口冲突（%s）", portsLabel),
						TitleEn:  fmt.Sprintf("Static port conflict (%s)", portsLabel),
						Detail:   msg,
						DetailEn: fmt.Sprintf("Static ports %s for group %q are occupied on all eligible nodes.", portsLabel, g.name),
					})
				} else if len(privPorts) > 0 {
					addCheck(PreflightCheck{
						ID:       "ports:" + g.name,
						Kind:     "port",
						Status:   "warning",
						Title:    fmt.Sprintf("静态端口 %s（需确认宿主机未占用）", portsLabel),
						TitleEn:  fmt.Sprintf("Static ports %s (verify host availability)", portsLabel),
						Detail:   fmt.Sprintf("Nomad 任务间无冲突，但映射了宿主机端口 %s，请确保宿主机进程（如 systemd Nginx / Caddy）未占用并放行防火墙。", strings.Join(privPorts, "、")),
						DetailEn: fmt.Sprintf("No Nomad port conflict, but privileged host ports %s are bound; ensure no host daemon occupies them.", strings.Join(privPorts, ", ")),
					})
				} else {
					addCheck(PreflightCheck{
						ID:       "ports:" + g.name,
						Kind:     "port",
						Status:   "ok",
						Title:    fmt.Sprintf("静态端口 %s 可用", portsLabel),
						TitleEn:  fmt.Sprintf("Static ports %s available", portsLabel),
						Detail:   fmt.Sprintf("目标范围存在端口 %s 空闲的可用 Client 节点。", portsLabel),
						DetailEn: fmt.Sprintf("Ports %s are free on at least one eligible Client node.", portsLabel),
					})
				}
			}
		}

		for _, vol := range g.hostVolumes {
			volCount := 0
			for _, n := range scoped {
				if nodeVolumes[n.ID][vol] {
					volCount++
				}
			}
			if volCount == 0 {
				groupMissingSingle = true
				msg := add("任务组 %q 引用了 Host Volume %q，但目标范围的可用 Client 节点均未配置该挂载卷（请先在「Nomad 集群 → 节点插件/配置」添加同名 Host Volume）", g.name, vol)
				addCheck(PreflightCheck{
					ID:       "host_volume:" + vol,
					Kind:     "host_volume",
					Status:   "error",
					Title:    fmt.Sprintf("缺少 Host Volume %q", vol),
					TitleEn:  fmt.Sprintf("Missing Host Volume %q", vol),
					Detail:   msg,
					DetailEn: fmt.Sprintf("Group %q requires Host Volume %q, which is not configured on eligible Client nodes.", g.name, vol),
					FixAction: &PreflightFixAction{
						Type:    "link",
						Path:    nomadClusterLink,
						Label:   "前往配置挂载卷",
						LabelEn: "Configure Host Volume",
					},
				})
			} else {
				addCheck(PreflightCheck{
					ID:       "host_volume:" + vol,
					Kind:     "host_volume",
					Status:   "ok",
					Title:    fmt.Sprintf("Host Volume %q 已就绪", vol),
					TitleEn:  fmt.Sprintf("Host Volume %q ready", vol),
					Detail:   fmt.Sprintf("%d 个可用 Client 节点已配置该挂载卷。", volCount),
					DetailEn: fmt.Sprintf("Host Volume %q is configured on %d eligible Client node(s).", vol, volCount),
				})
			}
		}

		if !groupMissingSingle {
			singleNodeOK := false
			for _, n := range scoped {
				if g.needsBridge && !nodeHasCNI(n) {
					continue
				}
				if len(g.dockerHostBinds) > 0 && !nodeAllowsDockerVolumes(n) {
					continue
				}
				driversOK := true
				for _, dr := range g.drivers {
					if !n.Drivers[dr.driver].Healthy {
						driversOK = false
						break
					}
				}
				if !driversOK {
					continue
				}
				volsOK := true
				for _, vol := range g.hostVolumes {
					if !nodeVolumes[n.ID][vol] {
						volsOK = false
						break
					}
				}
				if !volsOK {
					continue
				}
				if len(g.staticPorts) > 0 {
					if used, known := nodeUsedPorts[n.ID]; known {
						portsOK := true
						for _, p := range g.staticPorts {
							if used[p] != "" {
								portsOK = false
								break
							}
						}
						if !portsOK {
							continue
						}
					}
				}
				singleNodeOK = true
				break
			}
			if !singleNodeOK {
				msg := add("任务组 %q 所需的驱动、网络、端口或存储卷分布在集群中不同节点上，目标范围内没有单个 Client 节点同时满足全部条件", g.name)
				addCheck(PreflightCheck{
					ID:       "placement:" + g.name,
					Kind:     "placement",
					Status:   "error",
					Title:    fmt.Sprintf("任务组 %q 无单节点同时满足全部条件", g.name),
					TitleEn:  fmt.Sprintf("No single node satisfies all requirements for %q", g.name),
					Detail:   msg,
					DetailEn: fmt.Sprintf("Required drivers, network, ports, and volumes for group %q are spread across different nodes.", g.name),
				})
			}
		}
	}

	return finalize()
}

type taskDriverRef struct {
	task   string
	driver string
}

type dockerBindRef struct {
	task string
	src  string
}

type groupRequirements struct {
	name            string
	drivers         []taskDriverRef
	needsBridge     bool
	hostVolumes     []string
	dockerHostBinds []dockerBindRef
	staticPorts     []int
}

func parseGroupRequirements(j Job) []groupRequirements {
	var out []groupRequirements
	for _, tgRaw := range list(j["TaskGroups"]) {
		tg := obj(tgRaw)
		if tg == nil {
			continue
		}
		g := groupRequirements{name: orDefault(str(tg["Name"]), "group")}
		portSeen := map[int]bool{}
		for _, netRaw := range list(tg["Networks"]) {
			netObj := obj(netRaw)
			if netObj == nil {
				continue
			}
			if strings.EqualFold(str(netObj["Mode"]), "bridge") {
				g.needsBridge = true
			}
			for _, rpRaw := range list(netObj["ReservedPorts"]) {
				rp := obj(rpRaw)
				if rp == nil {
					continue
				}
				if v := int(u64(rp["Value"])); v > 0 && !portSeen[v] {
					portSeen[v] = true
					g.staticPorts = append(g.staticPorts, v)
				}
			}
		}
		sort.Ints(g.staticPorts)
		if vols := obj(tg["Volumes"]); vols != nil {
			volSeen := map[string]bool{}
			for _, vRaw := range vols {
				v := obj(vRaw)
				if v == nil || !strings.EqualFold(str(v["Type"]), "host") {
					continue
				}
				src := str(v["Source"])
				if src != "" && !volSeen[src] {
					volSeen[src] = true
					g.hostVolumes = append(g.hostVolumes, src)
				}
			}
			sort.Strings(g.hostVolumes)
		}
		for _, tRaw := range list(tg["Tasks"]) {
			t := obj(tRaw)
			if t == nil {
				continue
			}
			taskName := orDefault(str(t["Name"]), "task")
			drv := str(t["Driver"])
			if drv != "" {
				g.drivers = append(g.drivers, taskDriverRef{
					task:   taskName,
					driver: drv,
				})
			}
			if drv == "docker" {
				if cfg := obj(t["Config"]); cfg != nil {
					for _, vRaw := range list(cfg["volumes"]) {
						s := strings.TrimSpace(str(vRaw))
						if parts := strings.Split(s, ":"); len(parts) >= 2 && strings.HasPrefix(parts[0], "/") {
							g.dockerHostBinds = append(g.dockerHostBinds, dockerBindRef{
								task: taskName,
								src:  parts[0],
							})
						}
					}
				}
			}
		}
		out = append(out, g)
	}
	return out
}

func driverMissingMessage(taskName, driver string, detectedUnhealthy bool) string {
	switch driver {
	case "docker":
		if detectedUnhealthy {
			return fmt.Sprintf("Task %q 使用了 docker 驱动，但目标节点上的 Docker 当前不健康（请检查节点 Docker 服务是否启动，并在「基础设施 → Docker 管理」确认状态）", taskName)
		}
		return fmt.Sprintf("Task %q 使用了 docker 驱动，但当前可用 Client 节点均未安装或未识别到 Docker（请先前往「基础设施 → Docker 管理」为节点安装 Docker）", taskName)
	case "raw_exec":
		return fmt.Sprintf("Task %q 使用了 raw_exec 驱动，但当前可用 Client 节点均未启用该插件（请前往「Nomad 集群 → 节点插件/配置」勾选启用 raw_exec）", taskName)
	default:
		if detectedUnhealthy {
			return fmt.Sprintf("Task %q 使用了 %q 驱动，但目标节点上该驱动当前不健康，无法调度", taskName, driver)
		}
		return fmt.Sprintf("Task %q 使用了 %q 驱动，但当前可用 Client 节点均未启用或未就绪该驱动", taskName, driver)
	}
}

func jobStringList(v any) []string {
	var out []string
	for _, x := range list(v) {
		if s := str(x); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func matchDatacenter(nodeDC string, targetDCs []string) bool {
	if len(targetDCs) == 0 {
		return true
	}
	for _, dc := range targetDCs {
		if dc == "*" || dc == nodeDC {
			return true
		}
	}
	return false
}
