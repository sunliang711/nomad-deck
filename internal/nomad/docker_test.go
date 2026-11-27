package nomad

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"nomad-deck/internal/crypto"
	"nomad-deck/internal/db"
	"nomad-deck/internal/netx"
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
		probeOnly     bool
		restarts      int
	}{
		{name: "package already restarted daemon", running: "29.10.1"},
		{name: "old daemon needs restart", running: "29.10.0", restarts: 1},
		{name: "failed daemon is started"},
		{name: "preflight preserves a newer active daemon", running: "29.10.0", probeOnly: true},
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
			target, want := "29.10.1", "29.10.1"
			if tc.probeOnly {
				target, want = "", tc.running
			}
			cmd := exec.Command("sh", "-c", dockerEnsureRunningScript(target))
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
			if err != nil || strings.TrimSpace(string(out)) != want {
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

// 验证未填写版本时可安装最新版，并保留显式配置的优先级。
func TestDockerInstallVersion(t *testing.T) {
	for _, tc := range []struct {
		name, requested, configured, want string
	}{
		{name: "empty uses latest", want: "latest"},
		{name: "spaces use latest", requested: "  ", want: "latest"},
		{name: "host default", configured: "29.0.1", want: "29.0.1"},
		{name: "explicit wins", requested: " 28.0.2 ", configured: "29.0.1", want: "28.0.2"},
		{name: "explicit latest", requested: "latest", configured: "29.0.1", want: "latest"},
		{name: "invalid stays invalid", requested: "bad-version", want: "bad-version"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := dockerInstallVersion(tc.requested, tc.configured); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPullProxyURLCentralSetting(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	keys, _ := crypto.NewKeyringForTest(bytes.Repeat([]byte{9}, 32))
	pm := &netx.Manager{DB: d, Keys: keys}
	svc := &Service{Proxy: pm, Keys: keys}

	pw := "p@ss"
	if err := d.WithTx(ctx, func(tx *sql.Tx) error {
		if err := pm.Save(ctx, tx, &netx.ProxyConfig{Type: "http", Host: "10.0.0.2", Port: 3128, Username: "alice"}, &pw); err != nil {
			return err
		}
		return db.PutSettingJSON(ctx, tx, netx.SettingUseForDockerPull, true, d.NowString())
	}); err != nil {
		t.Fatal(err)
	}

	got, _, err := svc.pullProxyURL(ctx, &dockerHost{}, nil)
	if err != nil || !strings.HasPrefix(got, "http://alice:") || !strings.HasSuffix(got, "@10.0.0.2:3128") {
		t.Fatalf("expected central http proxy url, got %q err=%v", got, err)
	}

	// Explicit mode "none" overrides centralized proxy setting.
	got, _, err = svc.pullProxyURL(ctx, &dockerHost{}, &PullProxy{Mode: "none"})
	if err != nil || got != "" {
		t.Fatalf("mode none should disable pull proxy even if setting enabled, got %q err=%v", got, err)
	}

	// Disabling centralized switch reverts blank/nil host config to direct.
	if err := d.WithTx(ctx, func(tx *sql.Tx) error {
		return db.PutSettingJSON(ctx, tx, netx.SettingUseForDockerPull, false, d.NowString())
	}); err != nil {
		t.Fatal(err)
	}
	got, _, err = svc.pullProxyURL(ctx, &dockerHost{}, nil)
	if err != nil || got != "" {
		t.Fatalf("expected direct when central switch false, got %q err=%v", got, err)
	}
}

func TestParseDockerInspectOutput(t *testing.T) {
	raw := strings.Join([]string{
		"__ND_DF__",
		`{"Type":"Images","TotalCount":"4","Active":"2","Size":"1.2GB","Reclaimable":"450MB (37%)"}`,
		`{"Type":"Build Cache","TotalCount":"3","Active":"0","Size":"120MB","Reclaimable":"120MB"}`,
		"__ND_IMAGES__",
		`{"ID":"sha256:abc123","Repository":"postgres","Tag":"16-alpine","Size":"240MB","CreatedSince":"2 weeks ago"}`,
		"__ND_CONTAINERS__",
		"abcdef1234567890\tpostgres-123\tpostgres:16-alpine\trunning\tUp 3 hours\talloc-111\tpostgres",
		"fedcba0987654321\tnomad-deck\tghcr.io/foo/nomad-deck:v0.6.2\trunning\tUp 2 days\t\t",
		"__ND_ACTUAL__",
		`{`,
		`  "proxies": {`,
		`    "http-proxy": "http://alice:supersecret@10.0.0.2:3128"`,
		`  }`,
		`}`,
	}, "\n")

	df, images, containers, actual := parseDockerInspectOutput(raw)
	if len(df) != 2 || df[0].Type != "Images" || df[1].Reclaimable != "120MB" {
		t.Fatalf("unexpected df: %+v", df)
	}
	if len(images) != 1 || images[0].Repository != "postgres" || images[0].Tag != "16-alpine" {
		t.Fatalf("unexpected images: %+v", images)
	}
	if len(containers) != 2 {
		t.Fatalf("unexpected containers len: %d", len(containers))
	}
	if !containers[0].IsNomadManaged || containers[0].NomadJobID != "postgres" {
		t.Fatalf("expected Nomad container to be marked managed: %+v", containers[0])
	}
	if containers[1].IsNomadManaged || containers[1].ID != "fedcba098765" {
		t.Fatalf("expected standalone container to be marked unmanaged: %+v", containers[1])
	}
	if strings.Contains(actual, "supersecret") || !strings.Contains(actual, "http://***@10.0.0.2:3128") {
		t.Fatalf("expected proxy credentials redacted in actual config: %s", actual)
	}
}

func TestBuildDockerPruneScript(t *testing.T) {
	script := buildDockerPruneScript(DockerPruneInput{
		DanglingImages:    true,
		UnusedImages:      true,
		BuildCache:        true,
		StoppedContainers: true,
	})
	if !strings.Contains(script, "docker container prune -f") {
		t.Fatalf("missing container prune: %s", script)
	}
	if !strings.Contains(script, "docker image prune -a -f") {
		t.Fatalf("unused_images should run -a -f: %s", script)
	}
	if !strings.Contains(script, "docker builder prune -f") {
		t.Fatalf("missing builder prune: %s", script)
	}
	if strings.Contains(script, "volume prune") {
		t.Fatalf("prune script must never prune volumes automatically: %s", script)
	}
}
