package server

import (
	"strings"
	"testing"
)

// TestHCLTreeRoutes validates the authoring protocol and enforces existing admin permissions.
func TestHCLTreeRoutes(t *testing.T) {
	e := newEnv(t)
	admin := e.setup(t)
	viewer := e.makeViewer(t, admin)
	base := "/api/v1/nomad/offline/job-ops/"
	source := "# keep comment\njob \"builder\" {\n group \"app\" {\n task \"worker\" {\n driver = \"docker\"\n config { image = \"busybox:1.36\" }\n }\n }\n}\n"
	status, parsed := admin.do("POST", base+"hcl-tree", map[string]any{"hcl": source}, nil)
	if status != 200 || parsed["document"] == nil || parsed["schema"] == nil {
		t.Fatalf("parse document: %d %v", status, parsed)
	}
	status, rendered := admin.do("POST", base+"hcl-tree-render", parsed["document"], nil)
	if status != 200 || rendered["valid"] != true || !strings.Contains(rendered["hcl"].(string), "# keep comment") {
		t.Fatalf("render document: %d %v", status, rendered)
	}
	for _, op := range []string{"hcl-tree", "hcl-tree-render"} {
		if status, _ := viewer.do("POST", base+op, map[string]any{"hcl": source}, nil); status != 403 {
			t.Fatalf("viewer must not access source authoring endpoint %s: %d", op, status)
		}
	}
	if status, body := admin.do("POST", base+"hcl-tree", map[string]any{"hcl": "job \"incomplete\" {"}, nil); status != 400 || errCode(body) != "hcl_invalid" {
		t.Fatalf("invalid HCL: %d %v", status, body)
	}
	if status, _ := admin.do("POST", base+"hcl-tree-render", map[string]any{"nodes": []any{map[string]any{"kind": "unrecognized", "name": "job", "leading": ""}}, "trailing": ""}, nil); status != 400 {
		t.Fatalf("invalid tree node accepted: %d", status)
	}
}
