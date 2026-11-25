package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"

	"nomad-deck/internal/auth"
	"nomad-deck/internal/db"
	"nomad-deck/internal/jobspec"
)

func init() {
	// Scaling keeps a visual spec in step: update the group count and
	// re-render.
	SyncSpecCount = func(spec, group string, count int) (string, string, bool) {
		var s jobspec.JobSpec
		if err := json.Unmarshal([]byte(spec), &s); err != nil {
			return "", "", false
		}
		found := false
		for i := range s.Job.Groups {
			if s.Job.Groups[i].Name == group {
				s.Job.Groups[i].Count = itoa(count)
				found = true
			}
		}
		if !found {
			return "", "", false
		}
		h, err := jobspec.Render(&s)
		if err != nil {
			return "", "", false
		}
		b, _ := json.Marshal(s)
		return string(b), h, true
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// RenderResult is a rendered visual spec.
type RenderResult struct {
	HCL             string `json:"hcl"`
	RendererVersion string `json:"renderer_version"`
}

// RenderSpec renders a visual spec to HCL.
func RenderSpec(spec *jobspec.JobSpec) (*RenderResult, error) {
	h, err := jobspec.Render(spec)
	if err != nil {
		return nil, &auth.Error{Status: 400, Code: "render_failed", Message: err.Error()}
	}
	return &RenderResult{HCL: h, RendererVersion: jobspec.RendererVersion}, nil
}

// VisualResult is an HCL or JSON document mapped onto the visual model.
type VisualResult struct {
	Spec     *jobspec.JobSpec `json:"spec"`
	Issues   []jobspec.Issue  `json:"issues"`
	Lossless bool             `json:"lossless"`
	HCL      string           `json:"hcl,omitempty"`
	// SemanticEqual reports whether Nomad parses the original and the
	// re-rendered HCL to the same Job JSON (nil when it could not be checked).
	SemanticEqual *bool  `json:"semantic_equal"`
	SemanticNote  string `json:"semantic_note,omitempty"`
}

// ParseToVisual maps HCL onto the visual model, lists what cannot be kept
// and checks with Nomad that the re-rendered HCL means the same job.
func (s *Service) ParseToVisual(ctx context.Context, clusterID, hcl string, vars map[string]string) (*VisualResult, error) {
	spec, issues, err := jobspec.ParseHCL(hcl)
	if err != nil {
		return nil, &auth.Error{Status: 400, Code: "hcl_invalid", Message: err.Error()}
	}
	res := &VisualResult{Spec: spec, Issues: issues, Lossless: jobspec.Lossless(issues)}
	h, err := jobspec.Render(spec)
	if err != nil {
		res.SemanticNote = "转换后的模型无法渲染：" + err.Error()
		f := false
		res.SemanticEqual = &f
		return res, nil
	}
	res.HCL = h
	c, err := s.api(ctx, clusterID)
	if err != nil {
		res.SemanticNote = "无法连接 Nomad 校验语义：" + err.Error()
		return res, nil
	}
	a, err1 := ParseHCL(ctx, c, hcl, vars)
	b, err2 := ParseHCL(ctx, c, h, vars)
	switch {
	case err1 != nil:
		res.SemanticNote = "Nomad 无法解析原始 HCL（可能缺少变量值）：" + err1.Error()
	case err2 != nil:
		res.SemanticNote = "Nomad 无法解析转换后的 HCL：" + err2.Error()
		f := false
		res.SemanticEqual = &f
	default:
		eq := string(canonical(a)) == string(canonical(b))
		res.SemanticEqual = &eq
		if !eq {
			res.SemanticNote = "Nomad 解析结果不一致，建议保留 HCL 模式"
		}
	}
	return res, nil
}

// JSONToVisual maps a Job JSON document (or a local revision's) onto the
// visual model; JSON cannot carry fragments, so unmapped fields are lost.
func (s *Service) JSONToVisual(ctx context.Context, clusterID string, raw json.RawMessage, revisionID string) (*VisualResult, error) {
	if revisionID != "" {
		rev, err := db.GetRevision(ctx, s.DB.Reader, revisionID)
		if err != nil || rev.ClusterID != clusterID {
			return nil, &auth.Error{Status: 404, Code: "not_found", Message: "版本记录不存在"}
		}
		if raw, err = s.Keys.Decrypt(rev.JobJSONEncrypted, db.JobJSONAAD(rev.ID)); err != nil {
			return nil, err
		}
	}
	var j map[string]any
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, badRequest("Job JSON 格式不正确：%v", err)
	}
	if inner, ok := j["Job"].(map[string]any); ok && j["ID"] == nil {
		j = inner
	}
	spec, issues := jobspec.FromJob(j)
	res := &VisualResult{Spec: spec, Issues: issues, Lossless: jobspec.Lossless(issues)}
	if h, err := jobspec.Render(spec); err == nil {
		res.HCL = h
	} else {
		res.SemanticNote = "映射后的模型无法渲染：" + err.Error()
	}
	return res, nil
}

// BuilderOptions feed the dropdowns of the visual builder.
type BuilderOptions struct {
	Namespaces  []string `json:"namespaces"`
	NodePools   []string `json:"node_pools"`
	Datacenters []string `json:"datacenters"`
	// HostVolumes maps host volume names to the clients that offer them.
	HostVolumes map[string][]string `json:"host_volumes"`
	Drivers     []string            `json:"drivers"`
}

// Options lists namespaces, node pools, datacenters, client host volumes
// and healthy drivers of a cluster.
func (s *Service) Options(ctx context.Context, clusterID string) (*BuilderOptions, error) {
	c, err := s.api(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	o := &BuilderOptions{Namespaces: []string{}, NodePools: []string{}, Datacenters: []string{}, HostVolumes: map[string][]string{},
		Drivers: []string{}}
	var nss []struct {
		Name string `json:"Name"`
	}
	_ = c.Request(ctx, http.MethodGet, "namespaces", nil, &nss)
	for _, n := range nss {
		o.Namespaces = append(o.Namespaces, n.Name)
	}
	var pools []struct {
		Name string `json:"Name"`
	}
	_ = c.Request(ctx, http.MethodGet, "node/pools", nil, &pools)
	for _, p := range pools {
		if p.Name != "all" {
			o.NodePools = append(o.NodePools, p.Name)
		}
	}
	nodes, _ := c.Nodes(ctx)
	dcs, drivers := map[string]bool{}, map[string]bool{}
	for _, n := range nodes {
		dcs[n.Datacenter] = true
		var d struct {
			HostVolumes map[string]any `json:"HostVolumes"`
			Drivers     map[string]struct {
				Healthy bool `json:"Healthy"`
			} `json:"Drivers"`
		}
		if err := c.Request(ctx, http.MethodGet, "node/"+url.PathEscape(n.ID), nil, &d); err == nil {
			for v := range d.HostVolumes {
				o.HostVolumes[v] = append(o.HostVolumes[v], n.Name)
			}
			for name, dr := range d.Drivers {
				if dr.Healthy {
					drivers[name] = true
				}
			}
		}
	}
	for k := range dcs {
		o.Datacenters = append(o.Datacenters, k)
	}
	for k := range drivers {
		o.Drivers = append(o.Drivers, k)
	}
	sort.Strings(o.Datacenters)
	sort.Strings(o.Drivers)
	return o, nil
}
