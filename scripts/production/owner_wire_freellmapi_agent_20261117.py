#!/usr/bin/env python3
"""Owner-root wiring of the loopback FreeLLMAPI into the CodeBridge agent.

Reads the FreeLLMAPI unified API key from a HIDDEN prompt (never argv, never a
file argument, never printed), validates it against 127.0.0.1:31415, lets the
owner pick which advertised `auto:*` chains are approved, then writes:
  /etc/kmj-freellmapi/codebridge.env  (root:root 0600)
  a systemd drop-in on kmj-codebridge-agent.service adding only EnvironmentFile
and restarts the agent once. Auto-rollback (drop-in removed, agent restarted)
on failure. Touches nothing else: no gateway, updater, key, nginx or source.

Dry-run by default (checks only, no prompt). Writing needs:
  --apply --confirm-no-active-jobs
It enables read-only `freellmapi_status`. Generation stays blocked by the
adapter (FREELLMAPI_ZERO_COST_NOT_ATTESTED) until a zero-cost verifier exists.
"""
import getpass
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

UNIT = "kmj-codebridge-agent.service"
DROPIN_DIR = pathlib.Path(f"/etc/systemd/system/{UNIT}.d")
DROPIN = DROPIN_DIR / "kmj-freellmapi-env.conf"
ENV_FILE = pathlib.Path("/etc/kmj-freellmapi/codebridge.env")
BASE = "http://127.0.0.1:31415"
KEY_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{16,200}$")
CHAIN_RE = re.compile(r"^auto:[A-Za-z0-9._-]{1,48}$")
DROPIN_TEXT = f"[Service]\nEnvironmentFile={ENV_FILE}\n"
CREATED = {}  # Only this process-created regular files may be rolled back.


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def cmd(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, timeout=120,
                          check=check)


def models(key):
    req = urllib.request.Request(
        f"{BASE}/v1/models", headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            guard(resp.status == 200, "MODELS_NOT_200")
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        raise ValueError(f"MODELS_HTTP_{exc.code}") from None
    except OSError:
        raise ValueError("FREELLMAPI_UNREACHABLE") from None


def chain_names(payload):
    ids = [m.get("id", "") for m in payload.get("data", []) if isinstance(m, dict)]
    return sorted({i for i in ids if CHAIN_RE.match(i)})


def exists_including_dangling(path):
    return os.path.lexists(path)


def protected_parent(path):
    """Never open an agent secret or unit under a writable/link directory."""
    try:
        st = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022)


def write_new_file(target, contents, mode):
    """Exclusive no-follow create; no overwrite even after preflight races."""
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        identity = os.fstat(fh.fileno())
        fh.write(contents)
    CREATED[target] = (
        identity.st_dev,
        identity.st_ino,
        hashlib.sha256(contents.encode("utf-8")).digest(),
    )


def preflight():
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    guard(cmd("systemctl", "is-active", "kmj-freellmapi.service",
              check=False).stdout.strip() == "active", "FREELLMAPI_NOT_ACTIVE")
    guard(cmd("systemctl", "cat", UNIT, check=False).returncode == 0,
          "AGENT_UNIT_MISSING")
    guard(not exists_including_dangling(DROPIN), "DROPIN_ALREADY_EXISTS")
    guard(not exists_including_dangling(ENV_FILE), "ENV_FILE_ALREADY_EXISTS")
    guard(protected_parent(ENV_FILE.parent), "ENV_PARENT_UNSAFE")
    if exists_including_dangling(DROPIN_DIR):
        guard(protected_parent(DROPIN_DIR), "DROPIN_DIR_UNSAFE")


def rollback():
    # A failure before our first write must never touch an owner-owned unit.
    if not CREATED:
        return
    # Validate every owned file BEFORE unlinking any; never remove a changed
    # or foreign path, and never disclose the private environment contents.
    for target, identity in CREATED.items():
        try:
            st = target.lstat()
            digest = hashlib.sha256(target.read_bytes()).digest()
        except OSError:
            raise ValueError("OWNED_FILE_CHANGED_PRESERVED") from None
        guard(
            stat.S_ISREG(st.st_mode)
            and (st.st_dev, st.st_ino, digest) == identity,
            "OWNED_FILE_CHANGED_PRESERVED",
        )
    had_dropin = DROPIN in CREATED
    for target in (DROPIN, ENV_FILE):
        if target in CREATED:
            target.unlink()
    CREATED.clear()
    if had_dropin:
        cmd("systemctl", "daemon-reload", check=False)
        cmd("systemctl", "restart", UNIT, check=False)


def collect():
    key = getpass.getpass("FreeLLMAPI unified API key (hidden, not echoed): ").strip()
    guard(KEY_RE.match(key), "KEY_FORMAT_REJECTED")
    chains = chain_names(models(key))
    guard(chains, "NO_AUTO_CHAINS_ADVERTISED")
    print("Advertised auto chains:")
    for name in chains:
        print(f"  {name}")
    raw = input("Approve which chains? comma-separated names from above: ")
    chosen = [c.strip() for c in raw.split(",") if c.strip()]
    guard(chosen and all(c in chains for c in chosen), "CHAIN_NOT_ADVERTISED")
    return key, chosen


def write_and_restart(key, chosen):
    guard(protected_parent(ENV_FILE.parent), "ENV_PARENT_UNSAFE")
    if exists_including_dangling(DROPIN_DIR):
        guard(protected_parent(DROPIN_DIR), "DROPIN_DIR_UNSAFE")
    else:
        guard(protected_parent(DROPIN_DIR.parent), "DROPIN_PARENT_UNSAFE")
        DROPIN_DIR.mkdir(mode=0o755)
        guard(protected_parent(DROPIN_DIR), "DROPIN_DIR_UNSAFE")
    write_new_file(
        ENV_FILE,
        f"CODEBRIDGE_FREELLMAPI_KEY={key}\n"
        f"CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS={','.join(chosen)}\n",
        0o600,
    )
    write_new_file(DROPIN, DROPIN_TEXT, 0o644)
    cmd("systemctl", "daemon-reload")
    cmd("systemctl", "restart", UNIT)
    for _ in range(20):
        time.sleep(2)
        if cmd("systemctl", "is-active", UNIT, check=False).stdout.strip() == "active":
            return chosen
    raise ValueError("AGENT_NOT_ACTIVE_AFTER_RESTART")


def main():
    args = sys.argv[1:]
    guard(args in ([], ["--apply", "--confirm-no-active-jobs"]),
          "USAGE_DRY_RUN_OR_--apply_--confirm-no-active-jobs")
    preflight()
    print("PREFLIGHT=OK")
    if not args:
        print("WIRING=DRY_RUN_UNCHANGED")
        return
    key, chosen = collect()  # nothing written yet: failures here change nothing
    try:
        chosen = write_and_restart(key, chosen)
    except BaseException:
        rollback()
        print("WIRING=FAILED_ROLLED_BACK")
        raise
    print(f"WIRING=OK approved_chains={len(chosen)} agent=active")


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        print(f"BLOCKED={exc}")
        sys.exit(2)
