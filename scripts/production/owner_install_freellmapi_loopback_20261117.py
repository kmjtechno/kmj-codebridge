#!/usr/bin/env python3
"""Owner-root install of FreeLLMAPI (upstream, MIT) bound to loopback only.

Installs the pinned upstream commit as an unprivileged system user, behind a
hardened systemd unit listening on 127.0.0.1:31415 (the port the CodeBridge
adapter expects). It does NOT add provider keys, does NOT create the
CODEBRIDGE_FREELLMAPI_KEY secret, does NOT touch the CodeBridge gateway, agent,
updater or any Main Platform file, and never prints secrets.

Dry-run by default. Writing anything needs:
  --apply --confirm-install-freellmapi
Generation through CodeBridge stays blocked (FREELLMAPI_ZERO_COST_NOT_ATTESTED)
until a device-side zero-cost verifier exists; this only enables read-only
`freellmapi_status` discovery.
"""
import os
import pathlib
import pwd
import re
import secrets
import stat
import shutil
import subprocess
import sys

REPO = "https://github.com/tashfeenahmed/freellmapi"
COMMIT = "fd327a57bc4157b22d483007b522c2152c54ae9a"  # upstream main, 2026-11-16
USER = "kmj-freellmapi"
BASE = pathlib.Path("/opt/kmj-freellmapi")
SRC = BASE / "src"
DATA = BASE / "data"
ENV_DIR = pathlib.Path("/etc/kmj-freellmapi")
ENV_FILE = ENV_DIR / "freellmapi.env"
UNIT = pathlib.Path("/etc/systemd/system/kmj-freellmapi.service")
HOST = "127.0.0.1"
PORT = 31415
NODE_MIN, NODE_MAX = (20, 18), (25, 0)  # upstream engines: >=20.18 <25
UNIT_IDENTITY = None  # Only this process may roll back a unit it created.

UNIT_TEXT = f"""[Unit]
Description=FreeLLMAPI (loopback only, KMJ CodeBridge adapter target)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={SRC}/server
EnvironmentFile={ENV_FILE}
Environment=NODE_ENV=production
Environment=HOST={HOST}
Environment=PORT={PORT}
Environment=FREEAPI_DB_PATH={DATA}/freeapi.db
ExecStart=/usr/bin/env node dist/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={DATA}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=768M
TasksMax=256

[Install]
WantedBy=multi-user.target
"""


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def run(cmd, **kw):
    kw.setdefault("check", True)
    kw.setdefault("timeout", 900)
    return subprocess.run(cmd, **kw)


def as_user(cmd, cwd):
    return run(["runuser", "-u", USER, "--", *cmd], cwd=cwd,
               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def node_version():
    out = run(["node", "--version"], capture_output=True, text=True).stdout
    m = re.fullmatch(r"v(\d+)\.(\d+)\.\d+\s*", out)
    guard(m, "NODE_VERSION_UNPARSEABLE")
    return int(m[1]), int(m[2])


def listeners():
    out = run(["ss", "-H", "-ltn"], capture_output=True, text=True).stdout
    return [ln.split()[3] for ln in out.splitlines() if len(ln.split()) > 3]


def create_exclusive_file(target, content, mode):
    """Create a new file atomically; never follow or replace a symlink."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(target, flags, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(content)
    return target.lstat()


def preflight():
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    for tool in ("git", "npm", "node", "systemctl", "ss", "runuser", "curl"):
        guard(shutil.which(tool), f"MISSING_TOOL_{tool.upper()}")
    guard(NODE_MIN <= node_version() < NODE_MAX, "NODE_OUT_OF_UPSTREAM_RANGE")
    # Path.exists() follows links: a dangling link would otherwise pass.
    guard(not os.path.lexists(UNIT), "UNIT_ALREADY_EXISTS")
    guard(not os.path.lexists(BASE), "INSTALL_DIR_ALREADY_EXISTS")
    guard(not os.path.lexists(ENV_DIR), "ENV_DIR_ALREADY_EXISTS")
    guard(not any(a.endswith(f":{PORT}") for a in listeners()), "PORT_IN_USE")
    try:
        pwd.getpwnam(USER)
        raise ValueError("USER_ALREADY_EXISTS")
    except KeyError:
        pass


def rollback():
    if UNIT_IDENTITY is None:
        # Failed before creating our own unit: never delete an unknown path
        # inserted after preflight by another operator or process.
        return
    try:
        current = UNIT.lstat()
    except FileNotFoundError:
        return
    guard(
        stat.S_ISREG(current.st_mode)
        and (current.st_dev, current.st_ino) == UNIT_IDENTITY
        and UNIT.read_text(encoding="utf-8") == UNIT_TEXT,
        "UNIT_CHANGED_PRESERVED",
    )
    run(["systemctl", "disable", "--now", "kmj-freellmapi.service"], check=False)
    current = UNIT.lstat()
    guard(
        stat.S_ISREG(current.st_mode)
        and (current.st_dev, current.st_ino) == UNIT_IDENTITY,
        "UNIT_CHANGED_PRESERVED",
    )
    UNIT.unlink()
    run(["systemctl", "daemon-reload"], check=False)


def apply():
    run(["useradd", "--system", "--home-dir", str(BASE), "--shell",
         "/usr/sbin/nologin", USER])
    BASE.mkdir(mode=0o755)
    DATA.mkdir(mode=0o700)
    shutil.chown(BASE, USER, USER)
    shutil.chown(DATA, USER, USER)
    run(["git", "clone", "--quiet", REPO, str(SRC)], stdout=subprocess.DEVNULL)
    run(["git", "-C", str(SRC), "checkout", "--quiet", COMMIT])
    head = run(["git", "-C", str(SRC), "rev-parse", "HEAD"],
               capture_output=True, text=True).stdout.strip()
    guard(head == COMMIT, "PINNED_COMMIT_MISMATCH")
    run(["chown", "-R", f"{USER}:{USER}", str(SRC)])
    as_user(["npm", "ci", "--no-audit", "--no-fund"], SRC)
    as_user(["npm", "run", "build"], SRC)
    as_user(["npm", "prune", "--omit=dev"], SRC)
    ENV_DIR.mkdir(mode=0o700)
    create_exclusive_file(ENV_FILE, f"ENCRYPTION_KEY={secrets.token_hex(32)}\n", 0o600)
    ENV_FILE.chmod(0o600)  # root-owned; systemd reads it, the service user cannot
    global UNIT_IDENTITY
    created = create_exclusive_file(UNIT, UNIT_TEXT, 0o644)
    UNIT_IDENTITY = (created.st_dev, created.st_ino)
    UNIT.chmod(0o644)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "kmj-freellmapi.service"])
    ok = False
    for _ in range(30):
        run(["sleep", "2"])
        mine = [a for a in listeners() if a.endswith(f":{PORT}")]
        if mine:
            guard(mine == [f"{HOST}:{PORT}"], "NOT_LOOPBACK_ONLY")
            ok = True
            break
    guard(ok, "SERVICE_DID_NOT_LISTEN")
    code = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                f"http://{HOST}:{PORT}/v1/models"],
               capture_output=True, text=True, check=False).stdout
    print(f"HTTP_WITHOUT_KEY={code}")


def main():
    args = sys.argv[1:]
    guard(args in ([], ["--apply", "--confirm-install-freellmapi"]),
          "USAGE_DRY_RUN_OR_--apply_--confirm-install-freellmapi")
    preflight()
    print(f"PREFLIGHT=OK COMMIT={COMMIT} BIND={HOST}:{PORT} USER={USER}")
    if not args:
        print("INSTALL=DRY_RUN_UNCHANGED")
        return
    try:
        apply()
    except Exception:
        rollback()
        print("INSTALL=FAILED_ROLLED_BACK_UNIT (source dir kept for diagnosis)")
        raise
    print("INSTALL=OK  next: add provider keys in the dashboard on this host only")


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        print(f"BLOCKED={exc}")
        sys.exit(2)
