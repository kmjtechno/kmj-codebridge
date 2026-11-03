#!/usr/bin/env bash
# KMJ-elite owner-only single attempt at the *existing* signed stable updater.
# Never falls back to an unsigned development updater or enables timers.
# It does not create signing keys, change config, or claim a release is live.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH
fail() { printf 'CODEBRIDGE_ACTIVATION=BLOCKED:%s\n' "$1"; exit 2; }

[[ $# == 0 ]] || fail ARGUMENTS_FORBIDDEN
[[ $(id -u) == 0 ]] || fail ROOT_REQUIRED
[[ $(hostname -s | tr '[:upper:]' '[:lower:]') == kmj-elite ]] || fail WRONG_HOST
UNIT=kmj-codebridge-stable-update.service
CONFIG=/etc/kmj-codebridge-update/stable-update.json
UNIT_PATH=/etc/systemd/system/kmj-codebridge-stable-update.service

# Read the exact installed systemd unit. No caller-selected units/paths.
[[ $(systemctl show "$UNIT" -p LoadState --value 2>/dev/null) == loaded ]] ||
  fail SIGNED_UNIT_NOT_INSTALLED
[[ $(systemctl show "$UNIT" -p FragmentPath --value 2>/dev/null) == "$UNIT_PATH" ]] ||
  fail SIGNED_UNIT_PATH_UNVERIFIED
[[ -z $(systemctl show "$UNIT" -p DropInPaths --value 2>/dev/null) ]] ||
  fail SIGNED_UNIT_HAS_UNREVIEWED_DROPINS
[[ $(systemctl show "$UNIT" -p User --value 2>/dev/null) == root ]] ||
  fail SIGNED_UNIT_NOT_ROOT
[[ $(systemctl show "$UNIT" -p Type --value 2>/dev/null) == oneshot ]] ||
  fail SIGNED_UNIT_TYPE_UNEXPECTED
[[ $(systemctl show "$UNIT" -p ActiveState --value 2>/dev/null) == inactive ]] ||
  fail SIGNED_UNIT_BUSY
[[ $(systemctl show "$UNIT" -p Result --value 2>/dev/null) == success ]] ||
  fail SIGNED_UNIT_FAILED_NEEDS_OWNER_REVIEW

# Verify protected file/ancestor metadata without exposing file contents.
python3 -I -S - "$UNIT_PATH" "$CONFIG" <<'PY' || fail TRUST_OR_CONFIG_NOT_READY
import json, os, re, stat, sys, urllib.parse
unit, config = sys.argv[1:]
def protected(path, private):
    if not path.startswith('/') or '..' in path.split('/'):
        raise ValueError('path')
    parent = os.path.dirname(path)
    while True:
        s = os.lstat(parent)
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('parent')
        if parent == '/':
            break
        parent = os.path.dirname(parent)
    s = os.lstat(path)
    if (not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1
            or s.st_mode & (0o077 if private else 0o022)):
        raise ValueError('file')
    return s
try:
    protected(unit, False)
    st = protected(config, True)
    if st.st_size < 100 or st.st_size > 65536:
        raise ValueError('config_size')
    fd = os.open(config, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        obj = json.loads(os.read(fd, 65537))
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns,
            before.st_size) != (after.st_dev, after.st_ino, after.st_mtime_ns,
            after.st_ctime_ns, after.st_size):
            raise ValueError('race')
    finally:
        os.close(fd)
    needed = {'schema','channel','manifestUrl','signatureUrl','trustedKeys',
              'installRoot','stateDir','agentStateDir','workDir'}
    if not isinstance(obj, dict) or not needed <= obj.keys():
        raise ValueError('schema')
    if obj['schema'] != 1 or obj['channel'] != 'stable':
        raise ValueError('channel')
    keys = obj['trustedKeys']
    if (not isinstance(keys, dict) or not 1 <= len(keys) <= 10
            or any(not isinstance(v, str) or len(v) < 32 or len(v) > 8192
                   or 'PRIVATE KEY' in v for v in keys.values())):
        raise ValueError('keys')
    for field in ('manifestUrl', 'signatureUrl'):
        value = obj[field]
        if not isinstance(value,str):
            raise ValueError('url')
        url = urllib.parse.urlsplit(value)
        if (url.scheme != 'https' or not url.netloc or url.username or url.password
            or url.query or url.fragment or not url.hostname):
            raise ValueError('url')
    if (urllib.parse.urlsplit(obj['manifestUrl']).netloc !=
        urllib.parse.urlsplit(obj['signatureUrl']).netloc):
        raise ValueError('origin')
    for field in ('installRoot','stateDir','agentStateDir','workDir'):
        value = obj[field]
        if not isinstance(value,str) or not value.startswith('/') or '..' in value.split('/'):
            raise ValueError('state_path')
    if obj['stateDir'] == obj['agentStateDir']:
        raise ValueError('state_overlap')
except (OSError, ValueError, TypeError, UnicodeError, json.JSONDecodeError):
    print('CODEBRIDGE_SIGNED_CONFIG=UNVERIFIED')
    sys.exit(2)
print('CODEBRIDGE_SIGNED_CONFIG=OWNER_PROTECTED')
PY

# The root-owned unit is the sole authority for signature, anti-rollback,
# installed bundle checks, agent health and automatic rollback.
exec_meta=$(systemctl show "$UNIT" -p ExecStart --value 2>/dev/null) ||
  fail SIGNED_UNIT_EXEC_UNVERIFIED
[[ "$exec_meta" == *"stable-update"* &&
   "$exec_meta" == *"$CONFIG"* &&
   "$exec_meta" == *"src/cli.js"* ]] || fail SIGNED_UNIT_EXEC_UNVERIFIED
unset exec_meta
printf 'CODEBRIDGE_SIGNED_UPDATE=TRIGGERING_EXISTING_GUARDED_UNIT\n'
if ! systemctl start "$UNIT" >/dev/null 2>&1; then
  fail SIGNED_UPDATE_SERVICE_FAILED
fi
result=$(systemctl show "$UNIT" -p Result --value 2>/dev/null) || fail RESULT_UNAVAILABLE
code=$(systemctl show "$UNIT" -p ExecMainStatus --value 2>/dev/null) || fail RESULT_UNAVAILABLE
condition=$(systemctl show "$UNIT" -p ConditionResult --value 2>/dev/null) || fail RESULT_UNAVAILABLE
[[ "$result" == success && "$code" == 0 && "$condition" == yes ]] ||
  fail SIGNED_UPDATE_GATE_FAILED
printf 'CODEBRIDGE_SIGNED_JOB=COMPLETED\n'
printf 'CODEBRIDGE_ACTIVATION=RECHECK_LIVE_RELEASE_SHA_AND_OAUTH\n'
