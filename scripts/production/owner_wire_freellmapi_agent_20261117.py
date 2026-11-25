#!/usr/bin/env python3
"""Owner-root wiring of the loopback FreeLLMAPI into the CodeBridge agent.

Reads the FreeLLMAPI unified API key from a HIDDEN prompt (never argv, never a
file argument, never printed), validates it against 127.0.0.1:31415, lets the
owner pick which advertised `auto:*` chains are approved, then writes:
  /etc/kmj-freellmapi/codebridge.env  (root:root 0600)
  a systemd drop-in on kmj-codebridge-kmj-main-platform.service adding only EnvironmentFile
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
import socket
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import warnings

UNIT = "kmj-codebridge-kmj-main-platform.service"  # live elite project agent (verified by owner unit list)
DROPIN_DIR = pathlib.Path(f"/etc/systemd/system/{UNIT}.d")
DROPIN = DROPIN_DIR / "kmj-freellmapi-env.conf"
ENV_FILE = pathlib.Path("/etc/kmj-freellmapi/codebridge.env")
BASE = "http://127.0.0.1:31415"
KEY_RE = re.compile(r"^[A-Za-z0-9._-]{8,200}$")
CHAIN_RE = re.compile(r"^auto:[A-Za-z0-9_-]{1,20}$")
GLOBAL_ALIASES = frozenset({
    "smart", "smartest", "intelligence", "fast", "fastest", "speed",
    "cheap", "cheapest", "price", "budget", "reliable", "reliability", "balanced",
})
MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_CATALOG_ROWS = 4096
DROPIN_TEXT = f"[Service]\nEnvironmentFile={ENV_FILE}\n"
CREATED = {}  # Only this process-created regular files may be rolled back.


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def cmd(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, timeout=120,
                          check=check)


class RejectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("ROUTER_REDIRECT_DENIED")


def models(key):
    req = urllib.request.Request(
        f"{BASE}/v1/models", headers={"Authorization": f"Bearer {key}"})
    # Local credential must never follow a redirect or environment proxy.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), RejectRedirect())
    try:
        with opener.open(req, timeout=20) as resp:
            guard(resp.status == 200, "MODELS_NOT_200")
            raw = resp.read(MAX_CATALOG_BYTES + 1)
            guard(len(raw) <= MAX_CATALOG_BYTES, "CATALOG_TOO_LARGE")
            try:
                return json.loads(raw)
            except (UnicodeError, ValueError):
                raise ValueError("INVALID_CATALOG") from None
    except urllib.error.HTTPError as exc:
        raise ValueError(f"MODELS_HTTP_{exc.code}") from None
    except OSError:
        raise ValueError("FREELLMAPI_UNREACHABLE") from None


def chain_names(payload):
    guard(isinstance(payload, dict), "INVALID_CATALOG")
    rows = payload.get("data")
    guard(isinstance(rows, list) and len(rows) <= MAX_CATALOG_ROWS,
          "INVALID_CATALOG")
    names = set()
    seen = set()
    for row in rows:
        guard(isinstance(row, dict), "INVALID_CATALOG")
        name = row.get("id")
        guard(isinstance(name, str) and name not in seen, "INVALID_CATALOG")
        seen.add(name)
        if (CHAIN_RE.fullmatch(name) and ".." not in name
                and name[5:].lower() not in GLOBAL_ALIASES):
            names.add(name)
    return sorted(names)


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


def rollback(restart=True):
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
    if had_dropin and restart:
        cmd("systemctl", "daemon-reload", check=False)
        cmd("systemctl", "restart", UNIT, check=False)


def collect():
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            key = getpass.getpass("FreeLLMAPI unified API key (hidden, not echoed): ").strip()
        except getpass.GetPassWarning:
            raise ValueError("PRIVATE_INPUT_UNAVAILABLE") from None
    guard(KEY_RE.fullmatch(key), "KEY_FORMAT_REJECTED")
    chains = chain_names(models(key))
    guard(chains, "NO_AUTO_CHAINS_ADVERTISED")
    print("Advertised auto chains:")
    for name in chains:
        print(f"  {name}")
    raw = input("Approve which chains? comma-separated names from above: ")
    chosen = [c.strip() for c in raw.split(",") if c.strip()]
    guard(1 <= len(chosen) <= 20 and len(set(chosen)) == len(chosen),
          "INVALID_APPROVED_CHAIN_COUNT")
    guard(all(c in chains for c in chosen), "CHAIN_NOT_ADVERTISED")
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


def select_elite_dev():
    # Deliberately separate the dev agent's credential and systemd unit from
    # the already-configured Main Platform agent. Never copy its secret.
    global UNIT, DROPIN_DIR, DROPIN, ENV_FILE, DROPIN_TEXT
    UNIT = "kmj-codebridge-dev.service"
    DROPIN_DIR = pathlib.Path(f"/etc/systemd/system/{UNIT}.d")
    DROPIN = DROPIN_DIR / "kmj-freellmapi-env.conf"
    ENV_FILE = pathlib.Path("/etc/kmj-freellmapi/codebridge-dev.env")
    DROPIN_TEXT = f"[Service]\nEnvironmentFile={ENV_FILE}\n"


def elite_dev_identity():
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    guard(socket.gethostname().split(".")[0].lower() == "kmj-elite",
          "WRONG_HOST")
    props = cmd("systemctl", "show", UNIT, "-p", "LoadState", "-p", "ActiveState",
                "-p", "User", "-p", "Group", "-p", "FragmentPath",
                "-p", "NeedDaemonReload", "-p", "MainPID").stdout
    rows = dict(line.split("=", 1) for line in props.splitlines() if "=" in line)
    guard(rows.get("LoadState") == "loaded" and
          rows.get("ActiveState") == "active" and
          rows.get("User") == "kmjdev" and rows.get("Group") == "kmjdev" and
          rows.get("FragmentPath") == f"/etc/systemd/system/{UNIT}" and
          rows.get("NeedDaemonReload") == "no" and
          rows.get("MainPID", "").isdigit() and int(rows["MainPID"]) > 1,
          "DEV_AGENT_EFFECTIVE_IDENTITY_INVALID")
    # No config values or credentials are read. Systemd's fixed service
    # identity is sufficient for staging a distinct EnvironmentFile only.


def stage_elite_dev(key, chosen):
    elite_dev_identity()
    preflight()
    guard(protected_parent(DROPIN_DIR.parent), "DROPIN_PARENT_UNSAFE")
    if not exists_including_dangling(DROPIN_DIR):
        DROPIN_DIR.mkdir(mode=0o755)
    guard(protected_parent(DROPIN_DIR), "DROPIN_DIR_UNSAFE")
    try:
        write_new_file(
            ENV_FILE,
            f"CODEBRIDGE_FREELLMAPI_KEY={key}\n"
            f"CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS={','.join(chosen)}\n",
            0o600,
        )
        write_new_file(DROPIN, DROPIN_TEXT, 0o644)
    except BaseException:
        rollback(restart=False)
        raise


def elite_dev_main(args):
    select_elite_dev()
    elite_dev_identity()
    preflight()
    print("DEV_AGENT_PREFLIGHT=OK")
    if args == ["--elite-dev"]:
        print("DEV_WIRING=DRY_RUN_UNCHANGED")
        return
    key, chosen = collect()
    stage_elite_dev(key, chosen)
    print("DEV_WIRING=STAGED_ONLY")
    print("DAEMON_RELOAD=NOT_ATTEMPTED")
    print("AGENT_RESTART=NOT_ATTEMPTED")
    print("GENERATION=NOT_VERIFIED")


def main():
    args = sys.argv[1:]
    if args in (["--elite-dev"], ["--stage-elite-dev", "--confirm-owner-staging"]):
        elite_dev_main(args)
        return
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
