package nomad

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestClassifyDockerUpgrade(t *testing.T) {
	cases := []struct {
		cur, target, cc, tc string
		inPlace             bool
	}{
		{"27.3.0", "27.3.1", "1.7.22", "1.7.24", true},
		{"27.3.0", "27.3.2", "", "", false},            // skips a patch
		{"27.3.1", "27.4.0", "", "", false},            // minor
		{"27.3.1", "28.0.0", "", "", false},            // major
		{"27.3.0", "27.3.1", "1.7.22", "2.0.0", false}, // containerd minor
		{"27.3.0", "27.3.1", "", "", true},
	}
	for _, c := range cases {
		if got := classifyDockerUpgrade(c.cur, c.target, c.cc, c.tc); got.InPlace != c.inPlace {
			t.Errorf("%s -> %s (containerd %s -> %s): in place %v, want %v (%s)", c.cur, c.target, c.cc, c.tc, got.InPlace, c.inPlace, got.Reason)
		}
	}
}

func TestDockerConfigMergeAndRender(t *testing.T) {
	defaults := DockerConfig{Version: "27.3.1", LogMaxSize: "100m", RegistryMirrors: []string{"https://mirror.example.com"},
		PullProxy: &PullProxy{Mode: "system"}}
	host := DockerConfig{LogMaxFile: 5, PullProxy: &PullProxy{Mode: "none"}}
	d := &dockerHost{defaults: defaults, host: host}
	eff := d.effective()
	if eff.Version != "27.3.1" || eff.LogMaxSize != "100m" || eff.LogMaxFile != 5 || eff.PullProxy.Mode != "none" {
		t.Fatalf("merge: %+v", eff)
	}
	b, err := RenderDaemonJSON(eff, "http://u:p@proxy:3128", []string{"localhost", "10.0.0.1"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["live-restore"] != true || m["proxies"].(map[string]any)["no-proxy"] != "localhost,10.0.0.1" ||
		m["log-opts"].(map[string]any)["max-file"] != "5" {
		t.Fatalf("daemon.json: %s", b)
	}
	bad := DockerConfig{PullProxy: &PullProxy{Mode: "custom", URL: "http://user:pw@proxy:3128"}}
	if err := bad.validate(); err == nil {
		t.Fatal("credentials inside the proxy URL must be rejected")
	}
	if !strings.Contains(RenderProxyDropIn("http://p:3128", []string{"a", "b"}), `"NO_PROXY=a,b"`) {
		t.Fatal("drop-in")
	}
}
