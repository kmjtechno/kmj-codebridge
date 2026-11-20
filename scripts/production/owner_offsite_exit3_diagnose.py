#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-CLICK, READ-ONLY: why did the offsite backup exit 3?

Runs the two diagnostics from kmj-main-platform PR #909 (exact commit below),
each verified against a pinned SHA-256 before it is executed:
  diagnose-offsite-exit3-20261117.py              (exact-invocation journal class)
  diagnose-offsite-exit3-phase-hostkey-20261120.py (stage + public host-key pin)
Both print only enumerated tokens: no raw journal, no secrets, no repair, no
backup run, no SFTP login, no production approval. This wrapper itself changes
nothing on the host except a 0600 log under /root.

  python3 -I owner_offsite_exit3_diagnose.py
"""
import hashlib
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

COMMIT = "8eb766b485af6d4282b209de966990de93d1eb74"
BASE = "https://raw.githubusercontent.com/kmjtechno/kmj-main-platform/" + COMMIT + "/scripts/operations/"
FILES = {
    "diagnose-offsite-exit3-20261117.py": "efa88c7376f78c8de9c4ea2467157a10041bd60fd686375abf75fd4eb03906e9",
    "diagnose-offsite-exit3-phase-hostkey-20261120.py": "75f476204cb9c56c86d20a693688128fc3011fc48c5c03425e90c6de06767309",
}
MAX_BYTES = 65536
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": "/root"}


class Blocked(Exception):
    pass


def verify_blob(name, data):
    pin = FILES.get(name)
    if pin is None:
        raise Blocked("UNKNOWN_FILE")
    if not 0 < len(data) <= MAX_BYTES:
        raise Blocked("SIZE_OUT_OF_RANGE:" + name)
    if hashlib.sha256(data).hexdigest() != pin:
        raise Blocked("SHA_MISMATCH:" + name)
    return data


def fetch(name):
    with urllib.request.urlopen(BASE + name, timeout=30) as r:
        if r.status != 200:
            raise Blocked("FETCH_FAILED:" + name)
        return r.read(MAX_BYTES + 1)


def main(argv):
    if argv:
        print("KMJ_EXIT3_DIAGNOSE=BLOCKED:NO_ARGUMENTS_ACCEPTED")
        return 2
    if getattr(os, "geteuid", lambda: 1)() != 0:
        print("KMJ_EXIT3_DIAGNOSE=BLOCKED:NOT_ROOT")
        return 2
    if socket.gethostname().split(".")[0].lower() != "kmj-elite":
        print("KMJ_EXIT3_DIAGNOSE=BLOCKED:WRONG_HOST")
        return 2
    log = pathlib.Path("/root/offsite-exit3-diagnose-%d.log" % int(time.time()))
    lines = []
    try:
        with tempfile.TemporaryDirectory(prefix="kmj-exit3-", dir="/root") as tmp:
            os.chmod(tmp, 0o700)
            for name in FILES:
                path = os.path.join(tmp, name)
                data = verify_blob(name, fetch(name))
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                lines.append("== " + name + " sha256=PASS")
                r = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", path, "--inspect"],
                    env=ENV, cwd="/", stdin=subprocess.DEVNULL,
                    capture_output=True, timeout=90, check=False,
                )
                out = r.stdout.decode("utf8", "replace")[:4096]
                lines.append(out.rstrip())
                lines.append("exit=%d" % r.returncode)
    except (Blocked, OSError, subprocess.TimeoutExpired) as e:
        print("KMJ_EXIT3_DIAGNOSE=BLOCKED:" + (e.args[0] if isinstance(e, Blocked) else type(e).__name__))
        return 2
    text = "\n".join(lines) + "\n"
    fd = os.open(str(log), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    print(text, end="")
    print("KMJ_EXIT3_DIAGNOSE=DONE log=" + str(log))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
