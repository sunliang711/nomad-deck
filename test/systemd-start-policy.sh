#!/usr/bin/env bash
set -euo pipefail

# Exercise the shipped policy in isolated units without opening application data.
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || { echo "Requires Linux root" >&2; exit 1; }
[ -d /run/systemd/system ] || { echo "Requires systemd" >&2; exit 1; }
command -v python3 >/dev/null
command -v systemctl >/dev/null
test_root="$(cd "$(dirname "$0")/.." && pwd)"
policy_dir="$(mktemp -d /run/nomad-deck-policy.XXXXXX)"
policy_name="nomad-deck-policy-$$"
export policy_dir policy_name test_root

# cleanup removes only this test's units and temporary runtime directory.
cleanup() {
  systemctl stop "$policy_name.service" "$policy_name-rollback.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$policy_name.service" "$policy_name-rollback.service" >/dev/null 2>&1 || true
  rm -f "/run/systemd/system/$policy_name.service" "/run/systemd/system/$policy_name-rollback.service"
  systemctl daemon-reload
  case "$policy_dir" in /run/nomad-deck-policy.*) rm -rf -- "$policy_dir" ;; esac
}
trap cleanup EXIT

python3 - <<'PY'
import os
from pathlib import Path

root, work, name = Path(os.environ["test_root"]), Path(os.environ["policy_dir"]), os.environ["policy_name"]
unit = (root / "deploy/nomad-deck.service").read_text()
installer = (root / "scripts/install.sh").read_text()
fallback = installer.split("write_default_service_unit() {", 1)[1].split("<<'EOF'\n", 1)[1].split("\nEOF", 1)[0] + "\n"
assert unit == fallback, "Installer fallback must match the shipped service"
unit = unit.replace("nomad-deck-rollback.service", name + "-rollback.service").replace("nomad-deck.service", name + ".service")
unit = unit.replace("User=nomad-deck", "User=root").replace("Group=nomad-deck", "Group=root")
unit = unit.replace("WorkingDirectory=/opt/nomad-deck-control", "WorkingDirectory=" + str(work))
unit = unit.replace("ReadWritePaths=/opt/nomad-deck-control", "ReadWritePaths=" + str(work))
unit = unit.replace("ExecStart=/opt/nomad-deck-control/bin/nomad-deck serve --config /opt/nomad-deck-control/etc/nomad-deck.toml", "ExecStart=/usr/bin/python3 " + str(work / "probe.py"))
unit = unit.replace("RestartSec=5s", "RestartSec=100ms").replace("TimeoutStartSec=180", "TimeoutStartSec=2")
Path("/run/systemd/system/" + name + ".service").write_text(unit)
Path("/run/systemd/system/" + name + "-rollback.service").write_text(
    "[Service]\nType=oneshot\nExecStart=/usr/bin/touch " + str(work / "failure") + "\n")
(work / "mode").write_text("ready")
(work / "probe.py").write_text('''import os, socket, sys, time
from pathlib import Path
work = Path(__file__).parent
mode = (work / "mode").read_text()
with (work / "starts").open("a") as stream:
    stream.write(mode + "\\n")
if mode == "fail":
    sys.exit(1)
address = os.environ["NOTIFY_SOCKET"]
if address.startswith("@"):
    address = "\\0" + address[1:]
with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as stream:
    stream.sendto(b"READY=1", address)
if mode == "handover":
    time.sleep(0.2)
    (work / "mode").write_text("ready")
    sys.exit(75)
while True:
    time.sleep(1)
''')
PY
systemctl daemon-reload

# Successful readiness must reset the budget even when more than two starts occur.
for _ in 1 2 3 4; do
  systemctl restart "$policy_name.service"
  systemctl is-active --quiet "$policy_name.service"
done
echo "PASS: four healthy starts within the original ten-minute/two-start limit"

# The intentional handover must restart without invoking the failure handler.
printf handover > "$policy_dir/mode"
systemctl restart "$policy_name.service"
for _ in $(seq 1 50); do
  if [ "$(tail -n 1 "$policy_dir/starts")" = ready ] && systemctl is-active --quiet "$policy_name.service"; then break; fi
  sleep 0.1
done
[ "$(tail -n 1 "$policy_dir/starts")" = ready ]
systemctl is-active --quiet "$policy_name.service"
[ ! -e "$policy_dir/failure" ]
echo "PASS: exit 75 restarts without OnFailure rollback"

# Failures before READY must still trigger OnFailure and exhaust the restart budget.
printf fail > "$policy_dir/mode"
systemctl restart "$policy_name.service" >/dev/null 2>&1 || true
for _ in $(seq 1 50); do
  if [ "$(systemctl show "$policy_name.service" -p ActiveState --value)" = failed ] && [ "$(systemctl show "$policy_name.service" -p NRestarts --value)" -ge 2 ]; then break; fi
  sleep 0.1
done
[ "$(systemctl show "$policy_name.service" -p ActiveState --value)" = failed ]
[ "$(grep -c '^fail$' "$policy_dir/starts")" -eq 2 ]
[ -e "$policy_dir/failure" ]
echo "PASS: real startup failures remain limited and invoke OnFailure"
