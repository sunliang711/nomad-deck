package jobspec

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ComposeIssue is a conversion finding. Blocking issues must be fixed in
// the form or the HCL before the job can be submitted.
type ComposeIssue struct {
	Service  string `json:"service,omitempty"`
	Severity string `json:"severity"` // block | warn
	Message  string `json:"message"`
}

// VolumeBinding binds a Compose named volume to a Nomad host or CSI volume.
type VolumeBinding struct {
	Type   string `json:"type"` // host | csi
	Source string `json:"source"`
}

// ComposeOptions control a conversion.
type ComposeOptions struct {
	JobID          string                   `json:"job_id"`
	Namespace      string                   `json:"namespace"`
	Datacenters    []string                 `json:"datacenters"`
	VolumeBindings map[string]VolumeBinding `json:"volume_bindings"`
}

// ComposeResult is a converted job.
type ComposeResult struct {
	Spec     *JobSpec       `json:"spec"`
	HCL      string         `json:"hcl,omitempty"`
	Issues   []ComposeIssue `json:"issues"`
	Blocking bool           `json:"blocking"`
	// NamedVolumes lists the named volumes that need a binding.
	NamedVolumes []string `json:"named_volumes"`
}

var (
	reGroupName = regexp.MustCompile(`[^A-Za-z0-9_-]`)
	reMemory    = regexp.MustCompile(`^([0-9.]+)\s*([kKmMgG]?)[bB]?$`)
)

func ident(s string) string {
	s = reGroupName.ReplaceAllString(s, "-")
	if s == "" || !reIdent.MatchString(s) {
		s = "s-" + s
	}
	return s
}

// ConvertCompose converts a docker-compose document into a visual spec and
// HCL. Each service becomes a group with one docker task.
func ConvertCompose(src []byte, opt ComposeOptions) (*ComposeResult, error) {
	var root map[string]yaml.Node
	if err := yaml.Unmarshal(src, &root); err != nil {
		return nil, fmt.Errorf("YAML 解析失败：%v", err)
	}
	svcNode, ok := root["services"]
	if !ok || svcNode.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("Compose 文件中没有 services")
	}
	res := &ComposeResult{Issues: []ComposeIssue{}, NamedVolumes: []string{}}
	add := func(svc, sev, format string, args ...any) {
		res.Issues = append(res.Issues, ComposeIssue{Service: svc, Severity: sev, Message: fmt.Sprintf(format, args...)})
		if sev == "block" {
			res.Blocking = true
		}
	}
	for _, k := range []string{"secrets", "configs"} {
		if _, ok := root[k]; ok {
			add("", "block", "顶层 %s 没有 Nomad 原生等价物，请改用 Vault/Variables 与 template 块后再提交", k)
		}
	}
	if _, ok := root["networks"]; ok {
		add("", "warn", "顶层 networks 不会转换，服务间通信请使用 Nomad 服务发现")
	}
	declared := map[string]bool{}
	if v, ok := root["volumes"]; ok && v.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(v.Content); i += 2 {
			declared[v.Content[i].Value] = true
		}
	}
	if opt.JobID == "" {
		opt.JobID = "compose"
	}
	spec := &JobSpec{Job: Job{ID: opt.JobID, Namespace: opt.Namespace, Type: "service", Datacenters: opt.Datacenters}}
	if len(spec.Job.Datacenters) == 0 {
		spec.Job.Datacenters = []string{"*"}
	}
	named := map[string]bool{}
	for i := 0; i+1 < len(svcNode.Content); i += 2 {
		name := svcNode.Content[i].Value
		var raw map[string]yaml.Node
		if err := svcNode.Content[i+1].Decode(&raw); err != nil {
			add(name, "block", "服务定义无法解析：%v", err)
			continue
		}
		g := Group{Name: ident(name), Count: "1"}
		t := Task{Name: ident(name), Driver: "docker", Resources: &Resources{CPU: "100", Memory: "128"}}
		str := func(k string) string {
			n, ok := raw[k]
			if !ok {
				return ""
			}
			return n.Value
		}
		t.Config.Image = str("image")
		if _, ok := raw["build"]; ok && t.Config.Image == "" {
			add(name, "block", "只有 build 没有 image，Nomad 不构建镜像，请先构建并推送镜像后填写 image")
		} else if _, ok := raw["build"]; ok {
			add(name, "warn", "忽略 build，使用 image %s", t.Config.Image)
		}
		if n, ok := raw["command"]; ok {
			parts := words(n)
			if len(parts) > 0 {
				t.Config.Command, t.Config.Args = parts[0], parts[1:]
			}
		}
		if _, ok := raw["entrypoint"]; ok {
			add(name, "warn", "entrypoint 未转换，请在附加 HCL 片段的 config 中设置或改写 command")
		}
		if n, ok := raw["environment"]; ok {
			for _, kv := range envOf(n) {
				if !reIdent.MatchString(kv.Key) {
					add(name, "warn", "环境变量 %s 不是合法的 HCL 标识符，已跳过", kv.Key)
					continue
				}
				t.Env = append(t.Env, kv)
			}
		}
		if n, ok := raw["privileged"]; ok && n.Value == "true" {
			t.Config.Privileged = "true"
		}
		replicas := 1
		if d, ok := raw["deploy"]; ok {
			var dep struct {
				Replicas  *int `yaml:"replicas"`
				Resources struct {
					Limits struct {
						CPUs   string `yaml:"cpus"`
						Memory string `yaml:"memory"`
					} `yaml:"limits"`
				} `yaml:"resources"`
			}
			if err := d.Decode(&dep); err == nil {
				if dep.Replicas != nil {
					replicas = *dep.Replicas
					g.Count = strconv.Itoa(replicas)
				}
				if c := dep.Resources.Limits.CPUs; c != "" {
					if f, err := strconv.ParseFloat(c, 64); err == nil {
						t.Resources.CPU = strconv.Itoa(int(f * 1000))
						add(name, "warn", "cpus=%s 按每核 1000 MHz 折算为 cpu=%s，请按节点实际主频调整", c, t.Resources.CPU)
					}
				}
				if mem := dep.Resources.Limits.Memory; mem != "" {
					if mb, ok := memMB(mem); ok {
						t.Resources.Memory = strconv.Itoa(mb)
					}
				}
			}
		}
		// Ports.
		if n, ok := raw["ports"]; ok && n.Kind == yaml.SequenceNode {
			net := &Network{Mode: "bridge"}
			static := false
			usedLabels := map[string]bool{}
			for _, p := range n.Content {
				pt, isStatic, err := portOf(p)
				if err != nil {
					add(name, "warn", "端口 %s 无法转换：%v", p.Value, err)
					continue
				}
				base := pt.Label
				if usedLabels[pt.Label] {
					for suffix := 2; ; suffix++ {
						cand := base + "_" + strconv.Itoa(suffix)
						if !usedLabels[cand] {
							pt.Label = cand
							break
						}
					}
				}
				usedLabels[pt.Label] = true
				static = static || isStatic
				net.Ports = append(net.Ports, pt)
				t.Config.Ports = append(t.Config.Ports, pt.Label)
			}
			if len(net.Ports) > 0 {
				g.Network = net
			}
			if static && replicas > 1 {
				add(name, "warn", "replicas=%d 且使用静态宿主端口，同一节点只能放置一个实例，可能出现端口冲突", replicas)
			}
		}
		// Volumes.
		if n, ok := raw["volumes"]; ok && n.Kind == yaml.SequenceNode {
			for _, v := range n.Content {
				src, dst, ro, typ := volumeOf(v)
				switch {
				case dst == "":
					add(name, "warn", "卷 %s 无法解析", v.Value)
				case typ == "anonymous":
					add(name, "warn", "匿名卷 %s 未转换（Nomad 中等同于 Task 临时目录）", dst)
				case typ == "bind" || strings.HasPrefix(src, "/") || strings.HasPrefix(src, "."):
					if strings.HasPrefix(src, ".") {
						add(name, "warn", "相对路径 %s 在 Nomad 中相对于 Task 目录，请确认", src)
					}
					t.Config.Mounts = append(t.Config.Mounts, Mount{Type: "bind", Source: src, Target: dst, Readonly: boolString(ro)})
				default:
					named[src] = true
					if !declared[src] {
						add(name, "warn", "命名卷 %s 未在顶层 volumes 中声明", src)
					}
					b, ok := opt.VolumeBindings[src]
					if !ok || (b.Type != "host" && b.Type != "csi") || b.Source == "" {
						add(name, "block", "命名卷 %s 需要绑定到目标 Host Volume 或 CSI 卷（不能降级为节点临时目录）", src)
						continue
					}
					vname := ident(src)
					found := false
					for _, gv := range g.Volumes {
						found = found || gv.Name == vname
					}
					if !found {
						vol := Volume{Name: vname, Type: b.Type, Source: b.Source, ReadOnly: boolString(ro)}
						if b.Type == "csi" {
							vol.AccessMode, vol.AttachmentMode = "single-node-writer", "file-system"
						}
						g.Volumes = append(g.Volumes, vol)
					}
					t.VolumeMounts = append(t.VolumeMounts, VolumeMount{Volume: vname, Destination: dst, ReadOnly: boolString(ro)})
				}
			}
		}
		for _, k := range []string{"secrets", "configs"} {
			if _, ok := raw[k]; ok {
				add(name, "block", "%s 没有 Nomad 原生等价物，请改用 Vault/Variables 与 template 块", k)
			}
		}
		for _, k := range []string{"depends_on", "healthcheck", "networks", "profiles"} {
			if _, ok := raw[k]; ok {
				add(name, "warn", "%s 未转换（Nomad 没有直接等价物，%s）", k, map[string]string{
					"depends_on": "启动顺序可用 lifecycle prestart 任务实现", "healthcheck": "请在 service 中配置 check",
					"networks": "服务间通信请使用服务发现", "profiles": "按需拆分为不同 Job"}[k])
			}
		}
		known := map[string]bool{"image": true, "build": true, "command": true, "entrypoint": true, "environment": true, "ports": true,
			"volumes": true, "deploy": true, "privileged": true, "secrets": true, "configs": true, "depends_on": true,
			"healthcheck": true, "networks": true, "profiles": true, "container_name": true}
		var unknown []string
		for k := range raw {
			if !known[k] {
				unknown = append(unknown, k)
			}
		}
		sort.Strings(unknown)
		if len(unknown) > 0 {
			add(name, "warn", "以下字段未转换：%s", strings.Join(unknown, "、"))
		}
		g.Tasks = []Task{t}
		spec.Job.Groups = append(spec.Job.Groups, g)
	}
	for k := range named {
		res.NamedVolumes = append(res.NamedVolumes, k)
	}
	sort.Strings(res.NamedVolumes)
	sort.Slice(spec.Job.Groups, func(i, j int) bool { return spec.Job.Groups[i].Name < spec.Job.Groups[j].Name })
	res.Spec = spec
	if !res.Blocking {
		h, err := Render(spec)
		if err != nil {
			res.Blocking = true
			res.Issues = append(res.Issues, ComposeIssue{Severity: "block", Message: err.Error()})
		} else {
			res.HCL = h
		}
	}
	return res, nil
}

func boolString(b bool) string {
	if b {
		return "true"
	}
	return ""
}

func words(n yaml.Node) []string {
	switch n.Kind {
	case yaml.SequenceNode:
		var out []string
		for _, c := range n.Content {
			out = append(out, c.Value)
		}
		return out
	case yaml.ScalarNode:
		return strings.Fields(n.Value)
	}
	return nil
}

func envOf(n yaml.Node) []KV {
	var out []KV
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			out = append(out, KV{Key: n.Content[i].Value, Value: n.Content[i+1].Value})
		}
	case yaml.SequenceNode:
		for _, c := range n.Content {
			k, v, _ := strings.Cut(c.Value, "=")
			out = append(out, KV{Key: k, Value: v})
		}
	}
	return out
}

func memMB(s string) (int, bool) {
	m := reMemory.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	switch strings.ToLower(m[2]) {
	case "k":
		f /= 1024
	case "g":
		f *= 1024
	case "":
		f /= 1024 * 1024
	}
	if f < 1 {
		f = 1
	}
	return int(f), true
}

// portOf maps "8080:80", "80", "127.0.0.1:8080:80/tcp" or the long syntax.
func portOf(n *yaml.Node) (Port, bool, error) {
	var target, published string
	if n.Kind == yaml.MappingNode {
		var p struct {
			Target    int    `yaml:"target"`
			Published string `yaml:"published"`
		}
		if err := n.Decode(&p); err != nil || p.Target == 0 {
			return Port{}, false, fmt.Errorf("缺少 target")
		}
		target, published = strconv.Itoa(p.Target), p.Published
	} else {
		spec, _, _ := strings.Cut(n.Value, "/")
		parts := strings.Split(spec, ":")
		target = parts[len(parts)-1]
		if len(parts) >= 2 {
			published = parts[len(parts)-2]
		}
	}
	if strings.Contains(target, "-") || strings.Contains(published, "-") {
		return Port{}, false, fmt.Errorf("不支持端口范围")
	}
	if _, err := strconv.Atoi(target); err != nil {
		return Port{}, false, fmt.Errorf("端口 %q 不合法", target)
	}
	pt := Port{Label: "p" + target, To: target}
	if published != "" {
		if _, err := strconv.Atoi(published); err != nil {
			return Port{}, false, fmt.Errorf("宿主端口 %q 不合法", published)
		}
		pt.Static = published
		return pt, true, nil
	}
	return pt, false, nil
}

func volumeOf(n *yaml.Node) (src, dst string, ro bool, typ string) {
	if n.Kind == yaml.MappingNode {
		var v struct {
			Type     string `yaml:"type"`
			Source   string `yaml:"source"`
			Target   string `yaml:"target"`
			ReadOnly bool   `yaml:"read_only"`
		}
		_ = n.Decode(&v)
		return v.Source, v.Target, v.ReadOnly, v.Type
	}
	parts := strings.Split(n.Value, ":")
	switch len(parts) {
	case 1:
		return "", parts[0], false, "anonymous"
	case 2:
		return parts[0], parts[1], false, ""
	default:
		return parts[0], parts[1], strings.Contains(parts[2], "ro"), ""
	}
}
