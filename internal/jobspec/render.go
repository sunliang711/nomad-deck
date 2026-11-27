package jobspec

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

var (
	reVarRef  = regexp.MustCompile(`^var\.[A-Za-z_][A-Za-z0-9_-]*$`)
	reIdent   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
	reVarType = regexp.MustCompile(`^(string|number|bool|any|(list|set|map)\((string|number|bool|any)\))$`)
)

// RenderError lists every problem found while rendering.
type RenderError struct{ Problems []string }

func (e *RenderError) Error() string { return "渲染失败：" + strings.Join(e.Problems, "；") }

type writer struct {
	problems []string
}

func (w *writer) fail(path, format string, args ...any) {
	w.problems = append(w.problems, path+"："+fmt.Sprintf(format, args...))
}

func varTokens(v string) hclwrite.Tokens {
	parts := strings.SplitN(v, ".", 2)
	return hclwrite.TokensForTraversal(hcl.Traversal{hcl.TraverseRoot{Name: parts[0]}, hcl.TraverseAttr{Name: parts[1]}})
}

func (w *writer) valueTokens(path, kind, v string) (hclwrite.Tokens, bool) {
	if reVarRef.MatchString(v) {
		return varTokens(v), true
	}
	switch kind {
	case "n":
		if i, err := strconv.ParseInt(v, 10, 64); err == nil {
			return hclwrite.TokensForValue(cty.NumberIntVal(i)), true
		}
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return hclwrite.TokensForValue(cty.NumberFloatVal(f)), true
		}
		w.fail(path, "需为数字或 var.<名称>，当前为 %q", v)
		return nil, false
	case "b":
		switch v {
		case "true":
			return hclwrite.TokensForValue(cty.True), true
		case "false":
			return hclwrite.TokensForValue(cty.False), true
		}
		w.fail(path, "需为 true、false 或 var.<名称>，当前为 %q", v)
		return nil, false
	}
	if reVarInterp.MatchString(v) {
		if tok := exprTokens(quoteMixed(v)); tok != nil {
			return tok, true
		}
		return hclwrite.TokensForValue(cty.StringVal(v)), true
	}
	return hclwrite.TokensForValue(cty.StringVal(v)), true
}

// reVarInterp finds HCL variable interpolations inside string values.
var reVarInterp = regexp.MustCompile(`\$\{var\.[A-Za-z_][A-Za-z0-9_-]*\}`)

// quoteMixed quotes a string as an HCL template keeping ${var.<name>}
// interpolations and escaping everything else (other ${...} and %{...}
// sequences reach Nomad verbatim for runtime interpolation).
func quoteMixed(v string) string {
	var b strings.Builder
	b.WriteByte('"')
	last := 0
	for _, m := range reVarInterp.FindAllStringIndex(v, -1) {
		b.WriteString(escapeLiteral(v[last:m[0]]))
		b.WriteString(v[m[0]:m[1]])
		last = m[1]
	}
	b.WriteString(escapeLiteral(v[last:]))
	b.WriteByte('"')
	return b.String()
}

var literalEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`, "${", "$${", "%{", "%%{")

func escapeLiteral(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == 0 {
			return -1
		}
		return r
	}, s)
	return literalEscaper.Replace(s)
}

// set writes one attribute; empty values are omitted.
func (w *writer) set(b *hclwrite.Body, path, name, kind, v string) {
	if v == "" {
		return
	}
	if t, ok := w.valueTokens(path+"."+name, kind, v); ok {
		b.SetAttributeRaw(name, t)
	}
}

func (w *writer) list(b *hclwrite.Body, path, name string, vs []string) {
	if len(vs) == 0 {
		return
	}
	var elems []hclwrite.Tokens
	for _, v := range vs {
		t, _ := w.valueTokens(path+"."+name, "s", v)
		elems = append(elems, t)
	}
	b.SetAttributeRaw(name, hclwrite.TokensForTuple(elems))
}

func (w *writer) kvBlock(b *hclwrite.Body, path, name string, kvs []KV) {
	if len(kvs) == 0 {
		return
	}
	blk := b.AppendNewBlock(name, nil).Body()
	seen := map[string]bool{}
	for _, kv := range kvs {
		if !reIdent.MatchString(kv.Key) || seen[kv.Key] {
			w.fail(path+"."+name, "键 %q 不合法或重复（需为 HCL 标识符）", kv.Key)
			continue
		}
		seen[kv.Key] = true
		t, _ := w.valueTokens(path+"."+name+"."+kv.Key, "s", kv.Value)
		blk.SetAttributeRaw(kv.Key, t)
	}
}

func (w *writer) constraints(b *hclwrite.Body, path string, cs []Constraint) {
	for i, c := range cs {
		blk := b.AppendNewBlock("constraint", nil).Body()
		p := fmt.Sprintf("%s.constraint[%d]", path, i)
		w.set(blk, p, "attribute", "s", c.Attribute)
		w.set(blk, p, "operator", "s", c.Operator)
		w.set(blk, p, "value", "s", c.Value)
	}
}

func (w *writer) update(b *hclwrite.Body, path string, u *Update) {
	if u == nil {
		return
	}
	blk := b.AppendNewBlock("update", nil).Body()
	p := path + ".update"
	w.set(blk, p, "max_parallel", "n", u.MaxParallel)
	w.set(blk, p, "health_check", "s", u.HealthCheck)
	w.set(blk, p, "min_healthy_time", "s", u.MinHealthyTime)
	w.set(blk, p, "healthy_deadline", "s", u.HealthyDeadline)
	w.set(blk, p, "progress_deadline", "s", u.ProgressDeadline)
	w.set(blk, p, "auto_revert", "b", u.AutoRevert)
	w.set(blk, p, "auto_promote", "b", u.AutoPromote)
	w.set(blk, p, "canary", "n", u.Canary)
	w.set(blk, p, "stagger", "s", u.Stagger)
}

func (w *writer) restart(b *hclwrite.Body, path string, r *Restart) {
	if r == nil {
		return
	}
	blk := b.AppendNewBlock("restart", nil).Body()
	p := path + ".restart"
	w.set(blk, p, "attempts", "n", r.Attempts)
	w.set(blk, p, "interval", "s", r.Interval)
	w.set(blk, p, "delay", "s", r.Delay)
	w.set(blk, p, "mode", "s", r.Mode)
}

func (w *writer) services(b *hclwrite.Body, path string, ss []Service) {
	for i, s := range ss {
		blk := b.AppendNewBlock("service", nil).Body()
		p := fmt.Sprintf("%s.service[%d]", path, i)
		w.set(blk, p, "name", "s", s.Name)
		w.set(blk, p, "port", "s", s.Port)
		w.set(blk, p, "provider", "s", s.Provider)
		w.set(blk, p, "address_mode", "s", s.AddressMode)
		w.list(blk, p, "tags", s.Tags)
		for j, c := range s.Checks {
			cb := blk.AppendNewBlock("check", nil).Body()
			cp := fmt.Sprintf("%s.check[%d]", p, j)
			w.set(cb, cp, "name", "s", c.Name)
			w.set(cb, cp, "type", "s", c.Type)
			w.set(cb, cp, "path", "s", c.Path)
			w.set(cb, cp, "port", "s", c.Port)
			w.set(cb, cp, "address_mode", "s", c.AddressMode)
			w.set(cb, cp, "interval", "s", c.Interval)
			w.set(cb, cp, "timeout", "s", c.Timeout)
		}
	}
}

// Render renders a spec to HCL. The result is parsed back as a final check.
func Render(spec *JobSpec) (string, error) {
	w := &writer{}
	f := hclwrite.NewEmptyFile()
	root := f.Body()
	seenVar := map[string]bool{}
	for i, v := range spec.Variables {
		p := fmt.Sprintf("variable[%d]", i)
		if !reIdent.MatchString(v.Name) || seenVar[v.Name] {
			w.fail(p, "变量名 %q 不合法或重复", v.Name)
			continue
		}
		seenVar[v.Name] = true
		blk := root.AppendNewBlock("variable", []string{v.Name}).Body()
		typ := v.Type
		if typ != "" {
			if !reVarType.MatchString(typ) {
				w.fail(p, "变量类型 %q 不支持", typ)
			} else {
				blk.SetAttributeRaw("type", exprTokens(typ))
			}
		}
		if v.HasDefault || v.Default != "" {
			switch {
			case typ == "" || typ == "string" || typ == "any":
				blk.SetAttributeValue("default", cty.StringVal(v.Default))
			default:
				if _, d := hclsyntax.ParseExpression([]byte(v.Default), "default", hcl.InitialPos); d.HasErrors() {
					w.fail(p, "默认值不是合法的 %s 表达式", typ)
				} else {
					blk.SetAttributeRaw("default", exprTokens(v.Default))
				}
			}
		}
		w.set(blk, p, "description", "s", v.Description)
		root.AppendNewline()
	}
	j := spec.Job
	if !reJobIDLabel(j.ID) {
		w.fail("job", "Job ID %q 不合法", j.ID)
	}
	jb := root.AppendNewBlock("job", []string{j.ID}).Body()
	jp := "job"
	w.set(jb, jp, "namespace", "s", j.Namespace)
	w.set(jb, jp, "region", "s", j.Region)
	w.set(jb, jp, "node_pool", "s", j.NodePool)
	w.set(jb, jp, "type", "s", j.Type)
	w.list(jb, jp, "datacenters", j.Datacenters)
	w.set(jb, jp, "priority", "n", j.Priority)
	w.kvBlock(jb, jp, "meta", j.Meta)
	w.constraints(jb, jp, j.Constraints)
	if pr := j.Periodic; pr != nil {
		blk := jb.AppendNewBlock("periodic", nil).Body()
		w.list(blk, jp+".periodic", "crons", pr.Crons)
		w.set(blk, jp+".periodic", "prohibit_overlap", "b", pr.ProhibitOverlap)
		w.set(blk, jp+".periodic", "time_zone", "s", pr.TimeZone)
		w.set(blk, jp+".periodic", "enabled", "b", pr.Enabled)
	}
	w.update(jb, jp, j.Update)
	groupNames := map[string]bool{}
	for gi, g := range j.Groups {
		gp := fmt.Sprintf("group[%s]", g.Name)
		if g.Name == "" || groupNames[g.Name] {
			w.fail(fmt.Sprintf("group[%d]", gi), "Group 名称为空或重复")
			continue
		}
		groupNames[g.Name] = true
		jb.AppendNewline()
		gb := jb.AppendNewBlock("group", []string{g.Name}).Body()
		w.renderGroup(gb, gp, &g)
	}
	if err := appendFragment(jb, j.Extra, jobLevel(&j)); err != nil {
		w.fail("job.extra_hcl", "%v", err)
	}
	if len(w.problems) > 0 {
		return "", &RenderError{Problems: w.problems}
	}
	out := hclwrite.Format(f.Bytes())
	if _, d := hclsyntax.ParseConfig(out, "job.hcl", hcl.InitialPos); d.HasErrors() {
		return "", &RenderError{Problems: []string{d.Error()}}
	}
	return string(out), nil
}

var reJobIDRe = regexp.MustCompile(`^[^\x00-\x1f"\\]{1,128}$`)

func reJobIDLabel(s string) bool { return reJobIDRe.MatchString(s) }

func exprTokens(src string) hclwrite.Tokens {
	f, diags := hclwrite.ParseConfig([]byte("x = "+src+"\n"), "x", hcl.InitialPos)
	if diags.HasErrors() {
		return nil
	}
	attr := f.Body().GetAttribute("x")
	if attr == nil {
		return nil
	}
	return attr.Expr().BuildTokens(nil)
}

func (w *writer) renderGroup(gb *hclwrite.Body, gp string, g *Group) {
	w.set(gb, gp, "count", "n", g.Count)
	w.kvBlock(gb, gp, "meta", g.Meta)
	w.constraints(gb, gp, g.Constraints)
	if n := g.Network; n != nil {
		nb := gb.AppendNewBlock("network", nil).Body()
		w.set(nb, gp+".network", "mode", "s", n.Mode)
		labels := map[string]bool{}
		for _, p := range n.Ports {
			if !reIdent.MatchString(p.Label) || labels[p.Label] {
				w.fail(gp+".network", "端口标签 %q 不合法或重复", p.Label)
				continue
			}
			labels[p.Label] = true
			pb := nb.AppendNewBlock("port", []string{p.Label}).Body()
			pp := gp + ".network.port[" + p.Label + "]"
			w.set(pb, pp, "static", "n", p.Static)
			w.set(pb, pp, "to", "n", p.To)
			w.set(pb, pp, "host_network", "s", p.HostNetwork)
		}
	}
	vols := map[string]bool{}
	for _, v := range g.Volumes {
		if !reIdent.MatchString(v.Name) || vols[v.Name] {
			w.fail(gp, "卷名称 %q 不合法或重复", v.Name)
			continue
		}
		vols[v.Name] = true
		vb := gb.AppendNewBlock("volume", []string{v.Name}).Body()
		vp := gp + ".volume[" + v.Name + "]"
		w.set(vb, vp, "type", "s", v.Type)
		w.set(vb, vp, "source", "s", v.Source)
		w.set(vb, vp, "read_only", "b", v.ReadOnly)
		w.set(vb, vp, "access_mode", "s", v.AccessMode)
		w.set(vb, vp, "attachment_mode", "s", v.AttachmentMode)
		w.set(vb, vp, "per_alloc", "b", v.PerAlloc)
	}
	w.services(gb, gp, g.Services)
	w.restart(gb, gp, g.Restart)
	if r := g.Reschedule; r != nil {
		rb := gb.AppendNewBlock("reschedule", nil).Body()
		rp := gp + ".reschedule"
		w.set(rb, rp, "attempts", "n", r.Attempts)
		w.set(rb, rp, "interval", "s", r.Interval)
		w.set(rb, rp, "delay", "s", r.Delay)
		w.set(rb, rp, "delay_function", "s", r.DelayFunction)
		w.set(rb, rp, "max_delay", "s", r.MaxDelay)
		w.set(rb, rp, "unlimited", "b", r.Unlimited)
	}
	w.update(gb, gp, g.Update)
	if e := g.EphemeralDisk; e != nil {
		eb := gb.AppendNewBlock("ephemeral_disk", nil).Body()
		w.set(eb, gp+".ephemeral_disk", "size", "n", e.Size)
		w.set(eb, gp+".ephemeral_disk", "migrate", "b", e.Migrate)
		w.set(eb, gp+".ephemeral_disk", "sticky", "b", e.Sticky)
	}
	tasks := map[string]bool{}
	for ti, t := range g.Tasks {
		if !reIdent.MatchString(t.Name) || tasks[t.Name] {
			w.fail(fmt.Sprintf("%s.task[%d]", gp, ti), "Task 名称 %q 不合法或重复", t.Name)
			continue
		}
		tasks[t.Name] = true
		gb.AppendNewline()
		tb := gb.AppendNewBlock("task", []string{t.Name}).Body()
		w.renderTask(tb, gp+".task["+t.Name+"]", &t, vols, portLabels(g))
	}
	if err := appendFragment(gb, g.Extra, groupLevel(g)); err != nil {
		w.fail(gp+".extra_hcl", "%v", err)
	}
}

func portLabels(g *Group) map[string]bool {
	out := map[string]bool{}
	if g.Network != nil {
		for _, p := range g.Network.Ports {
			out[p.Label] = true
		}
	}
	return out
}

func (w *writer) renderTask(tb *hclwrite.Body, tp string, t *Task, vols, ports map[string]bool) {
	switch t.Driver {
	case "docker", "exec", "raw_exec":
	case "":
		w.fail(tp, "未指定驱动")
	default:
		w.fail(tp, "可视化编排只支持 docker、exec、raw_exec 驱动（其他驱动请用 HCL 模式）")
	}
	w.set(tb, tp, "driver", "s", t.Driver)
	if l := t.Lifecycle; l != nil {
		lb := tb.AppendNewBlock("lifecycle", nil).Body()
		w.set(lb, tp+".lifecycle", "hook", "s", l.Hook)
		w.set(lb, tp+".lifecycle", "sidecar", "b", l.Sidecar)
	}
	c := t.Config
	cb := tb.AppendNewBlock("config", nil).Body()
	cp := tp + ".config"
	if t.Driver == "docker" {
		if c.Image == "" {
			w.fail(cp, "Docker 驱动需要 image")
		}
		w.set(cb, cp, "image", "s", c.Image)
		w.set(cb, cp, "force_pull", "b", c.ForcePull)
	}
	w.set(cb, cp, "command", "s", c.Command)
	w.list(cb, cp, "args", c.Args)
	if t.Driver == "docker" {
		for _, p := range c.Ports {
			if !ports[p] {
				w.fail(cp, "端口 %q 不在 Group 的 network 中", p)
			}
		}
		w.list(cb, cp, "ports", c.Ports)
		w.set(cb, cp, "network_mode", "s", c.NetworkMode)
		w.set(cb, cp, "privileged", "b", c.Privileged)
		if a := c.Auth; a != nil {
			ab := cb.AppendNewBlock("auth", nil).Body()
			w.set(ab, cp+".auth", "username", "s", a.Username)
			w.set(ab, cp+".auth", "password", "s", a.Password)
		}
		w.list(cb, cp, "volumes", c.Volumes)
		for i, m := range c.Mounts {
			mb := cb.AppendNewBlock("mount", nil).Body()
			mp := fmt.Sprintf("%s.mount[%d]", cp, i)
			w.set(mb, mp, "type", "s", m.Type)
			w.set(mb, mp, "source", "s", m.Source)
			w.set(mb, mp, "target", "s", m.Target)
			w.set(mb, mp, "readonly", "b", m.Readonly)
			if m.BindOptions != nil {
				bb := mb.AppendNewBlock("bind_options", nil).Body()
				w.set(bb, mp+".bind_options", "propagation", "s", m.BindOptions.Propagation)
			}
		}
		if lg := c.Logging; lg != nil {
			lb := cb.AppendNewBlock("logging", nil).Body()
			w.set(lb, cp+".logging", "type", "s", lg.Type)
			w.kvBlock(lb, cp+".logging", "config", lg.Config)
		}
	} else if c.Command == "" {
		w.fail(cp, "%s 驱动需要 command", t.Driver)
	}
	w.kvBlock(tb, tp, "env", t.Env)
	for i, vm := range t.VolumeMounts {
		if !vols[vm.Volume] {
			w.fail(tp, "volume_mount 引用的卷 %q 未在 Group 中声明", vm.Volume)
		}
		vb := tb.AppendNewBlock("volume_mount", nil).Body()
		vp := fmt.Sprintf("%s.volume_mount[%d]", tp, i)
		w.set(vb, vp, "volume", "s", vm.Volume)
		w.set(vb, vp, "destination", "s", vm.Destination)
		w.set(vb, vp, "read_only", "b", vm.ReadOnly)
		w.set(vb, vp, "propagation_mode", "s", vm.PropagationMode)
	}
	if r := t.Resources; r != nil {
		rb := tb.AppendNewBlock("resources", nil).Body()
		w.set(rb, tp+".resources", "cpu", "n", r.CPU)
		w.set(rb, tp+".resources", "memory", "n", r.Memory)
		w.set(rb, tp+".resources", "memory_max", "n", r.MemoryMax)
	}
	if l := t.Logs; l != nil {
		lb := tb.AppendNewBlock("logs", nil).Body()
		w.set(lb, tp+".logs", "max_files", "n", l.MaxFiles)
		w.set(lb, tp+".logs", "max_file_size", "n", l.MaxFileSize)
	}
	w.restart(tb, tp, t.Restart)
	w.services(tb, tp, t.Services)
	if v := t.Vault; v != nil {
		vb := tb.AppendNewBlock("vault", nil).Body()
		w.set(vb, tp+".vault", "role", "s", v.Role)
		w.set(vb, tp+".vault", "cluster", "s", v.Cluster)
		w.set(vb, tp+".vault", "change_mode", "s", v.ChangeMode)
		w.set(vb, tp+".vault", "env", "b", v.Env)
	}
	for i, id := range t.Identities {
		ib := tb.AppendNewBlock("identity", nil).Body()
		ip := fmt.Sprintf("%s.identity[%d]", tp, i)
		w.set(ib, ip, "name", "s", id.Name)
		w.list(ib, ip, "aud", id.Aud)
		w.set(ib, ip, "file", "b", id.File)
		w.set(ib, ip, "ttl", "s", id.TTL)
	}
	for i, tm := range t.Templates {
		mb := tb.AppendNewBlock("template", nil).Body()
		mp := fmt.Sprintf("%s.template[%d]", tp, i)
		w.set(mb, mp, "destination", "s", tm.Destination)
		w.set(mb, mp, "data", "s", tm.Data)
		w.set(mb, mp, "env", "b", tm.Env)
		w.set(mb, mp, "perms", "s", tm.Perms)
		w.set(mb, mp, "change_mode", "s", tm.ChangeMode)
		w.set(mb, mp, "left_delimiter", "s", tm.LeftDelimiter)
		w.set(mb, mp, "right_delimiter", "s", tm.RightDelimiter)
		w.set(mb, mp, "splay", "s", tm.Splay)
	}
	w.kvBlock(tb, tp, "meta", t.Meta)
	if err := appendFragment(tb, t.Extra, taskLevel(t)); err != nil {
		w.fail(tp+".extra_hcl", "%v", err)
	}
}
