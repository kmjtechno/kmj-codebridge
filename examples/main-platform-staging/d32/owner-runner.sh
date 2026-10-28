#!/usr/bin/env bash
# CANDIDATE ONLY. Install as fixed root-owned libexec after independent owner review.
# Never run directly from CodeBridge's mutable work/qa tree.
set -Eeuo pipefail
umask 077
cd /
export PATH=/opt/kmj-codebridge-node/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
qa=/srv/kmj-codebridge-projects/kmj-main-platform/work/qa
stage="$qa/KMJ_D32_PRODUCT_STUDIO_GUARDED_STAGE_CANDIDATE_20261028.sh"
source_sha=5e119d7512a3ca6e33b13bef9ad20d8d43445ed71c2d300f30cb15bb52c07f9b
approved=d32df111e3a8dae75c8d3321a80f07424c23fe77
prior=9d15e14e39564ffb1e66085a483feb8331f9718f
receipt="$qa/KMJ_D32_STAGING_RECEIPT_LATEST_20261028.txt"
deny(){ echo "KMJ_STAGING=BLOCKED_$1"; exit 2; }
[[ "$(hostname -s)" == KMJ-elite && "$(id -u)" -eq 0 ]] || deny ROOT_HOST
[[ -d "$qa" && ! -L "$qa" && -f "$stage" && ! -L "$stage" && ! -L "$receipt" ]] || deny SOURCE
# An owner-signed/offline manifest is mandatory. Never synthesize it here.
python3 - "$approved" "$prior" <<'PY' || deny OWNER_MANIFEST_OR_INSTALL
import hashlib,json,os,pathlib,stat,sys
expected,previous=sys.argv[1:]
root=pathlib.Path("/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh")
unit=pathlib.Path("/etc/systemd/system/kmj-main-platform-staging-deploy.service")
approval=pathlib.Path("/etc/kmj-codebridge/main-platform-staging-approval.json")
def protected(p,limit):
    for d in (p,*p.parents):
        s=d.lstat()
        if s.st_uid!=0 or s.st_mode & 0o022 or stat.S_ISLNK(s.st_mode):
            raise ValueError("UNPROTECTED_PATH")
        if d==p:
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size<1 or s.st_size>limit:
                raise ValueError("UNPROTECTED_FILE")
        elif not stat.S_ISDIR(s.st_mode):
            raise ValueError("UNPROTECTED_DIRECTORY")
    return p.read_bytes()
r=protected(root,131072)
u=protected(unit,16384)
# The manifest is an owner attestation, not authority to approve arbitrary
# systemd directives. Bind the executable unit to the reviewed fixed bytes.
if hashlib.sha256(u).hexdigest()!="9342fbacad8f05d52cde7df5fcf8d9599c3704e09f0edf3e6e48797c48af569a":
    raise ValueError("UNIT_SOURCE_SHA")
m=protected(approval,4096)
v=json.loads(m)
keys={"schema","approvedSha","expectedCurrentSha","expectedProductionRelease","runnerSha256","unitSha256","backupVerified","rollbackVerified","storageVerified","zeroAdditionalCostVerified"}
if not isinstance(v,dict) or set(v)!=keys: raise ValueError("MANIFEST_SCHEMA")
if v["schema"]!="kmj.main-platform.staging-approval.v1": raise ValueError("SCHEMA")
if v["approvedSha"]!=expected or v["expectedCurrentSha"]!=previous: raise ValueError("SHA")
if v["expectedProductionRelease"]!="platform-8070dad72c55": raise ValueError("PRODUCTION")
if not all(v[k] is True for k in ("backupVerified","rollbackVerified","storageVerified","zeroAdditionalCostVerified")):
    raise ValueError("OWNER_GATES")
if v["runnerSha256"]!=hashlib.sha256(r).hexdigest() or v["unitSha256"]!=hashlib.sha256(u).hexdigest():
    raise ValueError("ATTESTATION")
if b"ExecStart=/usr/bin/bash /usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh" not in u:
    raise ValueError("EXECSTART")
PY
# The manager's effective unit must match the reviewed on-disk unit.
# Reject drop-ins and a stale daemon cache even if the manifest hashes pass.
python3 - <<'PY' || deny SYSTEMD_EFFECTIVE_UNIT
import subprocess
name = "kmj-main-platform-staging-deploy.service"
keys = ("LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload")
result = subprocess.run(
    ["/usr/bin/systemctl", "show", name, "--no-pager",
     "--property=" + ",".join(keys)],
    capture_output=True, text=True, check=True, timeout=15,
)
pairs = [line.split("=", 1) for line in result.stdout.splitlines() if "=" in line]
values = dict(pairs)
if len(pairs) != len(keys) or set(values) != set(keys):
    raise ValueError("INCOMPLETE_OR_DUPLICATE_SYSTEMD_PROPERTIES")
if values["LoadState"] != "loaded":
    raise ValueError("SYSTEMD_UNIT_NOT_LOADED")
if values["FragmentPath"] != "/etc/systemd/system/kmj-main-platform-staging-deploy.service":
    raise ValueError("SYSTEMD_UNIT_PATH_DRIFT")
if values["DropInPaths"] != "":
    raise ValueError("SYSTEMD_DROPINS_FORBIDDEN")
if values["NeedDaemonReload"] != "no":
    raise ValueError("SYSTEMD_DAEMON_CACHE_STALE")
PY
[[ "$(readlink -f /home/kmjstage/htdocs/staging.kmjtechno.com)" == "/home/kmjstage/releases/$prior/apps/platform" ]] || deny STAGING_DRIFT
[[ "$(readlink -f /home/kmjprod/current)" == /home/kmjprod/releases/platform-8070dad72c55 ]] || deny PRODUCTION_DRIFT
protected=$(mktemp /root/.kmj-d32-source.XXXXXXXX)
private=$(mktemp /root/.kmj-d32-private.XXXXXXXX)
tmp=$(mktemp "$qa/.kmj-d32-receipt.XXXXXXXX")
trap 'rm -f -- "$protected" "$private" "$tmp"' EXIT
install -o root -g root -m 0400 "$stage" "$protected" || deny SOURCE_COPY
printf '%s  %s\n' "$source_sha" "$protected" | sha256sum -c - >/dev/null || deny SOURCE_SHA
bash -n "$protected" || deny SOURCE_SYNTAX
rc=0
bash "$protected" >"$private" 2>&1 || rc=$?
verdict=BLOCKED_REVIEW_REQUIRED
if [[ "$rc" -eq 0 ]] &&
   grep -qx 'STAGING_UI_UPDATE=PASS_EXACT_SHA' "$private" &&
   grep -qx "STAGING_SOURCE_SHA=$approved" "$private" &&
   grep -qx 'STAGING_DATABASE_MIGRATIONS=NONE' "$private" &&
   grep -qx 'PRODUCTION_RELEASE=UNCHANGED' "$private" &&
   grep -qx 'STAGING_LOSSLESS_OFFICIAL_LOGO=PASS_EXACT_BYTES' "$private" &&
   [[ "$(readlink -f /home/kmjstage/htdocs/staging.kmjtechno.com)" == "/home/kmjstage/releases/$approved/apps/platform" ]] &&
   [[ "$(readlink -f /home/kmjprod/current)" == /home/kmjprod/releases/platform-8070dad72c55 ]]; then
  verdict=PASS_EXACT_SHA_OWNER_QA_PENDING
fi
{
 echo SCHEMA=kmj.d32-staging-receipt.v1
 printf 'OBSERVED_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
 echo "EXPECTED_OLD_SHA=$prior"
 echo "TARGET_SHA=$approved"
 echo "STAGING_VERDICT=$verdict"
 printf 'STAGING_SCRIPT_EXIT_CODE=%s\n' "$rc"
 for key in STAGING_UI_UPDATE STAGING_UI_ROLLBACK STAGING_DEPENDENCY_METADATA STAGING_UPLOAD_STORAGE STAGING_DATABASE_MIGRATIONS STAGING_LOSSLESS_OFFICIAL_LOGO STAGING_TRANSPARENT_LOGO STAGING_READABLE_VECTOR_TAGLINE PRODUCTION_RELEASE STAGING_OFFLINE_DRAFT STAGING_CLOUD_REQUESTS STAGING_PRODUCT_WRITES; do
   grep -E "^$key=[A-Z0-9_]+$" "$private" | tail -n 1 || true
 done
 echo OWNER_AUTHENTICATED_GENERATE_SAVE_REOPEN=NOT_VERIFIED
 echo ARTWORK_IMAGE_SPECIFIC_QA=NOT_VERIFIED
 echo PRODUCTION_DEPLOYMENT=NOT_ATTEMPTED
} >"$tmp"
chmod 0644 "$tmp"
mv -Tf "$tmp" "$receipt"
echo STAGING_RECEIPT=WRITTEN
echo "STAGING_RECEIPT_VERDICT=$verdict"
[[ "$verdict" == PASS_EXACT_SHA_OWNER_QA_PENDING ]]
