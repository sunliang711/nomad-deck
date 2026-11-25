package jobspec

import (
	"fmt"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
)

// level describes what the form already defines at one block level, so a
// fragment cannot redefine it, and which block types never belong there.
type level struct {
	name      string
	attrs     map[string]bool
	blocks    map[string]bool
	labeled   map[string]map[string]bool
	forbidden map[string]bool
}

func set(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		if n != "" {
			m[n] = true
		}
	}
	return m
}

func when(cond bool, name string) string {
	if cond {
		return name
	}
	return ""
}

func jobLevel(j *Job) level {
	groups := map[string]bool{}
	for _, g := range j.Groups {
		groups[g.Name] = true
	}
	return level{name: "job",
		attrs: set(when(j.Namespace != "", "namespace"), when(j.Region != "", "region"), when(j.NodePool != "", "node_pool"),
			when(j.Type != "", "type"), when(len(j.Datacenters) > 0, "datacenters"), when(j.Priority != "", "priority")),
		blocks:    set(when(len(j.Meta) > 0, "meta"), when(j.Periodic != nil, "periodic"), when(j.Update != nil, "update")),
		labeled:   map[string]map[string]bool{"group": groups},
		forbidden: set("job", "variable", "locals", "task")}
}

func groupLevel(g *Group) level {
	vols, tasks := map[string]bool{}, map[string]bool{}
	for _, v := range g.Volumes {
		vols[v.Name] = true
	}
	for _, t := range g.Tasks {
		tasks[t.Name] = true
	}
	return level{name: "group",
		attrs: set(when(g.Count != "", "count")),
		blocks: set(when(g.Network != nil, "network"), when(g.Restart != nil, "restart"), when(g.Reschedule != nil, "reschedule"),
			when(g.Update != nil, "update"), when(g.EphemeralDisk != nil, "ephemeral_disk"), when(len(g.Meta) > 0, "meta")),
		labeled:   map[string]map[string]bool{"volume": vols, "task": tasks},
		forbidden: set("job", "group", "variable", "locals")}
}

func taskLevel(t *Task) level {
	return level{name: "task",
		attrs: set("driver"),
		blocks: set("config", when(t.Lifecycle != nil, "lifecycle"), when(len(t.Env) > 0, "env"), when(t.Resources != nil, "resources"),
			when(t.Logs != nil, "logs"), when(t.Restart != nil, "restart"), when(t.Vault != nil, "vault"), when(len(t.Meta) > 0, "meta")),
		forbidden: set("job", "group", "task", "variable", "locals")}
}

// CheckFragment validates a fragment for a level: it must parse on its own
// (so it cannot close the enclosing block) and must not redefine anything
// the form manages at that level.
func CheckFragment(src string, lv level) error {
	if strings.TrimSpace(src) == "" {
		return nil
	}
	if len(src) > 64<<10 {
		return fmt.Errorf("片段过长")
	}
	file, diags := hclsyntax.ParseConfig([]byte(src), lv.name+"-fragment.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		return fmt.Errorf("语法错误：%s", diags.Error())
	}
	body := file.Body.(*hclsyntax.Body)
	var problems []string
	for name, a := range body.Attributes {
		if lv.attrs[name] {
			problems = append(problems, fmt.Sprintf("第 %d 行：属性 %s 已由表单管理", a.SrcRange.Start.Line, name))
		}
	}
	for _, b := range body.Blocks {
		line := b.TypeRange.Start.Line
		switch {
		case lv.forbidden[b.Type]:
			problems = append(problems, fmt.Sprintf("第 %d 行：%s 块不能出现在 %s 层级", line, b.Type, lv.name))
		case lv.blocks[b.Type]:
			problems = append(problems, fmt.Sprintf("第 %d 行：%s 块已由表单管理", line, b.Type))
		case len(b.Labels) > 0 && lv.labeled[b.Type][b.Labels[0]]:
			problems = append(problems, fmt.Sprintf("第 %d 行：%s %q 已由表单定义", line, b.Type, b.Labels[0]))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("%s", strings.Join(problems, "；"))
	}
	return nil
}

func appendFragment(body *hclwrite.Body, src string, lv level) error {
	if strings.TrimSpace(src) == "" {
		return nil
	}
	if err := CheckFragment(src, lv); err != nil {
		return err
	}
	f, diags := hclwrite.ParseConfig([]byte(src), "fragment.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		return fmt.Errorf("语法错误：%s", diags.Error())
	}
	body.AppendNewline()
	body.AppendUnstructuredTokens(f.Body().BuildTokens(nil))
	body.AppendNewline()
	return nil
}
