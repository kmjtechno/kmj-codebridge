#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run only on the authorized KMJ-elite VPS, from a trusted, reviewed
# CodeBridge checkout. Does not generate approvals or deploy application.
if (( EUID != 0 )); then
  echo "INSTALL_REQUIRES_ROOT" >&2
  exit 1
fi
if [[ "$(hostname)" != "KMJ-elite" ]]; then
  echo "INSTALL_WRONG_HOST" >&2
  exit 1
fi
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -L "$SOURCE/activate-main-platform-approved.py" ||
      -L "$SOURCE/kmj-main-platform-production-release.service" ]]; then
  echo "INSTALL_SOURCE_SYMLINK_DENIED" >&2
  exit 1
fi
test -f "$SOURCE/activate-main-platform-approved.py"
test -f "$SOURCE/kmj-main-platform-production-release.service"
test -f "$SOURCE/kmj-codebridge-supervisor-prod-readonly.conf"
test -f "$SOURCE/bootstrap-existing-supervisor.sh"
python3 -m py_compile "$SOURCE/activate-main-platform-approved.py"
test -d /home/kmjprod/releases
test -L /home/kmjprod/current
test ! -L /home/kmjprod
test -x /usr/bin/systemctl
test -x /usr/bin/python3

BIN="/usr/local/libexec/kmj-codebridge"
UNIT="/etc/systemd/system/kmj-main-platform-production-release.service"
install -d -m 0755 -o root -g root "$BIN"
install -m 0750 -o root -g root "$SOURCE/activate-main-platform-approved.py" "$BIN/activate-main-platform-approved.py"
install -m 0644 -o root -g root "$SOURCE/kmj-main-platform-production-release.service" "$UNIT"
# The stock Supervisor uses ProtectHome=yes and otherwise cannot inspect
# the trusted /home/kmjprod/current symlink. Install the narrowly scoped
# read-only bind mount; never expose other user home directories.
SUPERVISOR_UNIT="kmj-codebridge-supervisor.service"
if systemctl cat "$SUPERVISOR_UNIT" >/dev/null 2>&1; then
  DROPIN_DIR="/etc/systemd/system/${SUPERVISOR_UNIT}.d"
  install -d -m 0755 -o root -g root "$DROPIN_DIR"
  install -m 0644 -o root -g root \
    "$SOURCE/kmj-codebridge-supervisor-prod-readonly.conf" \
    "$DROPIN_DIR/20-main-platform-production-readonly.conf"
fi
systemctl daemon-reload
systemctl show kmj-main-platform-production-release.service -p LoadState -p ActiveState --no-pager
# On legacy Main Platform-only installs, the socket and supervisor unit
# never existed. The bounded bootstrap derives both only from the registered
# existing agent service, verifies its runtime and owner, then creates the
# missing fixed units. It does not restart or re-enroll the agent.
bash "$SOURCE/bootstrap-existing-supervisor.sh"
echo "PRODUCTION_CONTROL_INSTALLED_NO_DEPLOY=1"
if [[ ! -S /run/kmj-codebridge/supervisor.sock ]]; then
  echo "SUPERVISOR_SOCKET_NOT_READY: verify CodeBridge agent config and approved supervisor installation."
fi
if systemctl is-active --quiet kmj-codebridge-supervisor.service; then
  echo "SUPERVISOR_RUNNING_OLD_NAMESPACE: restart only after confirming no active supervisor work."
fi
echo "NEXT: operator must provision verified backup, immutable staged release and root-owned approval file."
