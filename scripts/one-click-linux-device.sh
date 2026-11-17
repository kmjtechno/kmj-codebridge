#!/usr/bin/env bash
# Existing healthy CodeBridge agent is untouched; a new device requires owner-browser pairing.
set -Eeuo pipefail
umask 077
mark() { printf '%s=%s\n' "$1" "$2"; }
fail() { mark KMJ_DEVICE_ONE_CLICK "BLOCKED_$1"; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
self="$root/scripts/one-click-linux-device.sh"
project=""
project_id=""
service_user=""
selftest=0

device_id() {
  local pid="$1" host="$2" prefix="kmj-$1"
  [[ "$pid" =~ ^[a-z0-9_-]{1,48}$ && "$host" =~ ^[a-z0-9_-]{1,40}$ ]] || return 1
  local max=$(( 63 - ${#host} ))
  (( max >= 6 )) || return 1
  prefix="${prefix:0:max}"
  printf '%s-%s' "$prefix" "$host"
}

while (( $# > 0 )); do
  case "$1" in
    --project) (( $# >= 2 )) || fail PROJECT_ARG_MISSING; project="$2"; shift 2 ;;
    --project-id) (( $# >= 2 )) || fail PROJECT_ID_MISSING; project_id="$2"; shift 2 ;;
    --service-user) (( $# >= 2 )) || fail SERVICE_USER_MISSING; service_user="$2"; shift 2 ;;
    --self-test) selftest=1; shift ;;
    *) fail UNKNOWN_OPTION ;;
  esac
done

if (( selftest == 1 )); then
  [[ "$(device_id kmj-codebridge desktop-5fvjmet)" == "kmj-kmj-codebridge-desktop-5fvjmet" ]] ||
    fail SELFTEST_IDENTITY
  if device_id 'BAD/ID' desktop >/dev/null; then fail SELFTEST_UNSAFE_ID; fi
  if device_id valid 'bad.host' >/dev/null; then fail SELFTEST_UNSAFE_HOST; fi
  mark KMJ_UNIVERSAL_LINUX_SELFTEST PASS
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || fail LINUX_SYSTEMD_ONLY
[[ -f "$self" && ! -L "$self" ]] || fail SOURCE_LINKED
command -v git >/dev/null || fail GIT_REQUIRED
command -v readlink >/dev/null || fail READLINK_REQUIRED
repo_top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" ||
  fail TRUSTED_REPO_REQUIRED
[[ "$(readlink -f "$repo_top")" == "$root" ]] || fail SOURCE_NOT_ROOT
origin="$(git -C "$root" remote get-url origin 2>/dev/null)" ||
  fail SOURCE_ORIGIN_MISSING
case "$origin" in
  https://github.com/kmjtechno/kmj-codebridge|https://github.com/kmjtechno/kmj-codebridge.git|git@github.com:kmjtechno/kmj-codebridge.git) ;;
  *) fail UNTRUSTED_CODEBRIDGE_ORIGIN ;;
esac
head="$(git -C "$root" rev-parse HEAD 2>/dev/null)" || fail SOURCE_SHA_MISSING
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_SHA_UNTRUSTED
[[ -z "$(git -C "$root" --no-optional-locks status --porcelain=v1 --untracked-files=no)" ]] ||
  fail SOURCE_TRACKED_CHANGES
git -C "$root" ls-files --error-unmatch -- scripts/one-click-linux-device.sh scripts/install-vps.sh scripts/enroll-device.js src/cli.js >/dev/null 2>&1 ||
  fail SOURCE_FILES_UNTRACKED
[[ -f "$root/scripts/install-vps.sh" && ! -L "$root/scripts/install-vps.sh" ]] ||
  fail INSTALLER_UNTRUSTED

if [[ -z "$project" ]]; then project="$(pwd -P)"; fi
[[ "$project" == /* && -d "$project" && ! -L "$project" ]] || fail PROJECT_INVALID
project="$(readlink -f -- "$project")"
[[ "$project" != "/" ]] || fail PROJECT_ROOT_REFUSED
git -C "$project" rev-parse --show-toplevel >/dev/null 2>&1 || fail PROJECT_NOT_GIT
project_top="$(git -C "$project" rev-parse --show-toplevel)"
[[ "$(readlink -f -- "$project_top")" == "$project" ]] || fail PROJECT_NOT_TOPLEVEL
project_origin="$(git -C "$project" remote get-url origin 2>/dev/null)" ||
  fail PROJECT_ORIGIN_MISSING
if [[ -z "$project_id" ]]; then
  if [[ "$project_origin" =~ ^https://github\.com/[A-Za-z0-9_.-]+/([A-Za-z0-9][A-Za-z0-9_-]{0,47})(\.git)?$ ]]; then
    project_id="${BASH_REMATCH[1],,}"
  elif [[ "$project_origin" =~ ^git@github\.com:[A-Za-z0-9_.-]+/([A-Za-z0-9][A-Za-z0-9_-]{0,47})(\.git)?$ ]]; then
    project_id="${BASH_REMATCH[1],,}"
  else
    fail PROJECT_ID_EXPLICITLY_REQUIRED
  fi
fi
[[ "$project_id" =~ ^[a-z0-9_-]{1,48}$ ]] || fail PROJECT_ID_INVALID
host="$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | cut -c1-40)"
[[ "$host" =~ ^[a-z0-9_-]{1,40}$ ]] || fail HOSTNAME_INVALID
device="$(device_id "$project_id" "$host")" || fail DEVICE_ID_INVALID
if [[ -z "$service_user" ]]; then
  service_user="${SUDO_USER:-$(stat -c '%U' -- "$project")}"
fi
[[ "$service_user" != root && "$service_user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] ||
  fail SERVICE_USER_NOT_APPROVED
id "$service_user" >/dev/null 2>&1 || fail SERVICE_USER_MISSING
if (( EUID != 0 )); then
  command -v sudo >/dev/null || fail SUDO_NOT_AVAILABLE
  exec sudo -- bash "$self" --project "$project" --project-id "$project_id" --service-user "$service_user"
fi
command -v systemctl >/dev/null || fail SYSTEMD_REQUIRED
[[ -d /run/systemd/system ]] || fail SYSTEMD_NOT_RUNNING
cfg="/etc/kmj-codebridge/agent.json"
unit="kmj-codebridge-agent.service"
[[ ! -L "$cfg" ]] || fail CONFIG_LINKED

config_matches() {
  python3 - "$cfg" "$project" "$project_id" <<'PY'
import json,os,stat,sys
file,root,project=sys.argv[1:]
s=os.stat(file)
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077: raise SystemExit(2)
with open(file,encoding="utf-8") as fh: c=json.load(fh)
if not isinstance(c,dict) or not isinstance(c.get("id"),str) or not isinstance(c.get("tenant"),str):
    raise SystemExit(2)
if c.get("gateway") not in ("https://kmjtechno.com","https://kmjtechno.com/"):
    raise SystemExit(2)
if not isinstance(c.get("token"),str) or len(c["token"]) < 32: raise SystemExit(2)
projects=c.get("projects")
if not isinstance(projects,list) or not any(
    isinstance(p,dict) and p.get("id")==project and
    os.path.realpath(p.get("root",""))==root for p in projects
): raise SystemExit(2)
PY
}
if [[ -e "$cfg" ]]; then
  command -v python3 >/dev/null || fail PYTHON_REQUIRED_FOR_EXISTING_ENROLLMENT
  config_matches || fail EXISTING_ENROLLMENT_SCOPE_MISMATCH
  if systemctl is-active --quiet "$unit"; then
    mark KMJ_UNIVERSAL_LINUX_MODE EXISTING_ACTIVE_NO_MUTATION
    mark KMJ_UNIVERSAL_LINUX_AGENT LOCAL_ACTIVE
    mark KMJ_DEVICE_ONE_CLICK PASS
    mark KMJ_ACCOUNT_READY CHECK_AUTHENTICATED_CONNECTION_OVERVIEW
    exit 0
  fi
  fail EXISTING_AGENT_INACTIVE_REPAIR_REVIEW_REQUIRED
fi
if systemctl list-unit-files "$unit" --no-legend --no-pager 2>/dev/null | grep -q "^$unit"; then
  fail PREEXISTING_SERVICE_WITHOUT_CONFIG
fi
mark KMJ_UNIVERSAL_LINUX_MODE NEW_OWNER_BROWSER_PAIRING
# Lock new installation to this reviewed and clean git commit; do not fetch floating main.
bash "$root/scripts/install-vps.sh" \
  --project "$project" --project-id "$project_id" --device "$device" \
  --service-user "$service_user" --ref "$head" || fail OFFICIAL_INSTALLER_FAILED
[[ -f "$cfg" && ! -L "$cfg" ]] || fail POSTINSTALL_CONFIG_MISSING
command -v python3 >/dev/null || fail POSTINSTALL_PYTHON_MISSING
config_matches || fail POSTINSTALL_SCOPE_MISMATCH
systemctl is-active --quiet "$unit" || fail POSTINSTALL_SERVICE_NOT_ACTIVE
mark KMJ_UNIVERSAL_LINUX_AGENT LOCAL_ACTIVE
mark KMJ_DEVICE_ONE_CLICK PASS
mark KMJ_ACCOUNT_READY CHECK_AUTHENTICATED_CONNECTION_OVERVIEW
