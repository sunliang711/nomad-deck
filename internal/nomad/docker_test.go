package nomad

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"nomad-deck/internal/sshx"
)

// TestDockerPackagePolicy verifies runtime restart suppression and cleanup after installer failure.
func TestDockerPackagePolicy(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "without host policy", true: "with host policy"}[existing], func(t *testing.T) {
			dir := t.TempDir()
			path, calls := filepath.Join(dir, "policy-rc.d"), filepath.Join(dir, "calls")
			original := "#!/bin/sh\necho \"$*\" >> " + sshx.Quote(calls) + "\nexit 0\n"
			if existing {
				if err := os.WriteFile(path, []byte(original), 0700); err != nil {
					t.Fatal(err)
				}
			}
			script := "set -e\n" + dockerPackagePolicyScript(path) + `
for service in docker docker.service docker.socket containerd containerd.service; do
  if "$policy_path" "$service" restart; then exit 42; else test "$?" = 101; fi
done
"$policy_path" unrelated.service restart
exit 9
`
			err := exec.Command("sh", "-c", script).Run()
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 9 {
				t.Fatalf("installer exit status was lost: %v", err)
			}
			got, err := os.ReadFile(path)
			if existing {
				if err != nil || string(got) != original {
					t.Fatalf("host policy was not restored: %q %v", got, err)
				}
				log, err := os.ReadFile(calls)
				if err != nil || strings.TrimSpace(string(log)) != "unrelated.service restart" {
					t.Fatalf("unrelated service policy was not preserved: %s %v", log, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("temporary host policy was not removed: %v", err)
			}
		})
	}
}

// TestDockerEnsureRunning exercises recovery without duplicate daemon restarts.
func TestDockerEnsureRunning(t *testing.T) {
	for _, tc := range []struct {
		name, running string
		failStart     bool
		restarts      int
	}{
		{name: "package already restarted daemon", running: "29.10.1"},
		{name: "old daemon needs restart", running: "29.10.0", restarts: 1},
		{name: "failed daemon is started"},
		{name: "start failure is reported", failStart: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			state, calls := filepath.Join(dir, "state"), filepath.Join(dir, "calls")
			if tc.running != "" {
				if err := os.WriteFile(state, []byte(tc.running), 0600); err != nil {
					t.Fatal(err)
				}
			}
			scripts := map[string]string{
				"systemctl": `#!/bin/sh
echo "$*" >> "$DOCKER_TEST_CALLS"
case "$1" in
  start) [ "$DOCKER_TEST_FAIL" != 1 ] || exit 7
         [ -f "$DOCKER_TEST_STATE" ] || echo 29.10.1 > "$DOCKER_TEST_STATE" ;;
  restart) echo 29.10.1 > "$DOCKER_TEST_STATE" ;;
esac
`,
				"docker": `#!/bin/sh
[ -f "$DOCKER_TEST_STATE" ] || exit 1
if [ "$1" = version ]; then cat "$DOCKER_TEST_STATE"; fi
`,
				"timeout": "#!/bin/sh\nshift\nexec \"$@\"\n",
			}
			for name, script := range scripts {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("sh", "-c", dockerEnsureRunningScript("29.10.1"))
			cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "DOCKER_TEST_STATE="+state, "DOCKER_TEST_CALLS="+calls)
			if tc.failStart {
				cmd.Env = append(cmd.Env, "DOCKER_TEST_FAIL=1")
			}
			out, err := cmd.CombinedOutput()
			if tc.failStart {
				if err == nil {
					t.Fatal("daemon start failure was ignored")
				}
				return
			}
			if err != nil || strings.TrimSpace(string(out)) != "29.10.1" {
				t.Fatalf("daemon recovery: %s %v", out, err)
			}
			log, err := os.ReadFile(calls)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Count(string(log), "restart docker"); got != tc.restarts {
				t.Fatalf("daemon restarted %d times, want %d: %s", got, tc.restarts, log)
			}
		})
	}
}

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
