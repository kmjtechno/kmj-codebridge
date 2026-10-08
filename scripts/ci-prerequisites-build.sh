#!/usr/bin/env bash
# Fixed vendor builds run as a distinct nologin identity, never root/PR worker.
set -Eeuo pipefail
[[ $# -eq 1 && "$1" == /var/lib/kmj-codebridge-ci/prerequisites/prepare-* ]] || exit 2
[[ "$EUID" -eq "$(id -u kmjci-build)" && "$EUID" -ne 0 ]] || exit 2
work="$1"
mkdir -p "$work/output/rust" "$work/home" "$work/unpack"
for component in rustc cargo rust-std rustfmt; do
  mkdir "$work/unpack/$component"
  /usr/bin/python3 -I - "$work/downloads/$component.tar.xz" "$work/unpack/$component" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
  mapfile -t installers < <(find "$work/unpack/$component" -mindepth 2 -maxdepth 2 -name install.sh -type f)
  [[ ${#installers[@]} -eq 1 ]] || exit 3
  /bin/bash "${installers[0]}" --prefix="$work/output/rust" --disable-ldconfig
 done
mkdir "$work/unpack/postgres"
/usr/bin/python3 -I - "$work/downloads/postgres.tar.bz2" "$work/unpack/postgres" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
cd "$work/unpack/postgres/postgresql-17.10"
# Production PG cluster configuration and service management are never touched.
./configure --prefix=/opt/kmj-codebridge-ci-prerequisites/versions/rust1.90.0-pg17.10-v1/postgres --without-icu --without-readline --without-zlib --without-ssl --disable-nls
make -j2
make DESTDIR="$work/pg-install" install
mkdir -p "$work/core/src"
printf '\n' > "$work/core/src/lib.rs"
# Cargo fetch runs in a fresh exported manifest workspace. No repository config,
# build scripts, private keys, credentials or root Cargo invocation are allowed.
/usr/bin/env -i PATH="$work/output/rust/bin:/usr/bin:/bin" HOME="$work/home" CARGO_HOME="$work/cargo" CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse CARGO_TERM_COLOR=never "$work/output/rust/bin/cargo" fetch --locked --manifest-path "$work/core/Cargo.toml"
