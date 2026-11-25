package jobspec

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const composeYAML = `services:
  web:
    image: nginx:1.27
    command: ["nginx", "-g", "daemon off;"]
    environment:
      MODE: prod
    ports:
      - "8080:80"
      - "9090"
    volumes:
      - ./conf:/etc/nginx/conf.d:ro
      - data:/var/lib/data
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
    depends_on: [db]
    healthcheck:
      test: ["CMD", "true"]
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=x
    secrets: [dbpass]
  builder:
    build: .
volumes:
  data: {}
secrets:
  dbpass:
    file: ./pass.txt
`

func TestConvertCompose(t *testing.T) {
	res, err := ConvertCompose([]byte(composeYAML), ComposeOptions{JobID: "app"})
	if err != nil {
		t.Fatal(err)
	}
	msgs := []string{}
	for _, i := range res.Issues {
		msgs = append(msgs, i.Severity+":"+i.Service+":"+i.Message)
	}
	all := strings.Join(msgs, "\n")
	for _, want := range []string{"block::顶层 secrets", "block:db:secrets", "block:builder:只有 build", "block:web:命名卷 data 需要绑定",
		"warn:web:depends_on", "warn:web:healthcheck", "warn:web:replicas=2 且使用静态宿主端口"} {
		if !strings.Contains(all, want) {
			t.Errorf("missing issue %q in\n%s", want, all)
		}
	}
	if !res.Blocking || res.HCL != "" || !reflect.DeepEqual(res.NamedVolumes, []string{"data"}) {
		t.Fatalf("blocking result: %+v", res)
	}
	// Bound volume and no blocking services: renders and parses.
	clean := strings.Replace(composeYAML, "    secrets: [dbpass]\n", "", 1)
	clean = strings.Replace(clean, "  builder:\n    build: .\n", "", 1)
	clean = clean[:strings.Index(clean, "secrets:\n  dbpass")]
	res, err = ConvertCompose([]byte(clean), ComposeOptions{JobID: "app", VolumeBindings: map[string]VolumeBinding{"data": {Type: "host", Source: "data"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Blocking {
		t.Fatalf("still blocking: %+v", res.Issues)
	}
	web := res.Spec.Job.Groups[1]
	if web.Name != "web" || web.Count != "2" || web.Tasks[0].Resources.CPU != "500" || web.Tasks[0].Resources.Memory != "256" ||
		web.Network.Ports[0].Static != "8080" || web.Network.Ports[1].Static != "" || web.Volumes[0].Type != "host" ||
		web.Tasks[0].Config.Command != "nginx" || web.Tasks[0].Config.Mounts[0].Readonly != "true" {
		t.Fatalf("web group: %+v", web)
	}
	if j := nomadOutput(t, res.HCL); j != nil && len(j["TaskGroups"].([]any)) != 2 {
		t.Fatalf("parsed groups: %v", j["TaskGroups"])
	}
}

// FromJob: HCL rebuilt from Nomad's parsed JSON parses back to the same
// Job JSON (except the fragments, which JSON cannot carry).
func TestFromJobRoundTrip(t *testing.T) {
	s := richSpec()
	s.Job.Extra, s.Job.Groups[0].Extra, s.Job.Groups[0].Tasks[0].Extra = "", "", ""
	src, err := Render(s)
	if err != nil {
		t.Fatal(err)
	}
	orig := nomadOutput(t, src, "password=pw")
	if orig == nil {
		t.Skip("nomad binary not available")
	}
	b, _ := json.Marshal(orig)
	var asJSON map[string]any
	_ = json.Unmarshal(b, &asJSON)
	spec, issues := FromJob(asJSON)
	for _, i := range issues {
		t.Logf("issue: %+v", i)
	}
	again, err := Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	back := nomadOutput(t, again)
	ob, _ := json.Marshal(orig)
	bb, _ := json.Marshal(back)
	if string(ob) != string(bb) {
		t.Fatalf("JSON differs after mapping:\n%s\n---\n%s\n---\n%s", ob, bb, again)
	}
}
