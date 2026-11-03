#!/bin/bash -p
# Owner-only fetch + run of the exact reviewed READ-ONLY Signed15 postcutover auditor.
# No service restarts, deployment, updater activation, or production pointer changes.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH GIT_CONFIG_SYSTEM GIT_CONFIG_GLOBAL
block() { printf 'KMJ_SIGNED15_READONLY_BUNDLE=BLOCKED_%s\n' "$1"; exit 2; }
[[ $- == *p* ]] || block PRIVILEGED_BASH_REQUIRED
[[ $# -eq 0 ]] || block ARGUMENTS
[[ "$(id -u)" == 0 && "$(hostname -s | tr '[:upper:]' '[:lower:]')" == kmj-elite ]] ||
  block ROOT_KMJ_ELITE_REQUIRED
readonly REPO="https://raw.githubusercontent.com/kmjtechno/kmj-codebridge"
readonly AUDITOR_REV=d251638eb568d6e1a9b4a3dce4dd329436ad0d8a
readonly REFERENCE_REV=cb46a972737f1459d0395b0147ca71a8cc9b2bc9
readonly AUDITOR_BLOB=7a717dea3b814643338b352517762fdf12aa1c11
readonly REFERENCE_BLOB=56f9e08119e8bb178be16dd213115d8f975b956a

work="$(/usr/bin/mktemp -d /root/kmj-signed15-readonly.XXXXXXXX)" || block TEMP
[[ -d "$work" && ! -L "$work" && "$(/usr/bin/stat -c '%u:%a:%h' -- "$work")" == '0:700:2' ]] ||
  block TEMP_METADATA
cleanup() {
  if [[ -n "${work:-}" && "$work" == /root/kmj-signed15-readonly.* &&
        -d "$work" && ! -L "$work" ]]; then
    /usr/bin/rm -rf -- "$work"
  fi
}
trap cleanup EXIT
download() {
  local rev=$1 name=$2
  /usr/bin/curl -fLSs --retry 2 --max-time 60 --connect-timeout 5 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "$REPO/$rev/scripts/production/$name" -o "$work/$name" ||
    block FETCH
}
download "$AUDITOR_REV" owner_verify_signed15_gateway_20261103.py
download "$REFERENCE_REV" owner_activate_signed15_gateway_20261103.py
if ! /usr/bin/python3 -I - "$work" "$AUDITOR_BLOB" "$REFERENCE_BLOB" <<'PY'
import hashlib
import os
from pathlib import Path
import stat
import sys
work=Path(sys.argv[1])
names=('owner_verify_signed15_gateway_20261103.py',
       'owner_activate_signed15_gateway_20261103.py')
for name,expected in zip(names,sys.argv[2:]):
    fd=os.open(work/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1
        assert 1<=st.st_size<=65536 and (st.st_mode&0o077)==0
        data=os.read(fd,65537)
        assert len(data)==st.st_size
        git_blob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        assert git_blob==expected
    finally:
        os.close(fd)
print('KMJ_SIGNED15_PINNED_SOURCES=PASS')
PY
then block SOURCE_INTEGRITY
fi
/usr/bin/python3 -B -I "$work/owner_verify_signed15_gateway_20261103.py" --inspect ||
  block POSTCUTOVER_AUDIT
printf 'KMJ_SIGNED15_READONLY_BUNDLE=PASS\n'
printf 'KMJ_PRODUCTION_MUTATION=NONE\n'
