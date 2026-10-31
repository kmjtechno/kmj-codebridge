#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ACTION="$1"
STAGE=/home/info_kmjtechno_com/kmj_cloudos_guest_tools_20261031
case "$ACTION" in inspect|install) ;; *) echo INVALID_ACTION; exit 2;; esac
test "$(id -u)" = 0
test "$(hostname -s)" = kmj-cloudos-kvm-test
test "$(dpkg --print-architecture)" = amd64
test -c /dev/kvm
n="$(timeout 12s virsh -c qemu:///system list --all --name | grep -c . || true)"
echo KMJ_N2_GUEST_TOOLS_OFFLINE_V1
echo "ACTION=$ACTION"
echo "EXISTING_DOMAINS=$n"
test "$n" = 0 || { echo BLOCKED=EXISTING_GUESTS; exit 3; }
plan() {
python3 - <<'PY'
import re,subprocess
p=subprocess.run(['apt-get','-s','-o','Debug::NoLocking=1','--no-install-recommends','install','cloud-image-utils','ovmf'],text=True,capture_output=True,timeout=25)
if p.returncode:
 print('BLOCKED=APT_SIMULATION_FAILED')
 print('APT_ERROR='+p.stderr[-200:].replace('\n',' '))
 raise SystemExit(4)
lines=p.stdout.splitlines()
if any(l.startswith(('Remv ','Purg ')) for l in lines):raise SystemExit('BLOCKED=APT_REMOVAL')
wanted=[]
def metadata(name,version=None):
 s=subprocess.run(['apt-cache','show',name],text=True,capture_output=True,timeout=15).stdout
 for block in s.split('\n\n'):
  f={}
  for line in block.splitlines():
   if ': ' in line and not line.startswith(' '):
    k,v=line.split(': ',1);f[k]=v
  if f.get('Package')!=name or f.get('Architecture') not in ('amd64','all') or (version and f.get('Version')!=version):continue
  if not re.fullmatch('[0-9a-f]{64}',f.get('SHA256','')):continue
  path=f.get('Filename','')
  if not re.fullmatch('pool/[A-Za-z0-9_+./%-]+',path) or '..' in path or not path.endswith('.deb'):continue
  return (name,f['Version'],f['Architecture'],f['SHA256'],path)
 raise SystemExit('BLOCKED=APT_METADATA_MISSING_'+name)
for line in lines:
 if not line.startswith('Inst '):continue
 m=re.match(r'^Inst ([A-Za-z0-9.+-]+)(?: \[([^]]+)\])? \(([^ )]+) ',line)
 if not m:raise SystemExit('BLOCKED=APT_PLAN_UNPARSEABLE')
 name,old,version=m.groups()
 if old:raise SystemExit('BLOCKED=APT_WOULD_UPGRADE_'+name)
 wanted.append(metadata(name,version))
if len(wanted)>16:raise SystemExit('BLOCKED=EXCESSIVE_DEPENDENCIES')
print('APT_PLAN=PASS')
print('PLAN_COUNT='+str(len(wanted)))
for row in wanted:print('PACKAGE|'+'|'.join(row))
print('GUEST_QGA|'+'|'.join(metadata('qemu-guest-agent')))
PY
}
if [ "$ACTION" = inspect ]; then
 plan
 echo RESULT=GUEST_TOOL_PLAN_READY
 exit 0
fi
test -d "$STAGE" && test ! -L "$STAGE" || { echo STAGE_UNSAFE; exit 5; }
PLAN="$(plan)"
printf '%s\n' "$PLAN"
printf '%s\n' "$PLAN" | grep -qx 'APT_PLAN=PASS'
expected="$(printf '%s\n' "$PLAN" | sed -n 's/^PLAN_COUNT=//p')"
[[ "$expected" =~ ^[0-9]+$ ]]
test "$expected" -le 16
set --
seen=0
while IFS='|' read -r tag name version arch sha rel; do
 if [ "$tag" != PACKAGE ]; then continue; fi
 file="$STAGE/$(basename "$rel")"
 test -f "$file" && test ! -L "$file" || { echo PACKAGE_FILE_MISSING; exit 5; }
 echo "$sha  $file" | sha256sum -c -
 test "$(dpkg-deb -f "$file" Package)" = "$name"
 test "$(dpkg-deb -f "$file" Version)" = "$version"
 test "$(dpkg-deb -f "$file" Architecture)" = "$arch"
 set -- "$@" "$file"
 seen=$((seen+1))
done <<< "$PLAN"
test "$seen" -eq "$expected"
if [ "$seen" -gt 0 ]; then
 LOG="$(mktemp /tmp/kmj-n2-tools-dpkg.XXXXXXXX)"
 if timeout --signal=TERM --kill-after=5s 120s dpkg -i -- "$@" >"$LOG" 2>&1; then
  echo OFFLINE_HOST_DPKG=PASS
 else
  echo OFFLINE_HOST_DPKG=FAILED
  tail -n 12 "$LOG" | cut -c1-170
  rm -f "$LOG"
  exit 6
 fi
 rm -f "$LOG"
else echo HOST_PACKAGES=ALREADY_PRESENT; fi
command -v cloud-localds >/dev/null || { echo CLOUD_LOCALDS=MISSING; exit 7; }
test -r /usr/share/OVMF/OVMF_CODE_4M.fd
test -r /usr/share/OVMF/OVMF_VARS_4M.fd
command -v qemu-img >/dev/null
echo HOST_OVMF_CLOUD_LOCALDS=PASS
while IFS='|' read -r tag name version arch sha rel; do
 if [ "$tag" != GUEST_QGA ]; then continue; fi
 file="$STAGE/$(basename "$rel")"
 test -f "$file" && test ! -L "$file" || { echo QGA_FILE_MISSING; exit 7; }
 echo "$sha  $file" | sha256sum -c -
 test "$(dpkg-deb -f "$file" Package)" = "$name"
 test "$(dpkg-deb -f "$file" Version)" = "$version"
 test "$(dpkg-deb -f "$file" Architecture)" = "$arch"
 echo QGA_DEB_STAGED_FOR_GUEST=PASS
done <<< "$PLAN"
echo RESULT=N2_HOST_GUEST_TOOLS_READY
echo RECEIPT_COMPLETE=YES
