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
python3 -m py_compile "$SOURCE/activate-main-platform-approved.py"
test -d /home/kmjprod/releases
test -L /home/kmjprod/current
test -x /usr/bin/systemctl
test -x /usr/bin/python3

BIN="/usr/local/libexec/kmj-codebridge"
UNIT="/etc/systemd/system/kmj-main-platform-production-release.service"
install -d -m 0755 -o root -g root "$BIN"
install -m 0750 -o root -g root "$SOURCE/activate-main-platform-approved.py" "$BIN/activate-main-platform-approved.py"
install -m 0644 -o root -g root "$SOURCE/kmj-main-platform-production-release.service" "$UNIT"
systemctl daemon-reload
systemctl show kmj-main-platform-production-release.service -p LoadState -p ActiveState --no-pager
# Enable existing CodeBridge supervisor socket if already installed.
# Never alter its enrollment, OAuth credential or authorized project root.
if systemctl cat kmj-codebridge-supervisor.socket >/dev/null 2>&1; then
  systemctl enable --now kmj-codebridge-supervisor.socket
fi
echo "PRODUCTION_CONTROL_INSTALLED_NO_DEPLOY=1"
if [[ ! -S /run/kmj-codebridge/supervisor.sock ]]; then
  echo "SUPERVISOR_SOCKET_NOT_READY: verify CodeBridge agent config and approved supervisor installation."
fi
echo "NEXT: operator must provision verified backup, immutable staged release and root-owned approval file."
