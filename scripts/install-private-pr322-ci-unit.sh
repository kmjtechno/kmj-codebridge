#!/usr/bin/env bash
# Optional, fixed private PR322 CI service; installed only on the known VPS.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && $# -eq 0 ]] || { echo PRIVATE_CI_INSTALL_DENIED >&2; exit 2; }
project=/srv/kmj-codebridge-projects/kmj-main-platform
root=/opt/kmj-codebridge-agent
unit=/etc/systemd/system/kmj-codebridge-private-pr322-ci.service
[[ -d "$project/.git" && ! -L "$project/.git" ]] || {
  echo PRIVATE_CI_PROJECT_NOT_INSTALLED
  exit 0
}
for f in ci-main-platform-pr.sh ci-main-platform-pr-worker.sh ci-main-platform-pr-fixed.sh; do
  [[ -f "$root/scripts/$f" && ! -L "$root/scripts/$f" ]] ||
    { echo PRIVATE_CI_TRUSTED_SCRIPT_MISSING >&2; exit 3; }
done
if ! getent passwd kmjci >/dev/null; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin kmjci
fi
[[ "$(getent passwd kmjci | cut -d: -f7)" == /usr/sbin/nologin ]] ||
  { echo PRIVATE_CI_IDENTITY_UNSAFE >&2; exit 3; }
if [[ -L "$unit" || ( -e "$unit" && ! -f "$unit" ) ]]; then
  echo PRIVATE_CI_UNIT_UNSAFE >&2
  exit 3
fi
if [[ -f "$unit" ]] && ! grep -qxF 'Description=KMJ CodeBridge private PR322 CI' "$unit"; then
  echo PRIVATE_CI_UNIT_OWNERSHIP_CONFLICT >&2
  exit 3
fi
install -d -m 0711 -o root -g root /var/lib/kmj-codebridge-ci /var/lib/kmj-codebridge-ci/jobs
install -d -m 0700 -o root -g root /var/lib/kmj-codebridge-ci/evidence
cat >"$unit" <<'CI_UNIT'
[Unit]
Description=KMJ CodeBridge private PR322 CI
ConditionPathIsDirectory=/srv/kmj-codebridge-projects/kmj-main-platform/.git

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/opt/kmj-codebridge-agent
ExecStart=/bin/bash /opt/kmj-codebridge-agent/scripts/ci-main-platform-pr-fixed.sh
NoNewPrivileges=true
PrivateNetwork=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
ReadWritePaths=/var/lib/kmj-codebridge-ci
InaccessiblePaths=/etc/kmj-codebridge-main-platform /var/lib/kmj-codebridge-kmj-main-platform
MemoryMax=14G
TasksMax=600
RuntimeMaxSec=20min
UMask=0077
CI_UNIT
chown root:root "$unit"
chmod 0644 "$unit"
systemctl daemon-reload
# This oneshot has no [Install] section and is never auto-started.
echo PRIVATE_CI_NATIVE_UNIT_INSTALLED=1
