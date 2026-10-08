#!/usr/bin/env bash
# Optional, fixed private PR337 CI service; installed only on the known VPS.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && $# -eq 0 ]] || { echo PRIVATE_CI_INSTALL_DENIED >&2; exit 2; }
project=/srv/kmj-codebridge-projects/kmj-main-platform
root=/opt/kmj-codebridge-agent
unit=/etc/systemd/system/kmj-codebridge-private-pr337-ci.service
[[ -d "$project/.git" && ! -L "$project/.git" ]] || {
  echo PRIVATE_CI_PROJECT_NOT_INSTALLED
  exit 0
}
for f in ci-main-platform-pr337.sh ci-main-platform-pr-worker.sh ci-main-platform-pr337-fixed.sh; do
  [[ -f "$root/scripts/$f" && ! -L "$root/scripts/$f" ]] ||
    { echo PRIVATE_CI_TRUSTED_SCRIPT_MISSING >&2; exit 3; }
done
# Refresh only the exact trusted website review ref before installing the
# offline CI service. Do not checkout, merge, push, touch production or fetch
# caller-selected repositories. The existing private deploy key is required.
remote="$(git -c safe.directory="$project" -C "$project" remote get-url origin)"
case "$remote" in
  git@github.com:kmjtechno/kmj-main-platform.git|ssh://git@github.com/kmjtechno/kmj-main-platform.git|https://github.com/kmjtechno/kmj-main-platform.git) ;;
  *) echo PRIVATE_WEBSITE_CI_ORIGIN_MISMATCH >&2; exit 4 ;;
esac
if ! GIT_TERMINAL_PROMPT=0 timeout 45s git -c safe.directory="$project" -C "$project" fetch --no-tags origin \
  refs/heads/fix/public-marketing-standalone-nav-20261008:refs/remotes/origin/fix/public-marketing-standalone-nav-20261008; then
  echo PRIVATE_WEBSITE_CI_REF_REFRESH_FAILED >&2
  exit 4
fi
if ! getent passwd kmjci >/dev/null; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin kmjci
fi
[[ "$(getent passwd kmjci | cut -d: -f7)" == /usr/sbin/nologin ]] ||
  { echo PRIVATE_CI_IDENTITY_UNSAFE >&2; exit 3; }
if [[ -L "$unit" || ( -e "$unit" && ! -f "$unit" ) ]]; then
  echo PRIVATE_CI_UNIT_UNSAFE >&2
  exit 3
fi
if [[ -f "$unit" ]] && ! grep -qxF 'Description=KMJ CodeBridge private PR337 CI' "$unit"; then
  echo PRIVATE_CI_UNIT_OWNERSHIP_CONFLICT >&2
  exit 3
fi
install -d -m 0711 -o root -g root /var/lib/kmj-codebridge-ci /var/lib/kmj-codebridge-ci/jobs
install -d -m 0700 -o root -g root /var/lib/kmj-codebridge-ci/evidence
cat >"$unit" <<'CI_UNIT'
[Unit]
Description=KMJ CodeBridge private PR337 CI
ConditionPathIsDirectory=/srv/kmj-codebridge-projects/kmj-main-platform/.git

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/opt/kmj-codebridge-agent
ExecStart=/bin/bash /opt/kmj-codebridge-agent/scripts/ci-main-platform-pr337-fixed.sh
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
# Only the trusted, fixed preparer needs DAC access to the enrolled checkout
# and CHOWN to copy dependencies, transfer the disposable job to kmjci, and
# clean it afterwards. PR code executes in a separate zero-capability worker.
# The preparer cannot write the source/runtime or access protected credentials.
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE
ReadOnlyPaths=/srv/kmj-codebridge-projects/kmj-main-platform /opt/kmj-codebridge-agent
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
# The fixed, nonproduction PR337 job is started once when the guarded
# CodeBridge installer provisions this unit. systemd owns execution; no
# arbitrary command, target SHA, repository or argument can be supplied.
# The script uses a disposable kmjci sandbox and never deploys the website.
echo PRIVATE_CI_NATIVE_UNIT_INSTALLED=1
if ! systemctl start --no-block kmj-codebridge-private-pr337-ci.service; then
  echo PRIVATE_WEBSITE_CI_START_DEFERRED >&2
  exit 4
fi
echo PRIVATE_WEBSITE_CI_START_ACCEPTED=1
