package jobspec

import (
	"reflect"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	first, err := Render(richSpec())
	if err != nil {
		t.Fatal(err)
	}
	spec, issues, err := ParseHCL(first)
	if err != nil {
		t.Fatal(err)
	}
	if !Lossless(issues) {
		t.Fatalf("rendered HCL must map back losslessly: %+v", issues)
	}
	second, err := Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("round trip changed the HCL:\n--- first\n%s\n--- second\n%s", first, second)
	}
	if !reflect.DeepEqual(spec.Job.Groups[0].Tasks[0].Env, richSpec().Job.Groups[0].Tasks[0].Env) {
		t.Fatalf("env: %+v", spec.Job.Groups[0].Tasks[0].Env)
	}
}

const handWritten = `# a comment
locals {
  name = "x"
}

job "api" {
  datacenters = ["dc1"]
  all_at_once = true

  migrate {
    max_parallel = 1
  }

  group "g" {
    count = length(["a", "b"])

    dynamic "constraint" {
      for_each = ["linux"]
      content {
        attribute = "${attr.kernel.name}"
        value     = constraint.value
      }
    }

    task "t" {
      driver = "docker"

      config {
        image   = "nginx:1.27"
        ulimit {
          nofile = "1024"
        }
      }

      resources {
        cpu   = 100
        cores = 1
      }
    }
  }
}
`

func TestParseIssues(t *testing.T) {
	spec, issues, err := ParseHCL(handWritten)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, i := range issues {
		kinds[i.Kind+"/"+i.Path+"/"+boolStr(i.Preserved)] = true
	}
	for _, want := range []string{
		"comment//false", "locals/locals/false",
		"expression/job.all_at_once/true", "unsupported/job.migrate/true",
		"expression/group[g].count/true", "dynamic/group[g].dynamic/true",
		"unsupported/group[g].task[t].config.ulimit/false", "unsupported/group[g].task[t].resources.cores/false",
	} {
		if !kinds[want] {
			t.Errorf("missing issue %s in %+v", want, issues)
		}
	}
	if Lossless(issues) {
		t.Fatal("comments and locals are lost")
	}
	if !strings.Contains(spec.Job.Extra, "all_at_once = true") || !strings.Contains(spec.Job.Groups[0].Extra, "count = length") {
		t.Fatalf("preserved items must move to the fragments: %q / %q", spec.Job.Extra, spec.Job.Groups[0].Extra)
	}
	if spec.Job.Groups[0].Tasks[0].Config.Image != "nginx:1.27" || spec.Job.Groups[0].Tasks[0].Resources.CPU != "100" {
		t.Fatalf("mapped fields: %+v", spec.Job.Groups[0].Tasks[0])
	}
	// The preserved fragments render back into valid HCL.
	if _, err := Render(spec); err != nil {
		t.Fatal(err)
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
