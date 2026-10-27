#!/usr/bin/env bash
# Owner-only, source-pinned installer for the INERT non-root CodeBridge probe.
# Never starts/enables a service, updates an agent, or deploys application code.
set -Eeuo pipefail
umask 077
die() { printf 'KMJ_DEV_INSTALL=BLOCKED_%s\n' "$1" >&2; exit 1; }
[[ $# == 1 && ( $1 == --inspect || $1 == --install ) ]] || die ARGUMENTS
mode="$1"
source_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
unit_source="$source_dir/kmj-codebridge-development-ci.service"
helper_source="$source_dir/kmj-codebridge-dev-probe.py"
unit_target="/etc/systemd/system/kmj-codebridge-development-ci.service"
helper_target="/usr/local/libexec/kmj-codebridge-dev-probe.py"
state_dir="/var/lib/kmj-codebridge-development-ci"
unit_sha="b851bb24cc5a846e3fc95a96893483f0dfd6540c91bc37d93a4f91aefd0ef53b"
helper_sha="1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7"
[[ -f "$unit_source" && ! -L "$unit_source" ]] || die UNIT_SOURCE
[[ -f "$helper_source" && ! -L "$helper_source" ]] || die HELPER_SOURCE
[[ "$(sha256sum "$unit_source" | cut -d' ' -f1)" == "$unit_sha" ]] || die UNIT_PIN
[[ "$(sha256sum "$helper_source" | cut -d' ' -f1)" == "$helper_sha" ]] || die HELPER_PIN
if [[ "$mode" == --inspect ]]; then
  printf 'KMJ_DEV_SOURCE_PIN=PASS\nKMJ_DEV_INSTALL=INSPECT_ONLY\n'
  exit 0
fi
[[ "$EUID" == 0 && "$(hostname -s)" == "KMJ-elite" ]] || die OWNER_HOST
[[ "$source_dir" == /root/kmj-approved/*/scripts/production ]] || die SOURCE_LOCATION
[[ ! -L "$0" ]] || die INSTALLER_SYMLINK
source_root="$(dirname "$(dirname "$source_dir")")"
for p in /root/kmj-approved "$source_root" "$source_root/scripts" "$source_dir" \
  "$0" "$unit_source" "$helper_source"; do
  [[ -e "$p" && ! -L "$p" && "$(stat -c '%u' "$p")" == 0 ]] || die SOURCE_OWNER
  permissions="$(stat -c '%a' "$p")"
  (( (8#$permissions & 8#022) == 0 )) || die SOURCE_PERMISSIONS
done
[[ -d /etc/systemd/system && ! -L /etc/systemd/system ]] || die SYSTEMD_DIR
[[ "$(stat -c '%u' /etc/systemd/system)" == 0 ]] || die SYSTEMD_OWNER
[[ ! -L /usr/local/libexec ]] || die HELPER_DIR_SYMLINK
if [[ -e "$unit_target" || -L "$unit_target" || -e "$helper_target" || -L "$helper_target" ]]; then
  die EXISTING_TARGET_REQUIRES_INDEPENDENT_REVIEW
fi
[[ "$(systemctl show kmj-codebridge-development-ci.service -p LoadState --value --no-pager)" == "not-found" ]] ||
  die UNIT_ALREADY_REGISTERED
user_exists=0
group_exists=0
getent passwd kmjdevci >/dev/null && user_exists=1
getent group kmjdevci >/dev/null && group_exists=1
[[ "$user_exists" == "$group_exists" ]] || die IDENTITY_PARTIAL
if [[ "$user_exists" == 0 ]]; then
  [[ -x /usr/sbin/nologin ]] || die NOLOGIN_MISSING
  groupadd --system kmjdevci
  useradd --system --gid kmjdevci --home-dir "$state_dir" \
    --shell /usr/sbin/nologin --no-create-home kmjdevci
fi
IFS=: read -r account _ uid gid _ home shell < <(getent passwd kmjdevci)
[[ "$account" == kmjdevci && "$uid" =~ ^[0-9]+$ && "$uid" != 0 ]] || die IDENTITY_USER
[[ "$gid" == "$(getent group kmjdevci | cut -d: -f3)" ]] || die IDENTITY_GROUP
[[ "$home" == "$state_dir" && "$shell" == /usr/sbin/nologin ]] || die IDENTITY_LOGIN
[[ "$(id -nG kmjdevci)" == kmjdevci ]] || die IDENTITY_EXTRA_GROUPS
[[ ! -L "$state_dir" ]] || die STATE_SYMLINK
if [[ -e "$state_dir" ]]; then
  [[ -d "$state_dir" && "$(stat -c '%u:%g:%a' "$state_dir")" == "$uid:$gid:700" ]] ||
    die STATE_EXISTING_UNSAFE
else
  install -d -o kmjdevci -g kmjdevci -m 0700 "$state_dir"
fi
if [[ -e /usr/local/libexec ]]; then
  [[ -d /usr/local/libexec && "$(stat -c '%u' /usr/local/libexec)" == 0 ]] ||
    die HELPER_DIR_UNSAFE
  helper_dir_mode="$(stat -c '%a' /usr/local/libexec)"
  (( (8#$helper_dir_mode & 8#022) == 0 )) || die HELPER_DIR_WRITABLE
else
  install -d -o root -g root -m 0755 /usr/local/libexec
fi
unit_tmp="$(mktemp /etc/systemd/system/.kmj-dev-unit.XXXXXXXX)"
helper_tmp="$(mktemp /usr/local/libexec/.kmj-dev-helper.XXXXXXXX)"
trap 'rm -f -- "$unit_tmp" "$helper_tmp"' EXIT
install -o root -g root -m 0644 "$unit_source" "$unit_tmp"
install -o root -g root -m 0644 "$helper_source" "$helper_tmp"
[[ "$(sha256sum "$unit_tmp" | cut -d' ' -f1)" == "$unit_sha" ]] || die STAGED_UNIT
[[ "$(sha256sum "$helper_tmp" | cut -d' ' -f1)" == "$helper_sha" ]] || die STAGED_HELPER
[[ ! -e "$unit_target" && ! -e "$helper_target" ]] || die TARGET_RACE
mv -T -- "$helper_tmp" "$helper_target"
mv -T -- "$unit_tmp" "$unit_target"
systemctl daemon-reload
[[ "$(systemctl show kmj-codebridge-development-ci.service -p LoadState --value --no-pager)" == loaded ]] ||
  die UNIT_LOAD
[[ "$(systemctl show kmj-codebridge-development-ci.service -p ActiveState --value --no-pager)" == inactive ]] ||
  die UNIT_UNEXPECTEDLY_ACTIVE
printf 'KMJ_DEV_INSTALL=INSTALLED_INACTIVE\nKMJ_DEV_PROBE_STARTED=NO\n'
printf 'KMJ_DEV_SIGNED_AGENT_CANARY=NOT_PERFORMED\nKMJ_AUTONOMOUS_CODING=NOT_ENABLED\n'
