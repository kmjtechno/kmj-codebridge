#!/usr/bin/env python3
"""Owner-root static release publication for signed stable seq31.

Creates ONLY the immutable directory stable/<seq31 sha>/ with the three
owner-signed files under the already-pinned static origin root. No service
restart, no updater, config or web-server change, no gateway switch, no `latest` move.
Dry-run by default; `--apply` is required to write anything.
"""
import base64
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys
import tempfile

REV = "c0505b74bf1b79df35f36fe0634f269bacf07f41"
PREVIOUS = "597037b07cac08729290d549c023111d1ab7e7c0"  # live signed seq30
# Main commit that contains releases/stable/<REV>/ (merge of #980).
SOURCE = "b1663cefc35272430cfa9a834ce234c8e506e5e0"
ARCHIVE = "kmj-codebridge-0.3.2-c0505b74bf1b.tar.gz"
BASE = (f"https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/"
        f"{SOURCE}/releases/stable/{REV}")
GITHUB = ("https://github.com/kmjtechno/kmj-codebridge/releases/download/"
          f"codebridge-stable-seq31-c0505b74/{ARCHIVE}")
PUBLIC = "https://kmjtechno.com/codebridge/releases/stable"
EXPECTED = {
    "release-manifest.json": (
        "033796347bfcde1a24b6b2eef629d3bc2d00b5591c74c618c9a99fc4b0342990", 512),
    "release-manifest.sig": (
        "49a8503782b7db11193d2e8fd738ed7c64a3e8e2e0c55b10ce3ba8e67bfdd431", 87),
    ARCHIVE: (
        "539f19da0838cb59d53b3b259929ab229146478412eaece2daf2283a96d4264b", 2368861),
}
NODE = "/opt/kmj-codebridge-node/bin/node"
CFG = "/etc/kmj-codebridge-update/stable-update.json"
# Exact release filesystem root, verified on KMJ-elite by read-only byte
# matching against the public manifests (see the seq27 publication script).
STATIC_ROOT = pathlib.Path("/var/lib/kmj-codebridge-releases/stable")
SPKI_PIN = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def fetch(url, path):
    result = subprocess.run(
        ["curl", "-fLSs", "--retry", "2", "--max-time", "90",
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
const valid=k.asymmetricKeyType==='ed25519' && fp===x.pin &&
c.verify(null,Buffer.from(x.manifest,'base64'),k,Buffer.from(x.signature,'base64url'));
if(!valid)process.exit(2);
"""
    payload = json.dumps({"key": key, "pin": SPKI_PIN,
                          "manifest": base64.b64encode(manifest).decode(),
                          "signature": signature.decode().strip()})
    p = subprocess.run([NODE, "-e", js], input=payload, text=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=30)
    guard(p.returncode == 0, "ELITE_ED25519_TRUST_FAILED")


def verify_static_root(tmp):
    """The root is trusted only if the live seq30 files on disk are
    byte-identical to what the public HTTPS origin serves."""
    for part in (STATIC_ROOT, STATIC_ROOT.parent):
        guard(not part.is_symlink(), "STATIC_ORIGIN_DIR_UNTRUSTED")
    mode = STATIC_ROOT.stat().st_mode
    guard(stat.S_ISDIR(mode) and not mode & 0o022, "STATIC_ORIGIN_DIR_UNTRUSTED")
    prev = STATIC_ROOT / PREVIOUS
    guard(prev.is_dir() and not prev.is_symlink(), "STATIC_ORIGIN_PATH_UNRESOLVED")
    for i, name in enumerate(("release-manifest.json", "release-manifest.sig")):
        local = prev / name
        guard(local.is_file() and not local.is_symlink(),
              "STATIC_ORIGIN_PATH_UNRESOLVED")
        guard(local.read_bytes() == fetch(f"{PUBLIC}/{PREVIOUS}/{name}",
                                          tmp / f"prev-{i}"),
              "STATIC_ORIGIN_PATH_UNRESOLVED")
    info = json.loads((prev / "release-manifest.json").read_bytes())
    guard(info.get("revision") == PREVIOUS and info.get("sequence") == 30,
          "PUBLIC_BASELINE_UNEXPECTED")


def publish_immutable(blobs):
    target = STATIC_ROOT / REV
    if target.exists() or target.is_symlink():
        guard(target.is_dir() and not target.is_symlink(),
              "EXISTING_RELEASE_UNEXPECTED")
        for name, data in blobs.items():
            candidate = target / name
            guard(candidate.is_file() and not candidate.is_symlink()
                  and candidate.read_bytes() == data, "EXISTING_RELEASE_UNEXPECTED")
        print("IMMUTABLE_FILES=ALREADY_MATCH")
        return
    os.mkdir(target, 0o755)
    os.chmod(target, 0o755)
    for name, data in blobs.items():
        fd = os.open(str(target / name),
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, "wb", closefd=False) as out:
                out.write(data)
                out.flush()
                os.fchmod(fd, 0o644)
                os.fsync(fd)
        finally:
            os.close(fd)
    guard(all((target / n).read_bytes() == v for n, v in blobs.items()),
          "PUBLISHED_FILE_BYTES_DIFFER")
    print("IMMUTABLE_FILES=CREATED")


def main():
    guard(os.geteuid() == 0
          and socket.gethostname().split(".")[0].lower() == "kmj-elite",
          "WRONG_ROOT_OR_HOST")
    guard(sys.argv[1:] in ([], ["--apply"]), "INVALID_ARGUMENT")
    guard(os.path.isfile(NODE) and os.access(NODE, os.X_OK), "PINNED_NODE_MISSING")
    config = root_config()
    with tempfile.TemporaryDirectory(prefix="kmj-signed31-", dir="/root") as directory:
        tmp = pathlib.Path(directory)
        blobs = {
            "release-manifest.json": fetch(BASE + "/release-manifest.json", tmp / "manifest"),
            "release-manifest.sig": fetch(BASE + "/release-manifest.sig", tmp / "signature"),
            ARCHIVE: fetch(GITHUB, tmp / "archive"),
        }
        for name, (digest, size) in EXPECTED.items():
            data = blobs[name]
            guard(len(data) == size
                  and hashlib.sha256(data).hexdigest() == digest,
                  "SIGNED_RELEASE_BYTES_INVALID")
        info = json.loads(blobs["release-manifest.json"])
        guard(info.get("revision") == REV and info.get("sequence") == 31
              and info.get("keyId") == "kmj-release-2026"
              and info.get("channel") == "stable"
              and info.get("sha256") == EXPECTED[ARCHIVE][0]
              and info.get("bytes") == EXPECTED[ARCHIVE][1]
              and info.get("archive") == f"{PUBLIC}/{REV}/{ARCHIVE}",
              "SIGNED_RELEASE_IDENTITY_MISMATCH")
        verify_signing(blobs["release-manifest.json"], blobs["release-manifest.sig"],
                       config["trustedKeys"]["kmj-release-2026"])
        print("SIGNATURE_AND_ARCHIVE=PASS")
        verify_static_root(tmp)
        print("STATIC_ORIGIN_MAPPING=PASS")
        if sys.argv[1:] != ["--apply"]:
            print("PUBLICATION=DRY_RUN_UNCHANGED")
            return
        publish_immutable(blobs)
        for i, (name, data) in enumerate(blobs.items()):
            actual = fetch(f"{PUBLIC}/{REV}/{name}", tmp / f"public-{i}")
            guard(actual == data, "PUBLIC_HTTPS_MISMATCH")
        print("PUBLIC_SIGNED31_ORIGIN=PASS")
        print("UPDATER_CONFIG=UNCHANGED")
        print("GATEWAY_SWITCH=NOT_ATTEMPTED")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        safe = {"WRONG_ROOT_OR_HOST", "INVALID_ARGUMENT", "PINNED_NODE_MISSING",
                "OWNER_TRUST_FILE_UNSAFE", "OWNER_TRUST_READ_INCOMPLETE",
                "TRUSTED_STABLE_KEY_ABSENT", "HTTPS_DOWNLOAD_FAILED",
                "ELITE_ED25519_TRUST_FAILED", "STATIC_ORIGIN_PATH_UNRESOLVED",
                "STATIC_ORIGIN_DIR_UNTRUSTED", "EXISTING_RELEASE_UNEXPECTED",
                "PUBLISHED_FILE_BYTES_DIFFER", "SIGNED_RELEASE_BYTES_INVALID",
                "SIGNED_RELEASE_IDENTITY_MISMATCH", "PUBLIC_BASELINE_UNEXPECTED",
                "PUBLIC_HTTPS_MISMATCH"}
        reason = str(error)
        print("PUBLICATION=BLOCKED")
        print("REASON=" + (reason if reason in safe else "UNCLASSIFIED"))
        sys.exit(2)
