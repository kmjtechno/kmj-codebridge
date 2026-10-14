#!/usr/bin/env bash
# Activate self-updates on an existing standard CodeBridge enrollment.
# Does not re-enroll, change agent credentials, or restart the live agent.
set -Eeuo pipefail
umask 077
[[ "${EUID:-$(id -u)}" == 0 && "$#" == 0 ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_REQUIRES_ROOT_NO_ARGS >&2; exit 2;
}
runtime="/opt/kmj-codebridge-agent"
config="/etc/kmj-codebridge/agent.json"
agent="kmj-codebridge-agent.service"
service="kmj-codebridge-auto-update.service"
timer="kmj-codebridge-auto-update.timer"
service_file="/etc/systemd/system/$service"
timer_file="/etc/systemd/system/$timer"
origin="https://github.com/kmjtechno/kmj-codebridge.git"
for tool in systemctl git node stat cmp mktemp install; do
  command -v "$tool" >/dev/null || { echo CODEBRIDGE_TIMER_REPAIR_TOOL_MISSING >&2; exit 3; }
done
for path in "$runtime" "$runtime/.git" "$runtime/scripts" "$config"; do
  [[ -e "$path" && ! -L "$path" ]] || {
    echo CODEBRIDGE_TIMER_REPAIR_STANDARD_RUNTIME_MISSING >&2; exit 3;
  }
done
[[ -f "$runtime/scripts/auto-update-development.sh" &&
   ! -L "$runtime/scripts/auto-update-development.sh" ]] || {
   echo CODEBRIDGE_TIMER_REPAIR_UPDATER_MISSING >&2; exit 3;
}
[[ -f "$config" && "$(stat -c %a "$config")" == 600 ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_CONFIG_UNTRUSTED >&2; exit 3;
}
[[ "$(git -C "$runtime" remote get-url origin)" == "$origin" ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_ORIGIN_MISMATCH >&2; exit 3;
}
[[ -z "$(git -C "$runtime" status --porcelain --untracked-files=no)" ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_RUNTIME_DIRTY >&2; exit 3;
}
[[ "$(systemctl show "$agent" -p LoadState --value)" == loaded &&
   "$(systemctl show "$agent" -p ActiveState --value)" == active &&
   "$(systemctl show "$agent" -p WorkingDirectory --value)" == "$runtime" &&
   "$(systemctl show "$agent" -p FragmentPath --value)" == "/etc/systemd/system/$agent" &&
   -z "$(systemctl show "$agent" -p DropInPaths --value)" ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_AGENT_UNEXPECTED >&2; exit 3;
}
node - "$config" "$runtime" <<'NODE'
const fs = require("node:fs");
const [config, runtime] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(config, "utf8"));
if (!c.id || !Array.isArray(c.projects) || c.projects.length < 1 ||
    !c.projects.every(p => typeof p?.id === "string" && typeof p?.root === "string") ||
    typeof c.stateDir !== "string" || !c.stateDir.startsWith("/var/lib/") ||
    typeof c.gateway !== "string" || !c.gateway.startsWith("https://") ||
    !fs.existsSync(runtime + "/src/cli.js")) process.exit(1);
NODE
# Refuse to replace third-party or custom units.
for file in "$service_file" "$timer_file"; do
  [[ ! -L "$file" ]] || { echo CODEBRIDGE_TIMER_REPAIR_UNIT_SYMLINK >&2; exit 3; }
  if [[ -e "$file" ]]; then
    [[ -f "$file" && "$(stat -c %u "$file")" == 0 ]] || {
      echo CODEBRIDGE_TIMER_REPAIR_UNIT_UNTRUSTED >&2; exit 3;
    }
    grep -Fq 'KMJ CodeBridge' "$file" || {
      echo CODEBRIDGE_TIMER_REPAIR_UNIT_NOT_OWNED >&2; exit 3;
    }
  fi
done
work="$(mktemp -d /run/kmj-codebridge-update-timer.XXXXXXXX)"
trap 'rm -rf --one-file-system -- "$work"' EXIT
cat >"$work/service" <<'UNIT'
[Unit]
Description=KMJ CodeBridge guarded development auto-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=CODEBRIDGE_AUTO_UPDATE_MODE=development
Environment=CODEBRIDGE_INSTALL_DIR=/opt/kmj-codebridge-agent
Environment=CODEBRIDGE_CONFIG=/etc/kmj-codebridge/agent.json
ExecStart=/bin/bash /opt/kmj-codebridge-agent/scripts/auto-update-development.sh
Nice=10
IOSchedulingClass=idle
UMask=0077
UNIT
cat >"$work/timer" <<'UNIT'
[Unit]
Description=Check for KMJ CodeBridge development updates

[Timer]
OnBootSec=1min
OnUnitInactiveSec=2min
RandomizedDelaySec=15s
AccuracySec=15s
Persistent=true
Unit=kmj-codebridge-auto-update.service

[Install]
WantedBy=timers.target
UNIT
install -o root -g root -m 0644 "$work/service" "$service_file"
install -o root -g root -m 0644 "$work/timer" "$timer_file"
systemctl daemon-reload
systemctl enable --now "$timer"
[[ "$(systemctl is-active "$timer")" == active ]] || {
  echo CODEBRIDGE_TIMER_REPAIR_TIMER_NOT_ACTIVE >&2; exit 4;
}
echo CODEBRIDGE_FAST_AUTO_UPDATE_TIMER_ACTIVE=1
echo CODEBRIDGE_AUTO_UPDATE_AGENT_RESTARTED=0
