#!/usr/bin/env bash
# Stage pinned, checksum-verified official Ubuntu Noble qcow2 on dedicated N2 lab.
# No libvirt domains or services changed. No overwrite of unverified existing image.
set -Eeuo pipefail
umask 077
HOST=kmj-cloudos-kvm-test
USER_HOME=/home/info_kmjtechno_com
BASENAME=noble-server-cloudimg-amd64.img
SRC="$USER_HOME/$BASENAME"
DST_DIR=/var/lib/libvirt/images/kmj-cloudos-ci
DST="$DST_DIR/base.qcow2"
EXPECTED=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
test "$(id -u)" -eq 0 || { echo ROOT=REQUIRED; exit 2; }
test "$(hostname -s)" = "$HOST" || { echo HOST=MISMATCH; exit 2; }
test -c /dev/kvm
command -v qemu-img >/dev/null
command -v virsh >/dev/null
echo KMJ_N2_OFFICIAL_NOBLE_IMAGE_STAGE_V1
echo "HOST=$HOST"
echo SCOPE=PINNED_IMAGE_ONLY_NO_VM_CREATION
echo "SHA256_EXPECTED=$EXPECTED"
domains="$(timeout 12s virsh -c qemu:///system list --all --name | grep -c . || true)"
echo "EXISTING_DOMAINS=$domains"
test "$domains" = 0 || { echo BLOCKED=EXISTING_DOMAINS; exit 3; }
if [ -L "$DST_DIR" ] || [ -L "$DST" ] || [ -L "$SRC" ]; then echo BLOCKED=SYMLINK; exit 3; fi
if [ -f "$DST" ]; then
  echo "IMAGE_ALREADY_STAGED=CHECK"
  echo "$EXPECTED  $DST" | sha256sum -c -
  echo IMAGE_ALREADY_STAGED=VERIFIED
  echo RESULT=PINNED_NOBLE_BASE_READY
  echo RECEIPT_COMPLETE=YES
  exit 0
fi
test ! -e "$DST" || { echo BLOCKED=EXISTING_UNEXPECTED_PATH; exit 3; }
test -f "$SRC" || { echo BLOCKED=SOURCE_IMAGE_MISSING; exit 3; }
test "$(stat -c %U "$SRC")" = info_kmjtechno_com || { echo BLOCKED=SOURCE_OWNER; exit 3; }
size="$(stat -c %s "$SRC")"
echo "IMAGE_BYTES=$size"
test "$size" -ge 250000000 && test "$size" -le 1500000000 || { echo BLOCKED=IMAGE_SIZE_UNEXPECTED; exit 3; }
echo "$EXPECTED  $SRC" | sha256sum -c -
echo SOURCE_IMAGE_SHA256=PASS
python3 - "$SRC" <<'PY'
import json,subprocess,sys
p=subprocess.run(['qemu-img','info','-f','qcow2','--output=json',sys.argv[1]],text=True,capture_output=True,timeout=15,check=True)
x=json.loads(p.stdout)
assert x.get('format')=='qcow2','INVALID_QCOW2_FORMAT'
assert not x.get('backing-filename') and not x.get('full-backing-filename'),'BASE_HAS_BACKING_FILE'
assert x.get('virtual-size',0) >= 1024**3 and x['virtual-size'] <= 128*1024**3,'INVALID_VIRTUAL_SIZE'
print('QCOW2_IMAGE_FORMAT=PASS')
print('VIRTUAL_GIB='+str(round(x['virtual-size']/1024**3,2)))
PY
free="$(df -PB1 /var/lib/libvirt/images | awk 'NR==2{print $4}')"
test "$free" -gt "$((size+4000000000))" || { echo BLOCKED=INSUFFICIENT_STORAGE_HEADROOM; exit 3; }
if [ -e "$DST_DIR" ] && [ ! -d "$DST_DIR" ]; then echo BLOCKED=IMAGE_DIRECTORY_NOT_DIR; exit 3; fi
install -d -o root -g root -m 0711 "$DST_DIR"
test ! -L "$DST_DIR"
TMP="$(mktemp "$DST_DIR/.base-qcow2.XXXXXXXX")"
cleanup() { rm -f -- "$TMP"; }
trap cleanup EXIT
cp -- "$SRC" "$TMP"
echo "$EXPECTED  $TMP" | sha256sum -c -
chown root:root "$TMP"
chmod 0644 "$TMP"
test ! -e "$DST"
mv -n -- "$TMP" "$DST"
test -f "$DST" || { echo BLOCKED=ATOMIC_INSTALL_FAILED; exit 5; }
echo "$EXPECTED  $DST" | sha256sum -c -
echo PINNED_NOBLE_BASE_SHA256=PASS
echo "FILE=$DST"
echo RESULT=PINNED_NOBLE_BASE_READY
echo RECEIPT_COMPLETE=YES
