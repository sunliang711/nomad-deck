package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
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
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil
	}
	return s.Preflight(ctx, c, clusterID, j)
}

// Preflight inspects cluster namespaces, node pools, eligible Client nodes,
// task drivers, CNI configuration, and host volumes against the Job definition.
func (s *Service) Preflight(ctx context.Context, c *nomad.Client, clusterID string, j Job) []string {
	if j == nil {
		return nil
	}
	if stop, _ := j["Stop"].(bool); stop {
		return nil
	}

	var issues []string
	seen := map[string]bool{}
	add := func(format string, args ...any) {
		msg := fmt.Sprintf(format, args...)
		if !seen[msg] {
			seen[msg] = true
			issues = append(issues, msg)
		}
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
			add("命名空间 %q 在当前 Nomad 集群中不存在（请先前往「Nomad 集群 → 治理」创建）", jobNS)
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
				add("Node Pool %q 在当前 Nomad 集群中不存在（请先前往「Nomad 集群 → 治理」创建）", jobPool)
			}
		}
	}

	nodes, err := c.Nodes(ctx)
	if err != nil {
		return issues
	}
	if len(nodes) == 0 {
		add("当前 Nomad 集群没有 Client 节点（纯 Server 集群无法运行任务，请先扩容 Client 或 Server+Client 节点）")
		return issues
	}

	var eligible []nomad.NodeStub
	for _, n := range nodes {
		if n.Status == "ready" && n.SchedulingEligibility == "eligible" && !n.Drain {
			eligible = append(eligible, n)
		}
	}
	if len(eligible) == 0 {
		add("当前集群共有 %d 个 Client 节点，但均处于下线、维护排空或不可调度状态，任务无法调度", len(nodes))
		return issues
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
		add("在目标 Datacenter（%s）和 Node Pool（%s）范围内没有就绪且可调度的 Client 节点", dcLabel, jobPool)
		return issues
	}

	groups := parseGroupRequirements(j)
	needVolumes := false
	needBridge := false
	for _, g := range groups {
		if len(g.hostVolumes) > 0 {
			needVolumes = true
		}
		if g.needsBridge {
			needBridge = true
		}
	}

	nodeVolumes := map[string]map[string]bool{}
	if needVolumes {
		for _, n := range scoped {
			nd, nerr := c.Node(ctx, n.ID)
			if nerr != nil || nd == nil {
				continue
			}
			vols := map[string]bool{}
			for vname := range nd.HostVolumes {
				vols[vname] = true
			}
			nodeVolumes[n.ID] = vols
		}
	}

	var cniByNodeID, cniByNodeName map[string]bool
	hasManagedMembers := false
	if needBridge && s.DB != nil {
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
				}
				if mc.NodeName != "" {
					cniByNodeName[mc.NodeName] = mc.CNI
				}
				if m.NodeName != "" {
					cniByNodeName[m.NodeName] = mc.CNI
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

	for _, g := range groups {
		groupMissingSingle := false

		for _, dr := range g.drivers {
			healthyFound := false
			detectedUnhealthy := false
			for _, n := range scoped {
				info, ok := n.Drivers[dr.driver]
				if !ok {
					continue
				}
				if info.Healthy {
					healthyFound = true
					break
				}
				if info.Detected {
					detectedUnhealthy = true
				}
			}
			if !healthyFound {
				groupMissingSingle = true
				add("%s", driverMissingMessage(dr.task, dr.driver, detectedUnhealthy))
			}
		}

		if g.needsBridge && hasManagedMembers {
			cniFound := false
			for _, n := range scoped {
				if nodeHasCNI(n) {
					cniFound = true
					break
				}
			}
			if !cniFound {
				groupMissingSingle = true
				add("任务组 %q 使用了 bridge 网络模式，但目标范围内的 Client 节点尚未启用 CNI 插件（请先在「Nomad 集群 → 集群配置」选择 CNI 版本并在「节点插件/配置」启用 CNI）", g.name)
			}
		}

		for _, vol := range g.hostVolumes {
			volFound := false
			for _, n := range scoped {
				if nodeVolumes[n.ID][vol] {
					volFound = true
					break
				}
			}
			if !volFound {
				groupMissingSingle = true
				add("任务组 %q 引用了 Host Volume %q，但目标范围的可用 Client 节点均未配置该挂载卷（请先在「Nomad 集群 → 节点插件/配置」添加同名 Host Volume）", g.name, vol)
			}
		}

		if !groupMissingSingle {
			singleNodeOK := false
			for _, n := range scoped {
				if g.needsBridge && !nodeHasCNI(n) {
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
				if volsOK {
					singleNodeOK = true
					break
				}
			}
			if !singleNodeOK {
				add("任务组 %q 所需的驱动、网络或 Host Volume 分布在集群中不同节点上，目标范围内没有单个 Client 节点同时满足全部条件", g.name)
			}
		}
	}

	return issues
}

type taskDriverRef struct {
	task   string
	driver string
}

type groupRequirements struct {
	name        string
	drivers     []taskDriverRef
	needsBridge bool
	hostVolumes []string
}

func parseGroupRequirements(j Job) []groupRequirements {
	var out []groupRequirements
	for _, tgRaw := range list(j["TaskGroups"]) {
		tg := obj(tgRaw)
		if tg == nil {
			continue
		}
		g := groupRequirements{name: orDefault(str(tg["Name"]), "group")}
		for _, netRaw := range list(tg["Networks"]) {
			if strings.EqualFold(str(obj(netRaw)["Mode"]), "bridge") {
				g.needsBridge = true
				break
			}
		}
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
			drv := str(t["Driver"])
			if drv == "" {
				continue
			}
			g.drivers = append(g.drivers, taskDriverRef{
				task:   orDefault(str(t["Name"]), "task"),
				driver: drv,
			})
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
