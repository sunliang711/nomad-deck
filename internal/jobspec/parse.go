package jobspec

import (
	"fmt"
	"math/big"
	"sort"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// Issue is something of the source that the visual model does not keep
// as-is. Preserved issues were moved verbatim into the fragment of their
// level; the others are lost when converting.
type Issue struct {
	Line      int    `json:"line,omitempty"`
	Path      string `json:"path"`
	Kind      string `json:"kind"` // comment | locals | dynamic | expression | unsupported
	Message   string `json:"message"`
	Preserved bool   `json:"preserved"`
}

// Lossless reports whether converting loses nothing.
func Lossless(issues []Issue) bool {
	for _, i := range issues {
		if !i.Preserved {
			return false
		}
	}
	return true
}

type parser struct {
	src    []byte
	issues []Issue
}

func (p *parser) issue(rng hcl.Range, path, kind, msg string, preserved bool) {
	p.issues = append(p.issues, Issue{Line: rng.Start.Line, Path: path, Kind: kind, Message: msg, Preserved: preserved})
}

func (p *parser) text(rng hcl.Range) string { return string(rng.SliceBytes(p.src)) }

// value turns an expression into the model's string form: literals,
// var.<name> references, templates mixing literal text with ${var.<name>}
// and runtime ${...} references (kept as literal text).
func (p *parser) value(e hclsyntax.Expression) (string, bool) {
	switch x := e.(type) {
	case *hclsyntax.LiteralValueExpr:
		return ctyString(x.Val)
	case *hclsyntax.ScopeTraversalExpr:
		if len(x.Traversal) == 2 && x.Traversal.RootName() == "var" {
			if a, ok := x.Traversal[1].(hcl.TraverseAttr); ok {
				return "var." + a.Name, true
			}
		}
		return "", false
	case *hclsyntax.TemplateWrapExpr:
		if t, ok := x.Wrapped.(*hclsyntax.ScopeTraversalExpr); ok {
			if v, ok := p.value(t); ok {
				return v, true // "${var.x}" is var.x
			}
			return "${" + p.text(t.SrcRange) + "}", true
		}
		return "", false
	case *hclsyntax.TemplateExpr:
		var b strings.Builder
		for _, part := range x.Parts {
			switch pt := part.(type) {
			case *hclsyntax.LiteralValueExpr:
				s, ok := ctyString(pt.Val)
				if !ok {
					return "", false
				}
				b.WriteString(s)
			case *hclsyntax.ScopeTraversalExpr:
				b.WriteString("${" + p.text(pt.SrcRange) + "}")
			default:
				return "", false
			}
		}
		return b.String(), true
	}
	return "", false
}

func (p *parser) list(e hclsyntax.Expression) ([]string, bool) {
	t, ok := e.(*hclsyntax.TupleConsExpr)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, el := range t.Exprs {
		v, ok := p.value(el)
		if !ok {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}

func ctyString(v cty.Value) (string, bool) {
	if !v.IsKnown() || v.IsNull() {
		return "", false
	}
	switch v.Type() {
	case cty.String:
		return v.AsString(), true
	case cty.Number:
		bf := v.AsBigFloat()
		if bf.IsInt() {
			i, _ := bf.Int(nil)
			return i.String(), true
		}
		return bf.Text('g', -1), true
	case cty.Bool:
		if v.True() {
			return "true", true
		}
		return "false", true
	}
	return "", false
}

var _ = big.NewInt

// block reads one block: scalar and list attributes into fields, nested
// blocks through handlers; leftovers go to the fragment (when the block
// has one) or become issues.
type block struct {
	p      *parser
	b      *hclsyntax.Body
	path   string
	used   map[string]bool
	usedB  map[*hclsyntax.Block]bool
	extra  *string // fragment of this level, nil inside managed blocks
	parent string
}

func (p *parser) open(b *hclsyntax.Body, path string, extra *string) *block {
	return &block{p: p, b: b, path: path, used: map[string]bool{}, usedB: map[*hclsyntax.Block]bool{}, extra: extra}
}

func (k *block) str(name string, dst *string) {
	a, ok := k.b.Attributes[name]
	if !ok {
		return
	}
	if v, ok := k.p.value(a.Expr); ok {
		*dst = v
		k.used[name] = true
	}
}

func (k *block) strs(name string, dst *[]string) {
	a, ok := k.b.Attributes[name]
	if !ok {
		return
	}
	if v, ok := k.p.list(a.Expr); ok {
		*dst = v
		k.used[name] = true
	}
}

func (k *block) kv(name string, dst *[]KV) {
	if a, ok := k.b.Attributes[name]; ok {
		if obj, ok := a.Expr.(*hclsyntax.ObjectConsExpr); ok {
			var out []KV
			for _, it := range obj.Items {
				key, ok1 := k.p.objKey(it.KeyExpr)
				val, ok2 := k.p.value(it.ValueExpr)
				if !ok1 || !ok2 {
					return
				}
				out = append(out, KV{Key: key, Value: val})
			}
			*dst = out
			k.used[name] = true
		}
		return
	}
	for _, b := range k.b.Blocks {
		if b.Type != name || len(b.Labels) > 0 {
			continue
		}
		var out []KV
		names := make([]string, 0, len(b.Body.Attributes))
		for n := range b.Body.Attributes {
			names = append(names, n)
		}
		sort.Slice(names, func(i, j int) bool {
			return b.Body.Attributes[names[i]].SrcRange.Start.Byte < b.Body.Attributes[names[j]].SrcRange.Start.Byte
		})
		for _, n := range names {
			v, ok := k.p.value(b.Body.Attributes[n].Expr)
			if !ok {
				return
			}
			out = append(out, KV{Key: n, Value: v})
		}
		if len(b.Body.Blocks) > 0 {
			return
		}
		*dst = out
		k.usedB[b] = true
		return
	}
}

func (p *parser) objKey(e hclsyntax.Expression) (string, bool) {
	if w, ok := e.(*hclsyntax.ObjectConsKeyExpr); ok {
		if t, ok := w.Wrapped.(*hclsyntax.ScopeTraversalExpr); ok && len(t.Traversal) == 1 {
			return t.Traversal.RootName(), true
		}
		return p.value(w.Wrapped)
	}
	return p.value(e)
}

// blocks returns unconsumed nested blocks of a type and marks them used.
func (k *block) blocks(typ string) []*hclsyntax.Block {
	var out []*hclsyntax.Block
	for _, b := range k.b.Blocks {
		if b.Type == typ && !k.usedB[b] {
			out = append(out, b)
			k.usedB[b] = true
		}
	}
	return out
}

func (k *block) one(typ string) *hclsyntax.Block {
	bs := k.blocks(typ)
	if len(bs) == 0 {
		return nil
	}
	for _, b := range bs[1:] {
		k.usedB[b] = false
	}
	return bs[0]
}

// finish moves leftovers to the fragment (or reports them).
func (k *block) finish() {
	names := make([]string, 0)
	for n := range k.b.Attributes {
		if !k.used[n] {
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return k.b.Attributes[names[i]].SrcRange.Start.Byte < k.b.Attributes[names[j]].SrcRange.Start.Byte
	})
	for _, n := range names {
		a := k.b.Attributes[n]
		if k.extra != nil {
			*k.extra += k.p.text(a.SrcRange) + "\n"
			k.p.issue(a.SrcRange, k.path+"."+n, "expression", "属性 "+n+" 无法映射为表单字段，原样保留在附加 HCL 片段中", true)
		} else {
			k.p.issue(a.SrcRange, k.path+"."+n, "unsupported", "属性 "+n+" 位于表单托管的块内，无法保留", false)
		}
	}
	for _, b := range k.b.Blocks {
		if k.usedB[b] {
			continue
		}
		kind := "unsupported"
		if b.Type == "dynamic" {
			kind = "dynamic"
		}
		if k.extra != nil {
			*k.extra += k.p.text(b.Range()) + "\n"
			k.p.issue(b.Range(), k.path+"."+b.Type, kind, b.Type+" 块原样保留在附加 HCL 片段中", true)
		} else {
			k.p.issue(b.Range(), k.path+"."+b.Type, kind, b.Type+" 块位于表单托管的块内，无法保留", false)
		}
	}
}

// ParseHCL maps an HCL job file onto the visual model and lists what
// cannot be kept. Comments and locals are always reported (lost).
func ParseHCL(src string) (*JobSpec, []Issue, error) {
	file, diags := hclsyntax.ParseConfig([]byte(src), "job.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		return nil, nil, fmt.Errorf("HCL 语法错误：%s", diags.Error())
	}
	p := &parser{src: []byte(src)}
	tokens, _ := hclsyntax.LexConfig([]byte(src), "job.hcl", hcl.InitialPos)
	for _, t := range tokens {
		if t.Type == hclsyntax.TokenComment {
			p.issue(t.Range, "", "comment", "注释无法保留", false)
		}
	}
	body := file.Body.(*hclsyntax.Body)
	spec := &JobSpec{}
	for name, a := range body.Attributes {
		p.issue(a.SrcRange, name, "unsupported", "顶层属性无法保留", false)
	}
	jobs := 0
	for _, b := range body.Blocks {
		switch b.Type {
		case "variable":
			if len(b.Labels) != 1 {
				continue
			}
			p.variable(b, spec)
		case "job":
			jobs++
			if jobs == 1 && len(b.Labels) == 1 {
				p.job(b, spec)
			}
		case "locals":
			p.issue(b.Range(), "locals", "locals", "locals 块无法保留（可视化模型不支持局部值）", false)
		default:
			p.issue(b.Range(), b.Type, "unsupported", "顶层 "+b.Type+" 块无法保留", false)
		}
	}
	if jobs != 1 {
		return nil, nil, fmt.Errorf("文件中需要且只能有一个 job 块")
	}
	sort.SliceStable(p.issues, func(i, j int) bool { return p.issues[i].Line < p.issues[j].Line })
	if p.issues == nil {
		p.issues = []Issue{}
	}
	return spec, p.issues, nil
}

func (p *parser) variable(b *hclsyntax.Block, spec *JobSpec) {
	v := Variable{Name: b.Labels[0]}
	path := "variable[" + v.Name + "]"
	for name, a := range b.Body.Attributes {
		switch name {
		case "type":
			v.Type = strings.TrimSpace(p.text(a.Expr.Range()))
			if !reVarType.MatchString(v.Type) {
				p.issue(a.SrcRange, path+".type", "unsupported", "变量类型 "+v.Type+" 不受可视化模型支持", false)
			}
		case "default":
			v.HasDefault = true
			if s, ok := p.value(a.Expr); ok {
				v.Default = s
			} else {
				v.Default = strings.TrimSpace(p.text(a.Expr.Range()))
			}
		case "description":
			v.Description, _ = p.value(a.Expr)
		default:
			p.issue(a.SrcRange, path+"."+name, "unsupported", "变量属性 "+name+" 无法保留", false)
		}
	}
	for _, nb := range b.Body.Blocks {
		p.issue(nb.Range(), path+"."+nb.Type, "unsupported", "变量中的 "+nb.Type+" 块无法保留", false)
	}
	spec.Variables = append(spec.Variables, v)
}

func (p *parser) constraints(k *block) []Constraint {
	var out []Constraint
	for _, b := range k.blocks("constraint") {
		c := Constraint{}
		ck := p.open(b.Body, k.path+".constraint", nil)
		ck.str("attribute", &c.Attribute)
		ck.str("operator", &c.Operator)
		ck.str("value", &c.Value)
		ck.finish()
		out = append(out, c)
	}
	return out
}

func (p *parser) update(k *block) *Update {
	b := k.one("update")
	if b == nil {
		return nil
	}
	u := &Update{}
	uk := p.open(b.Body, k.path+".update", nil)
	uk.str("max_parallel", &u.MaxParallel)
	uk.str("health_check", &u.HealthCheck)
	uk.str("min_healthy_time", &u.MinHealthyTime)
	uk.str("healthy_deadline", &u.HealthyDeadline)
	uk.str("progress_deadline", &u.ProgressDeadline)
	uk.str("auto_revert", &u.AutoRevert)
	uk.str("auto_promote", &u.AutoPromote)
	uk.str("canary", &u.Canary)
	uk.str("stagger", &u.Stagger)
	uk.finish()
	return u
}

func (p *parser) restart(k *block) *Restart {
	b := k.one("restart")
	if b == nil {
		return nil
	}
	r := &Restart{}
	rk := p.open(b.Body, k.path+".restart", nil)
	rk.str("attempts", &r.Attempts)
	rk.str("interval", &r.Interval)
	rk.str("delay", &r.Delay)
	rk.str("mode", &r.Mode)
	rk.finish()
	return r
}

func (p *parser) services(k *block) []Service {
	var out []Service
	for _, b := range k.blocks("service") {
		s := Service{}
		sk := p.open(b.Body, k.path+".service", nil)
		sk.str("name", &s.Name)
		sk.str("port", &s.Port)
		sk.str("provider", &s.Provider)
		sk.str("address_mode", &s.AddressMode)
		sk.strs("tags", &s.Tags)
		for _, cb := range sk.blocks("check") {
			c := Check{}
			ck := p.open(cb.Body, sk.path+".check", nil)
			ck.str("name", &c.Name)
			ck.str("type", &c.Type)
			ck.str("path", &c.Path)
			ck.str("port", &c.Port)
			ck.str("interval", &c.Interval)
			ck.str("timeout", &c.Timeout)
			ck.finish()
			s.Checks = append(s.Checks, c)
		}
		sk.finish()
		out = append(out, s)
	}
	return out
}

func (p *parser) job(b *hclsyntax.Block, spec *JobSpec) {
	j := &spec.Job
	j.ID = b.Labels[0]
	k := p.open(b.Body, "job", &j.Extra)
	k.str("namespace", &j.Namespace)
	k.str("region", &j.Region)
	k.str("node_pool", &j.NodePool)
	k.str("type", &j.Type)
	k.strs("datacenters", &j.Datacenters)
	k.str("priority", &j.Priority)
	k.kv("meta", &j.Meta)
	j.Constraints = p.constraints(k)
	if pb := k.one("periodic"); pb != nil {
		pr := &Periodic{}
		pk := p.open(pb.Body, "job.periodic", nil)
		pk.strs("crons", &pr.Crons)
		if len(pr.Crons) == 0 {
			var cron string
			pk.str("cron", &cron)
			if cron != "" {
				pr.Crons = []string{cron}
			}
		}
		pk.str("prohibit_overlap", &pr.ProhibitOverlap)
		pk.str("time_zone", &pr.TimeZone)
		pk.str("enabled", &pr.Enabled)
		pk.finish()
		j.Periodic = pr
	}
	j.Update = p.update(k)
	for _, gb := range k.blocks("group") {
		if len(gb.Labels) != 1 {
			continue
		}
		j.Groups = append(j.Groups, p.group(gb))
	}
	k.finish()
}

func (p *parser) group(b *hclsyntax.Block) Group {
	g := Group{Name: b.Labels[0]}
	k := p.open(b.Body, "group["+g.Name+"]", &g.Extra)
	k.str("count", &g.Count)
	k.kv("meta", &g.Meta)
	g.Constraints = p.constraints(k)
	if nb := k.one("network"); nb != nil {
		n := &Network{}
		nk := p.open(nb.Body, k.path+".network", nil)
		nk.str("mode", &n.Mode)
		for _, pb := range nk.blocks("port") {
			if len(pb.Labels) != 1 {
				continue
			}
			pt := Port{Label: pb.Labels[0]}
			pk := p.open(pb.Body, nk.path+".port["+pt.Label+"]", nil)
			pk.str("static", &pt.Static)
			pk.str("to", &pt.To)
			pk.str("host_network", &pt.HostNetwork)
			pk.finish()
			n.Ports = append(n.Ports, pt)
		}
		nk.finish()
		g.Network = n
	}
	for _, vb := range k.blocks("volume") {
		if len(vb.Labels) != 1 {
			continue
		}
		v := Volume{Name: vb.Labels[0]}
		vk := p.open(vb.Body, k.path+".volume["+v.Name+"]", nil)
		vk.str("type", &v.Type)
		vk.str("source", &v.Source)
		vk.str("read_only", &v.ReadOnly)
		vk.str("access_mode", &v.AccessMode)
		vk.str("attachment_mode", &v.AttachmentMode)
		vk.str("per_alloc", &v.PerAlloc)
		vk.finish()
		g.Volumes = append(g.Volumes, v)
	}
	g.Services = p.services(k)
	g.Restart = p.restart(k)
	if rb := k.one("reschedule"); rb != nil {
		r := &Reschedule{}
		rk := p.open(rb.Body, k.path+".reschedule", nil)
		rk.str("attempts", &r.Attempts)
		rk.str("interval", &r.Interval)
		rk.str("delay", &r.Delay)
		rk.str("delay_function", &r.DelayFunction)
		rk.str("max_delay", &r.MaxDelay)
		rk.str("unlimited", &r.Unlimited)
		rk.finish()
		g.Reschedule = r
	}
	g.Update = p.update(k)
	if eb := k.one("ephemeral_disk"); eb != nil {
		e := &EphemeralDisk{}
		ek := p.open(eb.Body, k.path+".ephemeral_disk", nil)
		ek.str("size", &e.Size)
		ek.str("migrate", &e.Migrate)
		ek.str("sticky", &e.Sticky)
		ek.finish()
		g.EphemeralDisk = e
	}
	for _, tb := range k.blocks("task") {
		if len(tb.Labels) != 1 {
			continue
		}
		g.Tasks = append(g.Tasks, p.task(tb, k.path))
	}
	k.finish()
	return g
}

func (p *parser) task(b *hclsyntax.Block, gpath string) Task {
	t := Task{Name: b.Labels[0]}
	k := p.open(b.Body, gpath+".task["+t.Name+"]", &t.Extra)
	k.str("driver", &t.Driver)
	if t.Driver != "docker" && t.Driver != "exec" && t.Driver != "raw_exec" {
		p.issue(b.Range(), k.path+".driver", "unsupported", "驱动 "+t.Driver+" 不受可视化模型支持", false)
	}
	if lb := k.one("lifecycle"); lb != nil {
		l := &Lifecycle{}
		lk := p.open(lb.Body, k.path+".lifecycle", nil)
		lk.str("hook", &l.Hook)
		lk.str("sidecar", &l.Sidecar)
		lk.finish()
		t.Lifecycle = l
	}
	if cb := k.one("config"); cb != nil {
		c := &t.Config
		ck := p.open(cb.Body, k.path+".config", nil)
		ck.str("image", &c.Image)
		ck.str("force_pull", &c.ForcePull)
		ck.str("command", &c.Command)
		ck.strs("args", &c.Args)
		ck.strs("ports", &c.Ports)
		ck.str("network_mode", &c.NetworkMode)
		ck.str("privileged", &c.Privileged)
		ck.strs("volumes", &c.Volumes)
		if ab := ck.one("auth"); ab != nil {
			a := &Auth{}
			ak := p.open(ab.Body, ck.path+".auth", nil)
			ak.str("username", &a.Username)
			ak.str("password", &a.Password)
			ak.finish()
			c.Auth = a
		}
		for _, mb := range ck.blocks("mount") {
			m := Mount{}
			mk := p.open(mb.Body, ck.path+".mount", nil)
			mk.str("type", &m.Type)
			mk.str("source", &m.Source)
			mk.str("target", &m.Target)
			mk.str("readonly", &m.Readonly)
			if bb := mk.one("bind_options"); bb != nil {
				bo := &BindOptions{}
				bk := p.open(bb.Body, mk.path+".bind_options", nil)
				bk.str("propagation", &bo.Propagation)
				bk.finish()
				m.BindOptions = bo
			}
			mk.finish()
			c.Mounts = append(c.Mounts, m)
		}
		if lb := ck.one("logging"); lb != nil {
			lg := &Logging{}
			lk := p.open(lb.Body, ck.path+".logging", nil)
			lk.str("type", &lg.Type)
			lk.kv("config", &lg.Config)
			lk.finish()
			c.Logging = lg
		}
		ck.finish()
	}
	k.kv("env", &t.Env)
	for _, vb := range k.blocks("volume_mount") {
		vm := VolumeMount{}
		vk := p.open(vb.Body, k.path+".volume_mount", nil)
		vk.str("volume", &vm.Volume)
		vk.str("destination", &vm.Destination)
		vk.str("read_only", &vm.ReadOnly)
		vk.str("propagation_mode", &vm.PropagationMode)
		vk.finish()
		t.VolumeMounts = append(t.VolumeMounts, vm)
	}
	if rb := k.one("resources"); rb != nil {
		r := &Resources{}
		rk := p.open(rb.Body, k.path+".resources", nil)
		rk.str("cpu", &r.CPU)
		rk.str("memory", &r.Memory)
		rk.str("memory_max", &r.MemoryMax)
		rk.finish()
		t.Resources = r
	}
	if lb := k.one("logs"); lb != nil {
		l := &Logs{}
		lk := p.open(lb.Body, k.path+".logs", nil)
		lk.str("max_files", &l.MaxFiles)
		lk.str("max_file_size", &l.MaxFileSize)
		lk.finish()
		t.Logs = l
	}
	t.Restart = p.restart(k)
	t.Services = p.services(k)
	if vb := k.one("vault"); vb != nil {
		v := &Vault{}
		vk := p.open(vb.Body, k.path+".vault", nil)
		vk.str("role", &v.Role)
		vk.str("cluster", &v.Cluster)
		vk.str("change_mode", &v.ChangeMode)
		vk.str("env", &v.Env)
		vk.finish()
		t.Vault = v
	}
	for _, ib := range k.blocks("identity") {
		id := Identity{}
		ik := p.open(ib.Body, k.path+".identity", nil)
		ik.str("name", &id.Name)
		ik.strs("aud", &id.Aud)
		ik.str("file", &id.File)
		ik.str("ttl", &id.TTL)
		ik.finish()
		t.Identities = append(t.Identities, id)
	}
	for _, tb := range k.blocks("template") {
		tm := Template{}
		tk := p.open(tb.Body, k.path+".template", nil)
		tk.str("destination", &tm.Destination)
		tk.str("data", &tm.Data)
		tk.str("env", &tm.Env)
		tk.str("perms", &tm.Perms)
		tk.str("change_mode", &tm.ChangeMode)
		tk.str("left_delimiter", &tm.LeftDelimiter)
		tk.str("right_delimiter", &tm.RightDelimiter)
		tk.str("splay", &tm.Splay)
		tk.finish()
		t.Templates = append(t.Templates, tm)
	}
	k.kv("meta", &t.Meta)
	k.finish()
	return t
}
