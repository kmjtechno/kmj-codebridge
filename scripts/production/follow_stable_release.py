#!/usr/bin/env python3
"""Root oneshot (systemd timer): restart ONLY allowlisted agent units whose
running process is not on the signed stable runtime the updater installed.

Why: the signed updater moves /opt/kmj-codebridge-stable/current and restarts
its own units, but the dev and CloudOS agents run from that same symlink and
keep the old code until something restarts them.

Fail-closed. It never touches the signed updater, the gateway cutover,
Main Platform production, signing keys, config or the symlink. It restarts a
unit only when ALL hold: exact allowlisted name, WorkingDirectory is exactly the
stable symlink, the target is a real signed-release dir, the target settled for
SETTLE_SECONDS, and the agent process has no child processes (no running job).
"""
import json
import os
import pathlib
import subprocess
import sys
import time

CURRENT = pathlib.Path("/opt/kmj-codebridge-stable/current")
RELEASES = pathlib.Path("/opt/kmj-codebridge-stable/releases")
UNITS = ("kmj-codebridge-dev.service", "kmj-codebridge-kmj-cloudos.service")
SETTLE_SECONDS = 120
VERIFY_SECONDS = 40
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}


def plan(unit, info, target, target_age, running_dir, children):
    """Pure decision. Returns (action, marker)."""
    if unit not in UNITS:
        return "SKIP", "NOT_ALLOWLISTED"
    if info.get("LoadState") != "loaded" or info.get("ActiveState") != "active":
        return "SKIP", "NOT_ACTIVE"
    if info.get("WorkingDirectory") != str(CURRENT):
        return "SKIP", "NOT_ON_STABLE_SYMLINK"
    if target is None:
        return "SKIP", "TARGET_INVALID"
    if running_dir is None:
        return "SKIP", "PROCESS_UNREADABLE"
    if running_dir == target:
        return "SKIP", "UP_TO_DATE"
    if target_age < SETTLE_SECONDS:
        return "DEFER", "TARGET_NOT_SETTLED"
    if children:
        return "DEFER", "AGENT_BUSY"
    return "RESTART", "BEHIND_STABLE"


def run(*cmd, timeout=60):
    return subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout, env=SAFE_ENV)


def show(unit):
    out = run("systemctl", "show", unit, "-p", "LoadState,ActiveState,WorkingDirectory,MainPID").stdout
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def valid_target():
    try:
        if not CURRENT.is_symlink():
            return None
        target = pathlib.Path(os.path.realpath(CURRENT))
        if target.parent != RELEASES:
            return None
        cli = target / "src/cli.js"
        if not cli.is_file() or cli.is_symlink() or not (target / "package.json").is_file():
            return None
        return target
    except OSError:
        return None


def children_of(pid):
    try:
        names = os.listdir(f"/proc/{pid}/task")
        for tid in names:
            if pathlib.Path(f"/proc/{pid}/task/{tid}/children").read_text().strip():
                return True
    except OSError:
        return True  # unreadable means unknown: treat as busy
    return False


def cwd_of(pid):
    try:
        return pathlib.Path(os.path.realpath(f"/proc/{pid}/cwd"))
    except OSError:
        return None


def main():
    if os.geteuid() != 0:
        print("FOLLOW=BLOCKED_NOT_ROOT")
        return 2
    target = valid_target()
    age = time.time() - target.stat().st_mtime if target else 0
    failed = False
    for unit in UNITS:
        info = show(unit)
        pid = int(info.get("MainPID", "0") or 0)
        running = cwd_of(pid) if pid > 1 else None
        busy = children_of(pid) if pid > 1 else False
        action, marker = plan(unit, info, target, age, running, busy)
        print(json.dumps({"unit": unit, "action": action, "marker": marker}))
        if action != "RESTART":
            continue
        run("systemctl", "restart", unit, timeout=90)
        deadline = time.monotonic() + VERIFY_SECONDS
        ok = False
        while time.monotonic() < deadline and not ok:
            time.sleep(2)
            now = show(unit)
            npid = int(now.get("MainPID", "0") or 0)
            ok = now.get("ActiveState") == "active" and npid > 1 and npid != pid and cwd_of(npid) == target
        print(f"FOLLOW_{unit}=" + ("RESTARTED_ON_STABLE" if ok else "RESTART_NOT_VERIFIED_REVIEW"))
        failed = failed or not ok
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
