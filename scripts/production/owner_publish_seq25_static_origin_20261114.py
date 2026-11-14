#!/usr/bin/env python3
"""Owner-root static release publication: immutable files only, no service restart."""
import base64
import hashlib
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

REV = "55a3f976fd3b71e36b4dcb1864b04d43364418ac"
PREVIOUS = "dd1ccf3232f9678df6e8e87172c36ff4397c0cac"
SOURCE = "4ec317ffc5c03562749c527136830e00404a30f9"
ARCHIVE = "kmj-codebridge-0.3.2-55a3f976fd3b.tar.gz"
BASE = f"https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/{SOURCE}/releases/stable/{REV}"
GITHUB = f"https://github.com/kmjtechno/kmj-codebridge/releases/download/codebridge-stable-seq25-55a3f976/{ARCHIVE}"
EXPECTED = {
    "release-manifest.json": ("b5ef475a9b022ec903239b4b71ab01cf8dcdd849d84de3b59ee7cc0ccf5ea09b", 512),
    "release-manifest.sig": (None, 87),
    ARCHIVE: ("53616081681470f7b6a2e56482c625f7a098dde474c0231ee7a8851ebc863f66", 2178098),
}
NODE = "/opt/kmj-codebridge-node/bin/node"
CFG = "/etc/kmj-codebridge-update/stable-update.json"
# Exact old release filesystem root verified on KMJ-elite by read-only
# Nginx/public-manifest byte matching on 2026-11-03.
PINNED_STATIC_STABLE_ROOT = pathlib.Path("/var/lib/kmj-codebridge-releases/stable")

def guard(ok, code):
    if not ok:
        raise ValueError(code)

def fetch(url, path):
    result = subprocess.run(["curl", "-fLSs", "--retry", "2", "--max-time", "90",
        "--proto", "=https", "--proto-redir", "=https", url, "-o", str(path)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=105)
    guard(result.returncode == 0, "HTTPS_DOWNLOAD_FAILED")
    return path.read_bytes()

def root_config():
    fd = os.open(CFG, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        guard(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
              and st.st_size <= 65536 and (st.st_mode & 0o077) == 0,
              "OWNER_TRUST_FILE_UNSAFE")
        raw = os.read(fd, 65537)
        guard(len(raw) == st.st_size, "OWNER_TRUST_READ_INCOMPLETE")
    finally:
        os.close(fd)
    obj = json.loads(raw)
    guard(obj.get("channel") == "stable"
          and "kmj-release-2026" in obj.get("trustedKeys", {}),
          "TRUSTED_STABLE_KEY_ABSENT")
    return obj

def verify_signing(manifest, signature, key):
    js = """
const fs=require('node:fs'),c=require('node:crypto'),x=JSON.parse(fs.readFileSync(0,'utf8'));
const k=c.createPublicKey(x.key);
const fp=c.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex');
const valid=k.asymmetricKeyType==='ed25519' &&
fp==='2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8' &&
c.verify(null,Buffer.from(x.manifest,'base64'),k,Buffer.from(x.signature,'base64url'));
if(!valid)process.exit(2);
"""
    payload = json.dumps({"key": key, "manifest": base64.b64encode(manifest).decode(),
                          "signature": signature.decode().strip()})
    p = subprocess.run([NODE, "-e", js], input=payload, text=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    guard(p.returncode == 0, "ELITE_ED25519_TRUST_FAILED")

def find_static_release_parent(old_url, old_bytes):
    parts = urlsplit(old_url)
    public = f"/codebridge/releases/stable/{PREVIOUS}/release-manifest.json"
    guard(parts.scheme == "https" and parts.netloc == "kmjtechno.com"
          and parts.path == public and not parts.query and not parts.fragment,
          "BASELINE_RELEASE_URL_UNEXPECTED")
    ng = subprocess.run(["nginx", "-T"], capture_output=True, text=True,
        errors="replace", timeout=35)
    guard(ng.returncode == 0 and len(ng.stdout) < 2000000,
          "NGINX_CONFIG_NOT_VERIFIED")
    roots = {"/var/www/html", "/usr/share/nginx/html", "/home/kmjprod/current/public",
             "/var/www/kmjtechno.com", "/home/kmjprod/public"}
    aliases = set()
    for raw in ng.stdout.splitlines():
        matched = re.match(r"^\s*(root|alias)\s+(/[^;\s]+)\s*;", raw)
        if matched and "$" not in matched.group(2):
            (roots if matched.group(1) == "root" else aliases).add(matched.group(2))
    candidates = {pathlib.Path(root) / public.lstrip("/") for root in roots}
    # The production vhost serves the releases through a distinct static
    # alias root not reconstructible from a generic URL-to-root join. This
    # previously caused STATIC_ORIGIN_PATH_UNRESOLVED. Do not blindly trust
    # the path: require exact bytes of the already-public signed14 manifest
    # and unique matching root, as for every other discovered candidate.
    candidates.add(
        PINNED_STATIC_STABLE_ROOT / PREVIOUS / "release-manifest.json"
    )
    for alias in aliases:
        candidates.add(pathlib.Path(alias) / f"stable/{PREVIOUS}/release-manifest.json")
        candidates.add(pathlib.Path(alias) / public.lstrip("/"))
    matches = set()
    for candidate in candidates:
        try:
            if (candidate.is_symlink() or candidate.parent.is_symlink()
                or candidate.parent.parent.is_symlink()
                or not candidate.is_file() or candidate.parent.name != PREVIOUS):
                continue
            if candidate.read_bytes() == old_bytes:
                matches.add(candidate.parent.parent.resolve(strict=True))
        except OSError:
            pass
    guard(len(matches) == 1, "STATIC_ORIGIN_PATH_UNRESOLVED")
    parent = matches.pop()
    mode = parent.stat().st_mode
    guard(stat.S_ISDIR(mode) and not mode & 0o022, "STATIC_ORIGIN_DIR_UNTRUSTED")
    return parent

def publish_immutable(parent, blobs):
    target = parent / REV
    if target.exists() or target.is_symlink():
        for name, data in blobs.items():
            candidate = target / name
            guard(candidate.is_file() and not candidate.is_symlink()
                  and candidate.read_bytes() == data, "EXISTING_RELEASE_UNEXPECTED")
        print("IMMUTABLE_FILES=ALREADY_MATCH")
        return
    os.mkdir(target, 0o755)
    os.chmod(target, 0o755)
    for name, data in blobs.items():
        fd = os.open(str(target / name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, "wb", closefd=False) as out:
                out.write(data)
                out.flush()
                os.fchmod(fd, 0o644)
                os.fsync(fd)
        finally:
            os.close(fd)
    guard(all((target / n).read_bytes() == v for n,v in blobs.items()),
          "PUBLISHED_FILE_BYTES_DIFFER")
    print("IMMUTABLE_FILES=CREATED")

def main():
    guard(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower() == "kmj-elite",
          "WRONG_ROOT_OR_HOST")
    guard(sys.argv[1:] in ([], ["--apply"]), "INVALID_ARGUMENT")
    guard(os.path.isfile(NODE) and os.access(NODE, os.X_OK), "PINNED_NODE_MISSING")
    config = root_config()
    with tempfile.TemporaryDirectory(prefix="kmj-signed25-", dir="/root") as directory:
        tmp = pathlib.Path(directory)
        blobs = {
            "release-manifest.json": fetch(BASE + "/release-manifest.json", tmp / "manifest"),
            "release-manifest.sig": fetch(BASE + "/release-manifest.sig", tmp / "signature"),
            ARCHIVE: fetch(GITHUB, tmp / "archive"),
        }
        for name,(digest,size) in EXPECTED.items():
            data = blobs[name]
            guard(len(data) == size and (digest is None or
                  hashlib.sha256(data).hexdigest() == digest),
                  "SIGNED_RELEASE_BYTES_INVALID")
        info = json.loads(blobs["release-manifest.json"])
        guard(info.get("revision") == REV and info.get("sequence") == 25
              and info.get("keyId") == "kmj-release-2026"
              and info.get("channel") == "stable"
              and info.get("sha256") == EXPECTED[ARCHIVE][0]
              and info.get("bytes") == EXPECTED[ARCHIVE][1]
              and info.get("archive") == f"https://kmjtechno.com/codebridge/releases/stable/{REV}/{ARCHIVE}",
              "SIGNED_RELEASE_IDENTITY_MISMATCH")
        verify_signing(blobs["release-manifest.json"],blobs["release-manifest.sig"],
                       config["trustedKeys"]["kmj-release-2026"])
        print("SIGNATURE_AND_ARCHIVE=PASS")
        old_bytes = fetch(config["manifestUrl"], tmp / "old")
        old = json.loads(old_bytes)
        guard(old.get("revision") == PREVIOUS and int(old.get("sequence",-1)) < 25,
              "PUBLIC_BASELINE_UNEXPECTED")
        parent = find_static_release_parent(config["manifestUrl"], old_bytes)
        print("STATIC_ORIGIN_MAPPING=PASS")
        if sys.argv[1:] != ["--apply"]:
            print("PUBLICATION=DRY_RUN_UNCHANGED")
            return
        publish_immutable(parent, blobs)
        for i,(name,data) in enumerate(blobs.items()):
            actual = fetch(f"https://kmjtechno.com/codebridge/releases/stable/{REV}/{name}",
                           tmp / f"public-{i}")
            guard(actual == data, "PUBLIC_HTTPS_MISMATCH")
        print("PUBLIC_SIGNED25_ORIGIN=PASS")
        print("UPDATER_CONFIG=UNCHANGED")
        print("GATEWAY_SWITCH=NOT_ATTEMPTED")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        safe = {"WRONG_ROOT_OR_HOST","INVALID_ARGUMENT","PINNED_NODE_MISSING",
                "OWNER_TRUST_FILE_UNSAFE","OWNER_TRUST_READ_INCOMPLETE",
                "TRUSTED_STABLE_KEY_ABSENT","HTTPS_DOWNLOAD_FAILED",
                "ELITE_ED25519_TRUST_FAILED","BASELINE_RELEASE_URL_UNEXPECTED",
                "NGINX_CONFIG_NOT_VERIFIED","STATIC_ORIGIN_PATH_UNRESOLVED",
                "STATIC_ORIGIN_DIR_UNTRUSTED","EXISTING_RELEASE_UNEXPECTED",
                "PUBLISHED_FILE_BYTES_DIFFER","SIGNED_RELEASE_BYTES_INVALID",
                "SIGNED_RELEASE_IDENTITY_MISMATCH","PUBLIC_BASELINE_UNEXPECTED",
                "PUBLIC_HTTPS_MISMATCH"}
        reason = str(error)
        print("PUBLICATION=BLOCKED")
        print("REASON=" + (reason if reason in safe else "UNCLASSIFIED"))
        sys.exit(2)
