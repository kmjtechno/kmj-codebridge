#!/usr/bin/env bash
# Reviewed, fixed, CI-only vendor runtimes. Never configure production clusters.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[[ $# == 0 && $EUID == 0 ]] || { echo CI_PREREQUISITES_REQUIRES_ROOT >&2; exit 2; }
[[ $(uname -m) == x86_64 ]] || { echo CI_PREREQUISITES_ARCH_UNSUPPORTED >&2; exit 3; }
base=/var/lib/kmj-codebridge-ci/prerequisites
prefix=/opt/kmj-codebridge-ci-prerequisites/versions/rust1.90.0-pg17.10-v1
repo=/srv/kmj-codebridge-projects/kmj-main-platform
runtime=/opt/kmj-codebridge-agent/scripts
for executable in /usr/bin/python3 /usr/bin/curl /usr/bin/systemd-run /usr/bin/git; do
  [[ -x $executable ]] || { echo CI_PREREQUISITES_BUILD_TOOL_MISSING >&2; exit 3; }
done
/usr/bin/python3 -I -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 3)' || { echo CI_PREREQUISITES_PYTHON_VERSION >&2; exit 3; }
/usr/bin/python3 -I - "$runtime" "$base" "$(dirname "$prefix")" "$base/cargo" /usr/lib/postgresql /usr/share/postgresql <<'PY'
import os,stat,sys
for path in sys.argv[1:]:
    while True:
        if os.path.lexists(path):
            m=os.lstat(path)
            if not stat.S_ISDIR(m.st_mode) or m.st_uid != 0 or m.st_mode & 0o022: raise SystemExit(3)
        if path == '/': break
        path=os.path.dirname(path)
PY
/usr/bin/python3 -I - "$runtime/ci-prerequisites-build.sh" "$runtime/validate-native-ci-cache.py" <<'PY'
import os,stat,sys
for path in sys.argv[1:]:
    m=os.lstat(path)
    if not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_nlink != 1 or m.st_mode & 0o6022: raise SystemExit(3)
PY
install -d -o root -g root -m 0711 "$base"
write_state() {
  local state=$1 tool=$2 temporary
  temporary=$(mktemp "$base/.status-XXXXXXXX")
  printf '{"schema":1,"state":"%s","missingTool":"%s"}\n' "$state" "$tool" > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$base/status.json"
}
missing_tool=""
/usr/bin/python3 -I - "$base/.install.lock" <<'LOCK_META'
import os,stat,sys
path=sys.argv[1]
if os.path.lexists(path):
    m=os.lstat(path)
    if not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_nlink != 1 or m.st_mode & 0o6077: raise SystemExit(3)
LOCK_META
exec 8>"$base/.install.lock"
flock -n 8 || { echo CI_PREREQUISITES_BUSY >&2; exit 4; }
write_state INSTALLING ""
work=""
builder_stage=""
publish=""
cache_stage=""
finish_prerequisite() {
  local result=$?
  if [[ $result != 0 ]]; then write_state FAILED "$missing_tool" || true; fi
  [[ $builder_stage == "$base"/builder-* ]] && rm -rf --one-file-system -- "$builder_stage" || true
  [[ $work == "$base"/prepare-* ]] && rm -rf --one-file-system -- "$work" || true
  [[ $publish == "$(dirname "$prefix")"/.runtime-* ]] && rm -rf --one-file-system -- "$publish" || true
  [[ $cache_stage == "$base"/cargo/.cache-* ]] && rm -rf --one-file-system -- "$cache_stage" || true
  return "$result"
}
trap finish_prerequisite EXIT
if ! id -u kmjci-build >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kmjci-build
fi
[[ $(id -G kmjci-build) == "$(id -g kmjci-build)" && $(getent passwd kmjci-build | cut -d: -f7) == /usr/sbin/nologin && $(id -gn kmjci-build) == kmjci-build ]] || { echo CI_PREREQUISITES_IDENTITY_UNSAFE >&2; exit 3; }
[[ $(id -u kmjci-build) != 0 && $(id -u kmjci-build) != "$(id -u kmjci)" ]] || exit 3
work=$(mktemp -d "$base/prepare-XXXXXXXX")
builder_stage=$(mktemp -d "$base/builder-XXXXXXXX")
chmod 0711 "$builder_stage"
install -o root -g root -m 0444 "$runtime/ci-prerequisites-build.sh" "$builder_stage/build.sh"

mkdir "$work/downloads" "$work/core"
git_read() { /usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -c safe.directory="$repo" -C "$repo" "$@"; }
base_source_sha=$(git_read rev-parse --verify HEAD)
[[ $base_source_sha =~ ^[a-f0-9]{40}$ ]] || { echo CI_PREREQUISITES_BASE_SHA_INVALID >&2; exit 3; }
# Both reviewed candidates must use the existing dependency lock and manifest.
for file in Cargo.lock Cargo.toml; do
  git_read show "$base_source_sha:services/license-core/$file" > "$work/core/$file"
  for sha in 70a5efb9a43103cd17be15d056e166cb19813efe 8ebbb6f1999309875b6f6b0c6d25c21847fff3ff; do
    [[ $(git_read show "$sha:services/license-core/$file" | sha256sum | cut -d' ' -f1) == "$(sha256sum "$work/core/$file" | cut -d' ' -f1)" ]] || { echo CI_PREREQUISITES_LOCK_CONFLICT >&2; exit 3; }
  done
done
/usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" lock "$work/core/Cargo.lock"
lock_digest=$(sha256sum "$work/core/Cargo.lock" | cut -d' ' -f1)
if [[ -d $prefix && ! -L $prefix ]]; then
  /usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" runtime "$prefix"
  /usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" verify "$base/cargo/$lock_digest" "$work/core/Cargo.lock"
  for link in /usr/lib/postgresql/17 /usr/share/postgresql/17; do
    expected="$prefix/postgres/bin/.."
    [[ $link != /usr/share/postgresql/17 ]] || expected="$prefix/postgres/share/postgresql"
    [[ ! -e $link && ! -L $link ]] || [[ -L $link && $(readlink "$link") == "$expected" && $(stat -c '%u' "$link") == 0 ]] || { echo CI_PREREQUISITES_INSTALL_CONFLICT >&2; exit 3; }
  done
  install -d -o root -g root -m 0755 /usr/lib/postgresql /usr/share/postgresql
  [[ -L /usr/lib/postgresql/17 ]] || ln -s "$prefix/postgres/bin/.." /usr/lib/postgresql/17
  [[ -L /usr/share/postgresql/17 ]] || ln -s "$prefix/postgres/share/postgresql" /usr/share/postgresql/17
  write_state READY ""
  echo CI_PREREQUISITES_ALREADY_INSTALLED
  exit 0
fi
[[ ! -e $prefix && ! -L $prefix && ! -e /usr/lib/postgresql/17 && ! -L /usr/lib/postgresql/17 && ! -e /usr/share/postgresql/17 && ! -L /usr/share/postgresql/17 ]] || { echo CI_PREREQUISITES_INSTALL_CONFLICT >&2; exit 3; }
for pair in CC:/usr/bin/cc MAKE:/usr/bin/make BISON:/usr/bin/bison FLEX:/usr/bin/flex PG_VIRTUALENV:/usr/bin/pg_virtualenv; do
  missing_tool=${pair%%:*}
  if [[ ! -x ${pair#*:} ]]; then
    write_state FAILED "$missing_tool"
    echo "CI_PREREQUISITES_BUILD_TOOL_MISSING=$missing_tool" >&2
    exit 3
  fi
done
missing_tool=""
# At most one expensive fetch/build per reviewed installed code+lock tuple.
# Missing refs/tools fail before this marker and may recover on CURRENT.
control_sha=$(/usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -c safe.directory=/opt/kmj-codebridge-agent -C /opt/kmj-codebridge-agent rev-parse --verify HEAD)
[[ $control_sha =~ ^[a-f0-9]{40}$ ]] || { echo CI_PREREQUISITES_CONTROL_SHA_INVALID >&2; exit 3; }
/usr/bin/python3 -I - "$base" "$control_sha" "$lock_digest" <<'ATTEMPT_META'
import json,os,re,stat,sys,tempfile
base,sha,digest=sys.argv[1:]
path=base+"/attempt.json"
try:
    if os.path.lexists(path):
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            m=os.fstat(fd)
            if not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_nlink != 1 or m.st_mode & 0o6077 or not 0 < m.st_size <= 512: raise ValueError()
            raw=os.read(fd,513)
            if len(raw)!=m.st_size: raise ValueError()
            record=json.loads(raw)
        finally: os.close(fd)
        if not isinstance(record,dict) or set(record) != {"schema","sha","lock"} or record["schema"] != 1 or not isinstance(record["sha"],str) or not re.fullmatch("[a-f0-9]{40}",record["sha"]) or not isinstance(record["lock"],str) or not re.fullmatch("[a-f0-9]{64}",record["lock"]): raise ValueError()
        if record == {"schema":1,"sha":sha,"lock":digest}:
            print("CI_PREREQUISITES_ALREADY_ATTEMPTED")
            raise SystemExit(3)
    fd,temporary=tempfile.mkstemp(prefix=".attempt-",dir=base)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w") as out: json.dump({"schema":1,"sha":sha,"lock":digest},out)
        os.replace(temporary,path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
except (OSError, ValueError):
    print("CI_PREREQUISITES_ATTEMPT_INVALID",file=sys.stderr)
    raise SystemExit(3)
ATTEMPT_META
fetch() {
  local name=$1 url=$2 digest=$3
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 --retry 2 "$url" -o "$work/downloads/$name"
  printf '%s  %s\n' "$digest" "$work/downloads/$name" | sha256sum --check --status || { echo CI_PREREQUISITES_VENDOR_HASH_MISMATCH >&2; exit 3; }
}
fetch rustc.tar.xz https://static.rust-lang.org/dist/2025-09-18/rustc-1.90.0-x86_64-unknown-linux-gnu.tar.xz 48c2a42de9e92fcae8c24568f5fe40d5734696a6f80e83cc6d46eef1a78f13c9
fetch cargo.tar.xz https://static.rust-lang.org/dist/2025-09-18/cargo-1.90.0-x86_64-unknown-linux-gnu.tar.xz 9853db03d68578a30972e2755c89c66aec035fec641cf8f3a7117c81eec2578d
fetch rust-std.tar.xz https://static.rust-lang.org/dist/2025-09-18/rust-std-1.90.0-x86_64-unknown-linux-gnu.tar.xz 663f4ab7945b392d5e5294dec1b050a66820a20e86f084ec37eeb0f2f7ff5569
fetch rustfmt.tar.xz https://static.rust-lang.org/dist/2025-09-18/rustfmt-1.90.0-x86_64-unknown-linux-gnu.tar.xz 7f4d38b9d782e55832bf17969ef35477703c60781545bb098eb127cc8172d1c6
fetch postgres.tar.bz2 https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.bz2 078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90
chown -R kmjci-build:kmjci-build "$work"
# Vendor installers and Cargo execute only as a distinct unprivileged identity.
# This is the only fixed network-enabled phase; exported manifests contain no
# repository configuration, build scripts or private credentials.
systemd-run --quiet --wait --collect --pipe -p User=kmjci-build -p Group=kmjci-build \
  -p NoNewPrivileges=yes -p PrivateTmp=yes -p PrivateDevices=yes -p ProtectHome=yes \
  -p ProtectSystem=strict -p ProtectProc=invisible -p CapabilityBoundingSet= -p RestrictSUIDSGID=yes \
  -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes \
  -p "InaccessiblePaths=/srv /etc/kmj-codebridge-main-platform /var/lib/kmj-codebridge-kmj-main-platform" \
  -p "ReadWritePaths=$work" -p MemoryMax=2G -p CPUQuota=200% -p RuntimeMaxSec=1200 \
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$work/home" LANG=C.UTF-8 \
  /bin/bash "$builder_stage/build.sh" "$work"
[[ $(sha256sum "$work/core/Cargo.lock" | cut -d' ' -f1) == "$lock_digest" ]] || { echo CI_PREREQUISITES_LOCK_CHANGED >&2; exit 3; }
# Root reads only regular verified cache artifacts, never invokes Cargo.
/usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" seal "$work/cargo" "$work/core/Cargo.lock" "$work/sealed"
lock_digest=$(sha256sum "$work/core/Cargo.lock" | cut -d' ' -f1)
# Reject links/privileged binaries before root-owned publication. Vendor outputs
# originate only from checksum-pinned archives, with no project code execution.
/usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" outputs "$work/output/rust" "$work/pg-install$prefix/postgres"
install -d -o root -g root -m 0755 "$(dirname "$prefix")" "$base/cargo"
publish=$(mktemp -d "$(dirname "$prefix")/.runtime-XXXXXXXX")
cache_stage=$(mktemp -d "$base/cargo/.cache-XXXXXXXX")

cp -a --no-preserve=ownership "$work/output/rust" "$publish/rust"
cp -a --no-preserve=ownership "$work/pg-install$prefix/postgres" "$publish/postgres"
cp -a --no-preserve=ownership "$work/sealed/." "$cache_stage/"
printf '%s\n' 'rust1.90.0-pg17.10-v1' > "$publish/vendor-version"
chown -R root:root "$publish" "$cache_stage"
chmod -R go-w "$publish" "$cache_stage"
chmod 0755 "$publish" "$cache_stage"
/usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" runtime "$publish"
/usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" verify "$cache_stage" "$work/core/Cargo.lock"
if [[ -e "$base/cargo/$lock_digest" || -L "$base/cargo/$lock_digest" ]]; then
  /usr/bin/python3 -I "$runtime/validate-native-ci-cache.py" verify "$base/cargo/$lock_digest" "$work/core/Cargo.lock"
else
  mv -- "$cache_stage" "$base/cargo/$lock_digest"
fi
mv -- "$publish" "$prefix"
install -d -o root -g root -m 0755 /usr/lib/postgresql /usr/share/postgresql
ln -s "$prefix/postgres/bin/.." /usr/lib/postgresql/17
ln -s "$prefix/postgres/share/postgresql" /usr/share/postgresql/17
write_state READY ""
printf 'CI_PREREQUISITES_INSTALLED\n'
