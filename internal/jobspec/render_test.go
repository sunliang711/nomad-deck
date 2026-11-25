package jobspec

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// richSpec covers every block the acceptance list names.
func richSpec() *JobSpec {
	return &JobSpec{
		Variables: []Variable{{Name: "image_tag", Type: "string", Default: "1.27", HasDefault: true, Description: "nginx tag"},
			{Name: "replicas", Type: "number", Default: "2", HasDefault: true}, {Name: "password", Type: "string"}},
		Job: Job{ID: "web", Namespace: "default", Type: "service", Datacenters: []string{"dc1"}, Priority: "60",
			Constraints: []Constraint{{Attribute: "${attr.kernel.name}", Value: "linux"}},
			Update:      &Update{MaxParallel: "1", MinHealthyTime: "10s", HealthyDeadline: "3m", AutoRevert: "true"},
			Extra:       "affinity {\n  attribute = \"${node.datacenter}\"\n  value     = \"dc1\"\n  weight    = 50\n}\n",
			Groups: []Group{{
				Name: "frontend", Count: "var.replicas",
				Network: &Network{Mode: "bridge", Ports: []Port{{Label: "http", To: "80"}}},
				Volumes: []Volume{{Name: "data", Type: "host", Source: "data", ReadOnly: "false"}},
				Services: []Service{{Name: "web", Port: "http", Provider: "nomad",
					Checks: []Check{{Name: "alive", Type: "http", Path: "/", Interval: "10s", Timeout: "2s"}}}},
				Restart:       &Restart{Attempts: "2", Interval: "30m", Delay: "15s", Mode: "fail"},
				Reschedule:    &Reschedule{Attempts: "3", Interval: "1h", Delay: "30s", DelayFunction: "exponential", MaxDelay: "10m", Unlimited: "false"},
				Update:        &Update{MaxParallel: "1", AutoRevert: "true"},
				EphemeralDisk: &EphemeralDisk{Size: "300", Migrate: "true", Sticky: "true"},
				Extra:         "spread {\n  attribute = \"${node.unique.id}\"\n}\n",
				Tasks: []Task{
					{Name: "nginx", Driver: "docker",
						Config: Config{Image: "nginx:${var.image_tag}", Ports: []string{"http"},
							Mounts: []Mount{{Type: "bind", Source: "local/nginx.conf", Target: "/etc/nginx/nginx.conf", Readonly: "true",
								BindOptions: &BindOptions{Propagation: "rprivate"}}},
							Logging: &Logging{Type: "json-file", Config: []KV{{Key: "max-size", Value: "10m"}, {Key: "max-file", Value: "3"}}}},
						Env:          []KV{{Key: "PASSWORD", Value: "var.password"}, {Key: "MODE", Value: "prod"}},
						VolumeMounts: []VolumeMount{{Volume: "data", Destination: "/data", ReadOnly: "false"}},
						Resources:    &Resources{CPU: "200", Memory: "128", MemoryMax: "256"},
						Logs:         &Logs{MaxFiles: "5", MaxFileSize: "10"},
						Services:     []Service{{Name: "nginx-task", Port: "http", Provider: "nomad", Checks: []Check{{Type: "tcp", Interval: "15s", Timeout: "3s"}}}},
						Vault:        &Vault{Role: "web", ChangeMode: "restart"},
						Identities:   []Identity{{Name: "vault_default", Aud: []string{"vault.io"}, TTL: "1h"}},
						Templates: []Template{{Destination: "secrets/app.env", Env: "true", ChangeMode: "restart",
							Data: "{{ with secret \"secret/data/web\" }}PASS={{ .Data.data.password }}{{ end }}\n${not_interpolated}\n"}},
						Extra: "kill_timeout = \"20s\"\n"},
					{Name: "sidecar", Driver: "docker", Lifecycle: &Lifecycle{Hook: "prestart", Sidecar: "true"},
						Config:    Config{Image: "busybox:1.36", Command: "sleep", Args: []string{"infinity"}},
						Resources: &Resources{CPU: "50", Memory: "32"}},
				}}}}}
}

// nomadOutput parses an HCL job with the local Nomad CLI (offline) and
// returns the Job JSON, or nil when no nomad binary is available.
func nomadOutput(t *testing.T, src string, vars ...string) map[string]any {
	t.Helper()
	bin, err := exec.LookPath("nomad")
	if err != nil || testing.Short() {
		return nil
	}
	p := filepath.Join(t.TempDir(), "job.hcl")
	if err := os.WriteFile(p, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"job", "run", "-output"}
	for _, v := range vars {
		args = append(args, "-var", v)
	}
	res, err := exec.Command(bin, append(args, p)...).CombinedOutput()
	if err != nil {
		t.Fatalf("nomad parse: %v\n%s\n%s", err, res, src)
	}
	var j struct {
		Job map[string]any `json:"Job"`
	}
	if err := json.Unmarshal(res, &j); err != nil {
		t.Fatal(err)
	}
	return j.Job
}

func TestRenderRichSpec(t *testing.T) {
	out, err := Render(richSpec())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`variable "image_tag"`, "count = var.replicas", `PASSWORD = var.password`, "bind_options {",
		"memory_max = 256", "sidecar = true", "affinity {", "spread {", `kill_timeout = "20s"`, "$${not_interpolated}"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	j := nomadOutput(t, out, "password=pw")
	if j == nil {
		return
	}
	tg := j["TaskGroups"].([]any)[0].(map[string]any)
	if tg["Count"].(float64) != 2 {
		t.Fatalf("count from variable default: %v", tg["Count"])
	}
	task := tg["Tasks"].([]any)[0].(map[string]any)
	if task["Env"].(map[string]any)["PASSWORD"] != "pw" || task["Config"].(map[string]any)["image"] != "nginx:1.27" {
		t.Fatalf("task: %v", task)
	}
	tpl := task["Templates"].([]any)[0].(map[string]any)["EmbeddedTmpl"].(string)
	if !strings.Contains(tpl, "${not_interpolated}") {
		t.Fatalf("template data must be kept literally: %q", tpl)
	}
}

func TestFragmentRules(t *testing.T) {
	s := richSpec()
	s.Job.Groups[0].Extra = "network {\n  mode = \"host\"\n}\n"
	if _, err := Render(s); err == nil || !strings.Contains(err.Error(), "network 块已由表单管理") {
		t.Fatalf("managed block in fragment: %v", err)
	}
	s = richSpec()
	s.Job.Groups[0].Tasks[0].Extra = "}\nthing {\n"
	if _, err := Render(s); err == nil || !strings.Contains(err.Error(), "语法错误") {
		t.Fatalf("brace escape: %v", err)
	}
	s = richSpec()
	s.Job.Extra = "group \"frontend\" {\n}\n"
	if _, err := Render(s); err == nil {
		t.Fatal("redefining a form group must fail")
	}
	s = richSpec()
	s.Job.Groups[0].Tasks[0].VolumeMounts[0].Volume = "nope"
	if _, err := Render(s); err == nil || !strings.Contains(err.Error(), "未在 Group 中声明") {
		t.Fatalf("volume_mount linkage: %v", err)
	}
}
