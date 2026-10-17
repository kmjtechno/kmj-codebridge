#!/usr/bin/env bash
# Explicit, pinned and checksum-verified Moli binary staging only.
# Does NOT restart CodeBridge, modify production, register runners or publish ports.
set -Eeuo pipefail
umask 077
die() { printf 'MOLI_INSTALL=BLOCKED reason=%s\n' "$1" >&2; exit 1; }
test "$(id -u)" -eq 0 || die ROOT_REQUIRED
test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64 || die UNSUPPORTED_HOST
for tool in curl sha256sum python3; do command -v "$tool" >/dev/null || die "MISSING_$tool"; done

version=1.1.18
sha=59715fbdb2b016bb9136e1edb59a2a195c0f98459fd06739e17edc62da6a48b1
asset=moli-x86_64-unknown-linux-gnu.tar.gz
url=https://github.com/lexmount/moli/releases/download/v1.1.18/$asset
destination=/opt/kmj-codebridge-tools/moli/v1.1.18/bin/moli

test ! -L /opt/kmj-codebridge-tools || die UNSAFE_PARENT_SYMLINK
test ! -L /opt/kmj-codebridge-tools/moli || die UNSAFE_ROOT_SYMLINK
test ! -L /opt/kmj-codebridge-tools/moli/v1.1.18 || die UNSAFE_RELEASE_SYMLINK
test ! -e "$destination" && test ! -L "$destination" || die ALREADY_INSTALLED

tmp=$(mktemp -d /tmp/kmj-moli-pinned-XXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fLsS --retry 2 --connect-timeout 8 --max-time 180 "$url" -o "$tmp/$asset" || die FETCH_FAILED
printf '%s  %s\n' "$sha" "$tmp/$asset" | sha256sum -c - >/dev/null || die HASH_MISMATCH

# Inspect members without unsafe tar extraction. Reject link/absolute/path traversal.
python3 -B - "$tmp/$asset" "$tmp/moli" <<'PY'
import os
import sys
import tarfile
archive, output = sys.argv[1:]
with tarfile.open(archive, "r:gz") as pack:
    members = [m for m in pack.getmembers() if m.isfile() and m.name.strip("./").endswith("/moli")]
    members += [m for m in pack.getmembers() if m.isfile() and m.name.strip("./") == "moli"]
    if len(members) != 1:
        raise SystemExit("BINARY_MEMBER_MISSING_OR_AMBIGUOUS")
    member = members[0]
    if member.name.startswith("/") or ".." in member.name.split("/") or member.size > 256*1024*1024:
        raise SystemExit("UNSAFE_BINARY_MEMBER")
    source = pack.extractfile(member)
    if source is None:
        raise SystemExit("BINARY_CONTENT_MISSING")
    with source, open(output, "xb") as target:
        while data := source.read(1024*1024):
            target.write(data)
    os.chmod(output, 0o700)
PY
install -d -o root -g root -m 0755 /opt/kmj-codebridge-tools /opt/kmj-codebridge-tools/moli /opt/kmj-codebridge-tools/moli/v1.1.18 /opt/kmj-codebridge-tools/moli/v1.1.18/bin
install -o root -g root -m 0755 "$tmp/moli" "$destination"
# Pinned bytes are known, but treat execution failure as failed release readiness.
if "$destination" --version > "$tmp/version.txt" 2>&1 && grep -q "$version" "$tmp/version.txt"; then
  echo "MOLI_INSTALL=PASS"
  echo "MOLI_VERSION=$version"
  echo "CODEBRIDGE_AGENT_RESTART=NO"
  echo "BROWSER_FAST_RELEASE=CODEBRIDGE_RUNTIME_UPDATE_STILL_REQUIRED"
else
  rm -f -- "$destination"
  die VERSION_PROBE_FAILED
fi
