package jobspec

import (
	"reflect"
	"strings"
	"testing"
)

const documentFixture = `# Complete source must survive visual editing.
variable "cpu" {
  type = number
  default = 150
}
locals {
  image = "busybox:1.36"
}
job "blocks" {
  datacenters = ["dc1"] # Inline comment.
  type = "batch"
  group "app" {
    count = 1
    task "one" {
      driver = "docker"
      config {
        image = local.image
        command = "/bin/sh"
        args = concat(["-c"], ["echo block-ok"])
        logging {
          type = "json-file"
          config = [{ "max-size" = "10m" }]
        }
      }
      env {
        MODE = upper("test")
      }
      resources {
        cpu = var.cpu
        memory = 64
      }
      template {
        destination = "local/one.conf"
        data = <<EOT
{{ with secret "secret/data/app" }}{{ .Data.data.value }}{{ end }}
${NOMAD_ALLOC_ID}
EOT
      }
      template {
        destination = "local/two.conf"
        data = "second"
      }
    }
    task "two" {
      driver = "raw_exec"
      config {
        command = "/bin/true"
      }
    }
  }
  group "worker" {
    task "one" {
      driver = "raw_exec"
      config { command = "/bin/true" }
    }
  }
}
# Trailing comment.
`

// TestDocumentRoundTrip compares real Nomad parser output and preserves unsupported source forms.
func TestDocumentRoundTrip(t *testing.T) {
	doc, err := ParseDocument(documentFixture)
	if err != nil {
		t.Fatal(err)
	}
	result, err := RenderDocument(doc)
	if err != nil || !result.Valid {
		t.Fatalf("render: %v %+v", err, result)
	}
	for _, text := range []string{"# Complete source", "# Inline comment.", "# Trailing comment.", "locals {", "local.image", `upper("test")`, `concat(["-c"], ["echo block-ok"])`, `${NOMAD_ALLOC_ID}`, `{{ with secret "secret/data/app" }}`} {
		if !strings.Contains(result.HCL, text) {
			t.Errorf("source content lost: %s", text)
		}
	}
	parsed, err := ParseDocument(result.HCL)
	if err != nil {
		t.Fatal(err)
	}
	again, err := RenderDocument(parsed)
	if err != nil || again.HCL != result.HCL {
		t.Fatalf("round trip is not stable: %v\n%s\n%s", err, result.HCL, again.HCL)
	}
	before, after := nomadOutput(t, documentFixture), nomadOutput(t, result.HCL)
	if before != nil && !reflect.DeepEqual(before, after) {
		t.Fatal("Nomad job definition changed during structural round trip")
	}
}

// TestDocumentEditKeepsAdjacentNodes verifies a targeted change leaves other groups and expressions intact.
func TestDocumentEditKeepsAdjacentNodes(t *testing.T) {
	doc, err := ParseDocument(documentFixture)
	if err != nil {
		t.Fatal(err)
	}
	var change func(*HCLDocument)
	change = func(body *HCLDocument) {
		for i := range body.Nodes {
			n := &body.Nodes[i]
			if n.Kind == "attribute" && n.Name == "cpu" {
				n.Expression = "var.cpu * 2"
			}
			if n.Body != nil {
				change(n.Body)
			}
		}
	}
	change(doc)
	result, err := RenderDocument(doc)
	if err != nil || !result.Valid || !strings.Contains(result.HCL, "var.cpu * 2") || !strings.Contains(result.HCL, `group "worker"`) {
		t.Fatalf("targeted edit: %v %+v", err, result)
	}
	if strings.Count(result.HCL, "template {") != 2 || strings.Count(result.HCL, "task ") != 3 {
		t.Fatal("unrelated repeated blocks changed")
	}
}

// TestDocumentCardinality rejects invalid Nomad nesting while allowing repeated tasks and templates.
func TestDocumentCardinality(t *testing.T) {
	cases := []struct{ name, source, problem string }{
		{"attribute and block map", `job "a" {
group "g" {
task "t" {
driver = "docker"
env = { MODE = "test" }
env { REGION = "west" }
}
}
}`, "env 不能同时使用属性和块定义"},
		{"duplicate resources", `job "a" {
group "g" {
task "t" {
driver = "docker"
resources { cpu = 100 }
resources { memory = 64 }
}
}
}`, "resources 块只能添加一次"},
		{"nested task", `job "a" {
group "g" {
task "t" {
driver = "docker"
task "nested" { driver = "docker" }
}
}
}`, "正确结构为 Job"},
		{"duplicate label", `job "a" {
group "g" {
task "t" { driver = "docker" }
}
group "g" {
task "t" { driver = "docker" }
}
}`, "名称不能为空或重复"},
		{"missing driver", `job "a" {
group "g" {
task "t" {}
}
}`, "缺少必填属性 driver"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc, err := ParseDocument(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			result, err := RenderDocument(doc)
			if err != nil {
				t.Fatal(err)
			}
			if result.Valid || !strings.Contains(result.HCL, "job") {
				t.Fatal("invalid structure was accepted or draft was discarded")
			}
			found := false
			for _, issue := range result.Diagnostics {
				found = found || strings.Contains(issue.Message, tc.problem)
			}
			if !found {
				t.Fatalf("missing actionable diagnostic %q: %+v", tc.problem, result.Diagnostics)
			}
		})
	}
}

// TestDocumentOpaqueConfig keeps plugin-specific fields outside the known schema.
func TestDocumentOpaqueConfig(t *testing.T) {
	source := `job "custom" {
group "g" {
task "t" {
driver = "external_plugin"
config {
  options = { nested = [1, 2, 3] }
  task "custom-section" { vendor_flag = true }
}
}
}
}`
	doc, err := ParseDocument(source)
	if err != nil {
		t.Fatal(err)
	}
	result, err := RenderDocument(doc)
	if err != nil || !result.Valid || !strings.Contains(result.HCL, `task "custom-section"`) {
		t.Fatalf("opaque config: %v %+v", err, result)
	}
}

// TestDocumentRejectsHiddenSyntax ensures comments cannot inject unrepresented attributes.
func TestDocumentRejectsHiddenSyntax(t *testing.T) {
	doc, err := ParseDocument(documentFixture)
	if err != nil {
		t.Fatal(err)
	}
	doc.Nodes[0].Leading = "hidden = 123\n"
	if _, err := RenderDocument(doc); err == nil {
		t.Fatal("hidden syntax in comment metadata was accepted")
	}
	doc, err = ParseDocument(documentFixture)
	if err != nil {
		t.Fatal(err)
	}
	doc.Nodes[0].Body.Nodes[0].Expression = "string\ninjected = true"
	result, err := RenderDocument(doc)
	if err != nil || result.Valid {
		t.Fatalf("expression injection was not diagnosed: %v %+v", err, result)
	}
}

// TestDocumentLimits bounds deeply nested or oversized editable documents.
func TestDocumentLimits(t *testing.T) {
	if _, err := ParseDocument(strings.Repeat(" ", maxDocumentBytes+1)); err == nil {
		t.Fatal("oversized source was accepted")
	}
	source := strings.Repeat("opaque {\n", maxDocumentDepth+2) + strings.Repeat("}\n", maxDocumentDepth+2)
	if _, err := ParseDocument(source); err == nil {
		t.Fatal("excessive nesting was accepted")
	}
}
