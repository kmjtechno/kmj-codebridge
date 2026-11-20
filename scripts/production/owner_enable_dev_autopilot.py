#!/usr/bin/env python3
"""Owner-root, one-time: turn on the bounded 24x7 loops for the Elite
kmj-codebridge DEV agent (docs/AUTOPILOT-CI-WATCH.md, AUTOPILOT-ISOLATED-REPAIR.md).

Adds ONLY to the dev agent's own config (never the Main Platform agent):
  * gates format_src / fast_check (prettier --write / --check, fixed argv)
  * autopilotRepairWorker recipe "format" (paths allowlist; patch stops at
    VERIFIED_PATCH_AWAITING_REVIEW, nothing is pushed, merged or deployed)
  * autopilotCiWatch on public kmjtechno/kmj-codebridge main (read-only, 15 min)
and installs a non-root timer that fast-forwards the dev checkout to origin/main
only when it is on main and completely clean.
No coding/inference worker, no model, no secrets, no new permissions.

  python3 -I owner_enable_dev_autopilot.py                  # dry run
  python3 -I owner_enable_dev_autopilot.py --apply --confirm-restart-dev-agent
"""
import copy
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

PROJECT_ID = "kmj-codebridge"
CONFIG = pathlib.PurePosixPath("/etc/kmj-codebridge-dev/agent.json")
SERVICE = "kmj-codebridge-dev.service"
SYNC = "kmj-codebridge-dev-sync"
RUNTIME = "/opt/kmj-codebridge-stable/current"
NODE = "/opt/kmj-codebridge-node/bin/node"
BACKUP_DIR = "/root/dev-autopilot-backup"
PATHS = ["src/", "scripts/", "tests/", "plugin/", "docs/", "README.md"]
FORMAT_ARGS = ["src", "scripts", "tests", "plugin", "docs/*.md", "README.md"]


def die(code, why):
    print("RESULT=BLOCKED:" + code, file=sys.stderr)
    if why:
        print(why, file=sys.stderr)
    sys.exit(2)


def gates_for(root):
    prettier = root.rstrip("/") + "/node_modules/.bin/prettier"
    return {
        "format_src": {"command": prettier, "args": ["--write"] + FORMAT_ARGS, "timeoutMs": 240000},
        "fast_check": {"command": prettier, "args": ["--check"] + FORMAT_ARGS, "timeoutMs": 240000},
    }


def desired(root):
    return {
        "gates": gates_for(root),
        "autopilotRepairWorker": {
            "enabled": True,
            "recipes": {"format": {"fixGate": "format_src", "verifyGate": "fast_check", "paths": list(PATHS)}},
        },
        "autopilotCiWatch": {
            "enabled": True,
            "repository": "kmjtechno/kmj-codebridge",
            "branch": "main",
            "workflow": "CodeBridge CI",
            "job": "verify (ubuntu-24.04)",
            "recipe": "format",
            "publicReadOnly": True,
            "intervalSeconds": 900,
        },
    }


def enable(cfg):
    """Pure: return (new_cfg, changed). Refuses anything it would have to overwrite."""
    new = copy.deepcopy(cfg)
    projects = new.get("projects")
    if not isinstance(projects, list):
        raise ValueError("NO_PROJECTS")
    matches = [p for p in projects if isinstance(p, dict) and p.get("id") == PROJECT_ID]
    if len(matches) != 1:
        raise ValueError("PROJECT_NOT_FOUND")
    proj = matches[0]
    if proj.get("writable") is not True:
        raise ValueError("PROJECT_NOT_WRITABLE")
    want = desired(proj["root"])
    changed = False
    gates = proj.setdefault("gates", {})
    for name, gate in want["gates"].items():
        if name in gates and gates[name] != gate:
            raise ValueError("GATE_CONFLICT:" + name)
        if name not in gates:
            gates[name] = gate
            changed = True
    for key in ("autopilotRepairWorker", "autopilotCiWatch"):
        if key in proj and proj[key] != want[key]:
            raise ValueError("CONFLICT:" + key)
        if key not in proj:
            proj[key] = want[key]
            changed = True
    for forbidden in ("autopilotCodingWorker", "autopilotLocalWorker", "autopilotGateWorker"):
        if proj.get(forbidden, {}).get("enabled"):
            raise ValueError("UNEXPECTED_WORKER:" + forbidden)
    return new, changed


def sync_units(root):
    probe = (
        "test \"$(/usr/bin/git -C %s rev-parse --abbrev-ref HEAD)\" = main "
        "&& test -z \"$(/usr/bin/git -C %s status --porcelain)\"" % (root, root)
    )
    service = (
        "[Unit]\nDescription=Fast-forward the KMJ CodeBridge dev checkout to origin/main (clean main only)\n\n"
        "[Service]\nType=oneshot\nUser=kmjdev\nGroup=kmjdev\n"
        "ExecCondition=/bin/sh -c '%s'\n"
        "ExecStart=/usr/bin/git -C %s fetch --quiet origin main\n"
        "ExecStart=/usr/bin/git -C %s merge --ff-only --quiet origin/main\n"
        "NoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\n"
        "ReadWritePaths=%s\nTimeoutStartSec=300\n" % (probe, root, root, root)
    )
    timer = (
        "[Unit]\nDescription=Keep the KMJ CodeBridge dev checkout on origin/main\n\n"
        "[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\nPersistent=false\n\n"
        "[Install]\nWantedBy=timers.target\n"
    )
    return service, timer


def run(*cmd, **kw):
    return subprocess.run(list(cmd), capture_output=True, text=True, **kw)


def validate_live(cfg):
    code = (
        "import fs from 'node:fs';"
        "const {agentSchema}=await import(process.env.RT+'/src/config.js');"
        "agentSchema.parse(JSON.parse(fs.readFileSync(0,'utf8')));console.log('SCHEMA_OK');"
    )
    r = subprocess.run([NODE, "--input-type=module", "-e", code], input=json.dumps(cfg),
                       capture_output=True, text=True, env={"RT": RUNTIME, "PATH": "/usr/bin:/bin"})
    if "SCHEMA_OK" not in r.stdout:
        die("LIVE_SCHEMA_REJECTED", r.stderr.strip()[-400:])


def main(argv):
    apply = False
    rest = list(argv)
    if "--apply" in rest:
        apply = True
        rest.remove("--apply")
    confirmed = "--confirm-restart-dev-agent" in rest
    if confirmed:
        rest.remove("--confirm-restart-dev-agent")
    if rest or (apply and not confirmed):
        die("USAGE", "Usage: [--apply --confirm-restart-dev-agent]")
    print("MODE=" + ("APPLY" if apply else "DRY_RUN"))
    if getattr(os, "geteuid", lambda: 1)() != 0:
        die("NOT_ROOT", "Run as root.")
    if socket.gethostname().split(".")[0].lower() != "kmj-elite":
        die("WRONG_HOST", "expected kmj-elite")
    unit = pathlib.Path("/etc/systemd/system") / SERVICE
    if not unit.is_file() or unit.is_symlink():
        die("DEV_UNIT_MISSING", SERVICE)
    cfg_path = str(CONFIG)
    st = os.lstat(cfg_path)
    if (st.st_mode & 0o777) != 0o600 or os.path.islink(cfg_path):
        die("CONFIG_MODE_UNSAFE", "agent.json must be a regular 0600 file")
    cfg = json.load(open(cfg_path))
    try:
        new, changed = enable(cfg)
    except ValueError as e:
        die(str(e), None)
    root = [p for p in new["projects"] if p["id"] == PROJECT_ID][0]["root"]
    for f in ("node_modules/.bin/prettier",):
        if not os.access(os.path.join(root, f), os.X_OK):
            die("PRETTIER_MISSING", "run node_deps/locked in the dev checkout first")
    validate_live(new)
    print("CONFIG_CHANGE=" + ("WOULD_ADD" if changed else "ALREADY_PRESENT") + " gates=format_src,fast_check recipe=format ciWatch=15min")
    svc, tmr = sync_units(root)
    sp, tp = "/etc/systemd/system/%s.service" % SYNC, "/etc/systemd/system/%s.timer" % SYNC
    have_units = os.path.exists(sp) and os.path.exists(tp)
    print("SYNC_TIMER=" + ("ALREADY_PRESENT" if have_units else "WOULD_INSTALL"))
    if not apply:
        print("RESULT=DRY_RUN_UNCHANGED")
        return
    os.makedirs(BACKUP_DIR, mode=0o700, exist_ok=True)
    backup = os.path.join(BACKUP_DIR, "agent.json.%d" % int(time.time()))
    shutil.copy2(cfg_path, backup)
    created = []
    try:
        if changed:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg_path))
            with os.fdopen(fd, "w") as fh:
                json.dump(new, fh, indent=2)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.chown(tmp, st.st_uid, st.st_gid)
            os.replace(tmp, cfg_path)
        if not have_units:
            for path, text in ((sp, svc), (tp, tmr)):
                with open(path, "x") as fh:
                    fh.write(text)
                created.append(path)
        run("systemctl", "daemon-reload")
        r = run("systemctl", "restart", SERVICE)
        ok = r.returncode == 0 and run("systemctl", "is-active", "--quiet", SERVICE).returncode == 0
        if ok and not have_units:
            ok = run("systemctl", "enable", "--now", SYNC + ".timer").returncode == 0
        if not ok:
            raise RuntimeError("START_FAILED")
    except Exception:
        shutil.copy2(backup, cfg_path)
        for path in created:
            os.unlink(path)
        run("systemctl", "disable", "--now", SYNC + ".timer")
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", SERVICE)
        die("APPLY_FAILED_ROLLED_BACK", None)
    print("RESULT=APPLIED backup=" + backup)


if __name__ == "__main__":
    main(sys.argv[1:])
