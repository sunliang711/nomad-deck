package jobspec

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	_ "embed"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

const (
	maxDocumentBytes = 1 << 20
	maxDocumentNodes = 5000
	maxDocumentDepth = 32
)

// BuilderSchema is pinned to Nomad's API HCL tags and driver taskConfigSpec constructors.
//
//go:embed builder_schema.json
var BuilderSchema json.RawMessage

// HCLDocument preserves expression tokens, comments, locals and unknown extension blocks.
type HCLDocument struct {
	Nodes    []HCLNode `json:"nodes"`
	Trailing string    `json:"trailing"`
}

// HCLNode is an attribute or a labeled block; whitespace belongs to the following node.
type HCLNode struct {
	Kind       string       `json:"kind"`
	Name       string       `json:"name"`
	Labels     []string     `json:"labels,omitempty"`
	Expression string       `json:"expression,omitempty"`
	Body       *HCLDocument `json:"body,omitempty"`
	Leading    string       `json:"leading"`
}

// DocumentIssue identifies a structural problem without discarding an editable draft.
type DocumentIssue struct {
	Path     []int  `json:"path"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// DocumentResult always includes the current draft; invalid drafts cannot be submitted visually.
type DocumentResult struct {
	HCL         string          `json:"hcl"`
	Valid       bool            `json:"valid"`
	Diagnostics []DocumentIssue `json:"diagnostics"`
}

type documentField struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
}

type documentBlock struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Max    int    `json:"max"`
	Labels int    `json:"labels"`
}

type documentBodySchema struct {
	Attributes []documentField `json:"attributes"`
	Blocks     []documentBlock `json:"blocks"`
	MapKind    string          `json:"map_kind"`
}

// ParseDocument maps HCL source ranges directly, without evaluating or projecting expressions.
func ParseDocument(src string) (*HCLDocument, error) {
	if len(src) > maxDocumentBytes {
		return nil, fmt.Errorf("HCL 内容不能超过 1 MiB")
	}
	f, d := hclsyntax.ParseConfig([]byte(src), "job.hcl", hcl.InitialPos)
	if d.HasErrors() {
		return nil, fmt.Errorf("HCL 语法错误：%s", d.Error())
	}
	count := 0
	return readDocument([]byte(src), f.Body.(*hclsyntax.Body), 0, len(src), 0, &count)
}

// readDocument keeps the gaps between syntax nodes, including inline and trailing comments.
func readDocument(src []byte, body *hclsyntax.Body, start, end, depth int, count *int) (*HCLDocument, error) {
	if depth > maxDocumentDepth {
		return nil, fmt.Errorf("HCL 块嵌套不能超过 %d 层", maxDocumentDepth)
	}
	type entry struct {
		start, end int
		attr       *hclsyntax.Attribute
		block      *hclsyntax.Block
	}
	entries := []entry{}
	for _, a := range body.Attributes {
		entries = append(entries, entry{start: a.SrcRange.Start.Byte, end: a.SrcRange.End.Byte, attr: a})
	}
	for _, b := range body.Blocks {
		entries = append(entries, entry{start: b.Range().Start.Byte, end: b.Range().End.Byte, block: b})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].start < entries[j].start })
	doc := &HCLDocument{Nodes: []HCLNode{}}
	cursor := start
	for _, e := range entries {
		*count++
		if *count > maxDocumentNodes {
			return nil, fmt.Errorf("HCL 元素不能超过 %d 个", maxDocumentNodes)
		}
		n := HCLNode{Leading: string(src[cursor:e.start])}
		if e.attr != nil {
			n.Kind, n.Name = "attribute", e.attr.Name
			n.Expression = string(e.attr.Expr.Range().SliceBytes(src))
		} else {
			b := e.block
			n.Kind, n.Name, n.Labels = "block", b.Type, b.Labels
			var err error
			n.Body, err = readDocument(src, b.Body, b.OpenBraceRange.End.Byte, b.CloseBraceRange.Start.Byte, depth+1, count)
			if err != nil {
				return nil, err
			}
		}
		doc.Nodes = append(doc.Nodes, n)
		cursor = e.end
	}
	doc.Trailing = string(src[cursor:end])
	return doc, nil
}

// RenderDocument validates syntax and known Nomad cardinalities while preserving draft text.
func RenderDocument(doc *HCLDocument) (*DocumentResult, error) {
	if doc == nil {
		return nil, fmt.Errorf("缺少 HCL 结构")
	}
	var schema struct {
		Types map[string]documentBodySchema `json:"types"`
	}
	if err := json.Unmarshal(BuilderSchema, &schema); err != nil {
		return nil, fmt.Errorf("加载 Nomad 结构规则失败：%w", err)
	}
	res := &DocumentResult{Valid: true, Diagnostics: []DocumentIssue{}}
	var out strings.Builder
	count := 0
	if err := writeDocument(&out, doc, "Document", nil, schema.Types, res, 0, &count); err != nil {
		return nil, err
	}
	if out.Len() > maxDocumentBytes {
		return nil, fmt.Errorf("HCL 内容不能超过 1 MiB")
	}
	src := out.String()
	_, diags := hclsyntax.ParseConfig([]byte(src), "job.hcl", hcl.InitialPos)
	if diags.HasErrors() {
		res.Diagnostics = append(res.Diagnostics, DocumentIssue{Path: []int{}, Severity: "error", Message: "HCL 语法错误：" + diags.Error()})
		res.Valid = false
		res.HCL = src
	} else {
		res.HCL = string(hclwrite.Format([]byte(src)))
	}
	return res, nil
}

// commentGap accepts only whitespace and comments so metadata cannot inject extra syntax nodes.
func commentGap(src string) bool {
	f, d := hclsyntax.ParseConfig([]byte(src), "comment.hcl", hcl.InitialPos)
	if d.HasErrors() {
		return false
	}
	b := f.Body.(*hclsyntax.Body)
	return len(b.Attributes) == 0 && len(b.Blocks) == 0
}

// writeDocument validates singletons, labels and parent rules before serializing each body.
func writeDocument(out *strings.Builder, doc *HCLDocument, typ string, path []int, schemas map[string]documentBodySchema, res *DocumentResult, depth int, count *int) error {
	if depth > maxDocumentDepth {
		return fmt.Errorf("HCL 块嵌套不能超过 %d 层", maxDocumentDepth)
	}
	schema := schemas[typ]
	attrs, blocks := map[string]bool{}, map[string]int{}
	labels := map[string]bool{}
	issue := func(p []int, severity, message string) {
		res.Diagnostics = append(res.Diagnostics, DocumentIssue{Path: p, Severity: severity, Message: message})
		if severity == "error" {
			res.Valid = false
		}
	}
	for i, n := range doc.Nodes {
		*count++
		if *count > maxDocumentNodes || out.Len()+len(n.Expression)+len(n.Leading) > maxDocumentBytes {
			return fmt.Errorf("HCL 结构超出大小限制")
		}
		p := append(append([]int{}, path...), i)
		if !hclsyntax.ValidIdentifier(n.Name) {
			issue(p, "error", "元素名称必须是合法的 HCL 标识符")
		}
		if !commentGap(n.Leading) {
			return fmt.Errorf("元素前缀只能包含空白和注释")
		}
		out.WriteString(n.Leading)
		switch n.Kind {
		case "attribute":
			if n.Body != nil || len(n.Labels) > 0 {
				return fmt.Errorf("属性不能携带子块或名称标签")
			}
			if attrs[n.Name] {
				issue(p, "error", "属性 "+n.Name+" 只能添加一次")
			}
			attrs[n.Name] = true
			if _, d := hclsyntax.ParseExpression([]byte(n.Expression+"\n"), "expression.hcl", hcl.InitialPos); d.HasErrors() {
				issue(p, "error", "属性 "+n.Name+" 需要合法的 HCL 表达式")
			}
			out.WriteString(n.Name + " = " + n.Expression)
		case "block":
			if n.Expression != "" {
				return fmt.Errorf("块不能携带属性表达式")
			}
			blocks[n.Name]++
			child := ""
			var rule *documentBlock
			for _, b := range schema.Blocks {
				if b.Name == n.Name {
					copy := b
					rule = &copy
					break
				}
			}
			if rule != nil {
				child = rule.Type
				if rule.Max > 0 && blocks[n.Name] > rule.Max {
					issue(p, "error", n.Name+" 块只能添加一次")
				}
				if len(n.Labels) != rule.Labels {
					issue(p, "error", fmt.Sprintf("%s 块需要 %d 个名称标签", n.Name, rule.Labels))
				}
				if rule.Labels > 0 {
					key := n.Name + "\x00" + strings.Join(n.Labels, "\x00")
					if labels[key] || len(n.Labels) == 0 || n.Labels[0] == "" {
						issue(p, "error", n.Name+" 的名称不能为空或重复")
					}
					labels[key] = true
				}
			} else if typ != "" && schema.MapKind == "" && (n.Name == "job" || n.Name == "group" || n.Name == "task") {
				issue(p, "error", n.Name+" 不能放在当前层级；正确结构为 Job → Group → Task")
			}
			if child == "DriverConfig" {
				for _, a := range doc.Nodes {
					if a.Kind == "attribute" && a.Name == "driver" {
						if driver, err := strconv.Unquote(a.Expression); err == nil {
							if _, ok := schemas["driver."+driver]; ok {
								child = "driver." + driver
							}
						}
					}
				}
			}
			out.WriteString(n.Name)
			for _, label := range n.Labels {
				out.WriteByte(' ')
				out.Write(hclwrite.TokensForValue(cty.StringVal(label)).Bytes())
			}
			out.WriteString(" {")
			if n.Body == nil {
				return fmt.Errorf("块 %s 缺少 body", n.Name)
			}
			if err := writeDocument(out, n.Body, child, p, schemas, res, depth+1, count); err != nil {
				return err
			}
			out.WriteByte('}')
		default:
			return fmt.Errorf("未知的 HCL 元素类型")
		}
	}
	for _, a := range schema.Attributes {
		if a.Required && !attrs[a.Name] {
			issue(path, "error", "缺少必填属性 "+a.Name)
		}
	}
	if typ == "Document" && blocks["job"] != 1 {
		issue(path, "error", "文件中需要且只能有一个 Job")
	}
	for _, b := range schema.Blocks {
		if attrs[b.Name] && blocks[b.Name] > 0 {
			issue(path, "error", b.Name+" 不能同时使用属性和块定义")
		}
	}
	if typ == "Job" && blocks["group"] == 0 || typ == "TaskGroup" && blocks["task"] == 0 {
		issue(path, "error", "Job 至少需要一个 Group，Group 至少需要一个 Task")
	}
	if !commentGap(doc.Trailing) || out.Len()+len(doc.Trailing) > maxDocumentBytes {
		return fmt.Errorf("块尾部只能包含空白和注释，且不能超出大小限制")
	}
	out.WriteString(doc.Trailing)
	return nil
}
