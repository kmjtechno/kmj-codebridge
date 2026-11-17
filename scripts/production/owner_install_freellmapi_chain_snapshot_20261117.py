#!/usr/bin/env python3
"""Owner-root install of a read-only FreeLLMAPI chain-membership snapshot.

Why: the router database lives in a 0700 directory of its own service user, and
the CodeBridge agent must NOT be given access to a database that holds encrypted
provider keys and dashboard credentials. This installs a tiny timer, running as
the router's own user (not root), that writes ONLY {platform, modelId} of one
named chain to /var/lib/kmj-freellmapi-chain/<name>.json every minute. The
zero-cost verifier requires the snapshot to be fresh (<= 120 s) and equal to the
owner-pinned manifest, so chain drift is detected with at most that delay.

Dry-run by default. Writing needs: <chain> --apply --confirm-install-snapshot
It enables nothing else: no generation, no key, no gateway/agent change.
"""
import os
import pathlib
import pwd
import re
import subprocess
import sys

USER = "kmj-freellmapi"
DB = "/opt/kmj-freellmapi/data/freeapi.db"
LIB = pathlib.Path("/usr/local/lib/kmj-freellmapi")
HELPER = LIB / "chain-snapshot.py"
OUT = pathlib.Path("/var/lib/kmj-freellmapi-chain")
SERVICE = pathlib.Path("/etc/systemd/system/kmj-freellmapi-chain-snapshot.service")
TIMER = pathlib.Path("/etc/systemd/system/kmj-freellmapi-chain-snapshot.timer")
CHAIN = re.compile(r"^auto:[A-Za-z0-9._-]{1,48}$")

HELPER_SOURCE = r'''#!/usr/bin/env python3
"""Write a minimal chain-membership snapshot. Read-only DB access, no secrets."""
import json, os, pathlib, re, sqlite3, sys, tempfile, time
CHAIN = re.compile(r"^auto:[A-Za-z0-9._-]{1,48}$")
QUERY = """SELECT m.platform, m.model_id FROM profiles p
JOIN profile_models pm ON pm.profile_id = p.id AND pm.enabled = 1
JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
WHERE LOWER(p.name) = ? ORDER BY m.platform, m.model_id"""
def main(db, out_dir, chain):
    if not CHAIN.match(chain):
        raise SystemExit("BAD_CHAIN")
    uri = pathlib.Path(db).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=10)
    try:
        rows = con.execute(QUERY, (chain.split(":", 1)[1].lower(),)).fetchall()
    finally:
        con.close()
    body = {"version": 1, "chain": chain,
            "observedAtEpochMs": int(time.time() * 1000),
            "members": [{"platform": p, "modelId": m} for p, m in rows]}
    out = pathlib.Path(out_dir)
    fd, tmp = tempfile.mkstemp(dir=out, prefix=".snap-")
    with os.fdopen(fd, "w") as fh:
        json.dump(body, fh)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out / (chain.split(":", 1)[1] + ".json"))
if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
'''


def unit_texts(chain):
    service = f"""[Unit]
Description=FreeLLMAPI chain-membership snapshot ({chain})

[Service]
Type=oneshot
User={USER}
Group={USER}
ExecStart=/usr/bin/python3 -I {HELPER} {DB} {OUT} {chain}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={OUT} /opt/kmj-freellmapi/data
"""
    timer = """[Unit]
Description=FreeLLMAPI chain-membership snapshot timer

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
"""
    return service, timer


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def sh(*cmd, check=True):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                          check=check)


def rollback():
    sh("systemctl", "disable", "--now", TIMER.name, check=False)
    for p in (TIMER, SERVICE, HELPER):
        p.unlink(missing_ok=True)
    sh("systemctl", "daemon-reload", check=False)


def main(argv):
    guard(len(argv) in (1, 3) and CHAIN.match(argv[0]), "USAGE_CHAIN_auto:<name>")
    guard(argv[1:] in ([], ["--apply", "--confirm-install-snapshot"]),
          "USAGE_--apply_--confirm-install-snapshot")
    chain = argv[0]
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    pwd.getpwnam(USER)
    guard(pathlib.Path(DB).is_file(), "DB_NOT_FOUND")
    for p in (SERVICE, TIMER, HELPER, OUT):
        guard(not p.exists(), "ALREADY_INSTALLED_" + p.name)
    print(f"PREFLIGHT=OK CHAIN={chain}")
    if len(argv) == 1:
        print("SNAPSHOT=DRY_RUN_UNCHANGED")
        return
    service, timer = unit_texts(chain)
    try:
        LIB.mkdir(mode=0o755, exist_ok=True)
        HELPER.write_text(HELPER_SOURCE)
        HELPER.chmod(0o644)
        OUT.mkdir(mode=0o755)
        os.chown(OUT, pwd.getpwnam(USER).pw_uid, pwd.getpwnam(USER).pw_gid)
        SERVICE.write_text(service)
        TIMER.write_text(timer)
        sh("systemctl", "daemon-reload")
        sh("systemctl", "start", SERVICE.name)
        snap = OUT / (chain.split(":", 1)[1] + ".json")
        guard(snap.is_file(), "FIRST_SNAPSHOT_MISSING")
        sh("systemctl", "enable", "--now", TIMER.name)
    except BaseException:
        rollback()
        print("SNAPSHOT=FAILED_ROLLED_BACK")
        raise
    print(f"SNAPSHOT=OK {snap} (refreshed every 60s; contains platform+modelId only)")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, subprocess.CalledProcessError) as exc:
        print(f"BLOCKED={exc if isinstance(exc, ValueError) else type(exc).__name__}")
        sys.exit(2)
