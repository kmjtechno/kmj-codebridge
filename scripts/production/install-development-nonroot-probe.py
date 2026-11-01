#!/usr/bin/env python3
"""Install and independently smoke-test only the pinned, non-root dev probe.

This is NOT a CodeBridge agent upgrade or a 24x7 AI coding enablement.
No arbitrary commands, SSH, secrets, Main Platform deployment, or sudo grants.
"""
import grp
import hashlib
import json
import os
import pwd
import socket
import stat
import subprocess
import sys

BASE = "/srv/kmj-codebridge-projects/kmj-main-platform/work/qa"
FILES = (
    (
        BASE + "/KMJ_CB_PINNED_DEVELOPMENT_CI_20261027.service",
        "/etc/systemd/system/kmj-codebridge-development-ci.service",
        "b851bb24cc5a846e3fc95a96893483f0dfd6540c91bc37d93a4f91aefd0ef53b",
        0o444,
    ),
    (
        BASE + "/KMJ_CB_PINNED_DEV_PROBE_20261027.py",
        "/usr/local/libexec/kmj-codebridge-dev-probe.py",
        "1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7",
        0o444,
    ),
)
UNIT = "kmj-codebridge-development-ci.service"
ACCOUNT = "kmjdevci"
STATE = "/var/lib/kmj-codebridge-development-ci"
RECEIPT = BASE + "/KMJ_CODEBRIDGE_DEV_SANDBOX_INSTALL_RECEIPT_20261027.json"
EXPECTED_HOST = "kmj-elite"


def command(args, timeout=15):
    try:
        return subprocess.run(
            args, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (subprocess.TimeoutExpired, OSError, UnicodeError):
        return None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_regular(path, max_size=8192):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        meta = os.fstat(fd)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or
                meta.st_size < 1 or meta.st_size > max_size or
                meta.st_mode & 0o7022):
            raise RuntimeError("FILE_UNSAFE")
        return os.read(fd, max_size + 1), meta
    finally:
        os.close(fd)


def protected_directory(path):
    meta = os.lstat(path)
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o7022:
        raise RuntimeError("ROOT_DIRECTORY_UNSAFE")


def check_source():
    checked = []
    for source, destination, sha, _ in FILES:
        payload, _ = read_regular(source)
        if digest(payload) != sha:
            raise RuntimeError("PINNED_SOURCE_MISMATCH")
        checked.append((destination, sha, payload))
    return checked


def account():
    try:
        user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        created = command([
            "/usr/sbin/useradd", "--system", "--user-group",
            "--no-create-home", "--home-dir", "/nonexistent",
            "--shell", "/usr/sbin/nologin", ACCOUNT,
        ])
        if created is None or created.returncode != 0:
            raise RuntimeError("NONROOT_ACCOUNT_CREATE_FAILED")
        user = pwd.getpwnam(ACCOUNT)
    group = grp.getgrnam(ACCOUNT)
    if user.pw_uid == 0 or user.pw_gid != group.gr_gid:
        raise RuntimeError("NONROOT_ACCOUNT_UNSAFE")
    if user.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin"):
        raise RuntimeError("NONROOT_ACCOUNT_SHELL_UNSAFE")
    return user


def stage_root_file(path, data, sha, mode):
    try:
        existing, meta = read_regular(path)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if digest(existing) != sha or meta.st_uid != 0 or (meta.st_mode & 0o7022):
            raise RuntimeError("EXISTING_PROTECTED_FILE_MISMATCH")
        return "already_pinned"
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, mode)
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, mode)
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    written, meta = read_regular(path)
    if digest(written) != sha or meta.st_uid != 0:
        raise RuntimeError("INSTALLED_FILE_HASH_MISMATCH")
    return "installed"


# Keep effective service admission equal to src/development-unit-policy.js.
# A partial property check could falsely authorize starting an unsafe installed
# unit that the runtime Supervisor (correctly) rejects.
EXPECTED_UNIT_PROPERTIES = {
    "LoadState": "loaded",
    "ActiveState": "inactive",
    "FragmentPath": FILES[0][1],
    "DropInPaths": "",
    # On-disk hash alone cannot attest the unit bytes loaded by PID 1.
    "NeedDaemonReload": "no",
    "User": ACCOUNT,
    "Group": ACCOUNT,
    "NoNewPrivileges": "yes",
    "ProtectSystem": "strict",
    "ProtectHome": "yes",
    "PrivateTmp": "yes",
    "PrivateDevices": "yes",
    "PrivateNetwork": "yes",
    "CapabilityBoundingSet": "",
    "AmbientCapabilities": "",
    "EnvironmentFiles": "",
    "ReadWritePaths": STATE,
}


def effective_unit_diagnostic():
    """Read only fixed systemd properties; expose mismatch NAMES, never values.

    Malformed, partial, duplicate or oversized output is not trusted evidence.
    This diagnostic does not change the fail-closed service admission policy.
    """
    args = ["/usr/bin/systemctl", "show", UNIT, "--no-pager"]
    for name in EXPECTED_UNIT_PROPERTIES:
        args.extend(["-p", name])
    result = command(args)
    empty = {"status": "READ_FAILED", "mismatchKeys": []}
    if result is None or result.returncode != 0:
        return empty
    output = result.stdout
    malformed = {"status": "MALFORMED", "mismatchKeys": []}
    # Match the Supervisor's fail-closed raw systemctl parsing. splitlines()
    # silently discards CR in CRLF and recognizes Unicode separators, which
    # can turn malformed privileged evidence into an apparent exact match.
    if (not isinstance(output, str) or len(output) > 8192 or
            "\r" in output or "\x00" in output):
        return malformed
    lines = output.removesuffix("\n").split("\n")
    if len(lines) != len(EXPECTED_UNIT_PROPERTIES):
        return malformed
    props = {}
    for line in lines:
        if len(line) > 512 or "=" not in line:
            return malformed
        key, value = line.split("=", 1)
        if key not in EXPECTED_UNIT_PROPERTIES or key in props:
            return malformed
        props[key] = value
    if set(props) != set(EXPECTED_UNIT_PROPERTIES):
        return malformed
    mismatch = [
        key for key, expected in EXPECTED_UNIT_PROPERTIES.items()
        if props[key] != expected
    ]
    return {
        "status": "MISMATCH" if mismatch else "MATCH",
        "mismatchKeys": mismatch,
    }


def verify_effective_unit():
    # Preserve the original boolean admission API and fail-closed behavior.
    return effective_unit_diagnostic()["status"] == "MATCH"


def receipt(report):
    identity = pwd.getpwnam("kmjcode")
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(identity.pw_gid)
            os.setuid(identity.pw_uid)
            if not os.path.isdir(BASE) or os.path.islink(BASE):
                os._exit(2)
            data = json.dumps(report, separators=(",", ":"), sort_keys=True).encode()
            if len(data) > 2048:
                os._exit(3)
            tmp = RECEIPT + ".tmp-" + str(os.getpid())
            fd = os.open(
                tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                getattr(os, "O_NOFOLLOW", 0), 0o600,
            )
            os.write(fd, data)
            os.fsync(fd)
            os.close(fd)
            os.replace(tmp, RECEIPT)
            os._exit(0)
        except Exception:
            os._exit(4)
    _, status = os.waitpid(pid, 0)
    return os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0


def main():
    # Diagnostic-only mode is safe for a non-root operator: fixed systemctl
    # show properties, no install, daemon-reload, start, account or receipt.
    if sys.argv[1:] == ["--diagnose-only"]:
        if socket.gethostname().split(".")[0].lower() != EXPECTED_HOST:
            print("KMJ_CB_DEV_UNIT_DIAGNOSTIC=DENIED_HOST")
            return 2
        diagnostic = effective_unit_diagnostic()
        print("KMJ_CB_DEV_UNIT_DIAGNOSTIC=" + diagnostic["status"])
        print("KMJ_CB_DEV_UNIT_MISMATCH_KEYS=" + ",".join(diagnostic["mismatchKeys"]))
        print("KMJ_CB_DEV_UNIT_NO_MUTATION=YES")
        return 0 if diagnostic["status"] == "MATCH" else 3
    if (os.geteuid() != 0 or sys.argv[1:] != ["--install-and-test"] or
            socket.gethostname().split(".")[0].lower() != EXPECTED_HOST):
        print("KMJ_CB_DEV_SANDBOX=DENIED_HOST_OR_ARGS")
        return 2
    report = {
        "schema": "kmj-codebridge-dev-sandbox-install-v1",
        "host": "KMJ-elite", "installed": False, "unitAttested": False,
        "nonRootProbePassed": False, "agentRestarted": False,
        "productionChanged": False, "autonomousCodingLive": False,
        "modelInstalled": False, "codebridgeRuntimeChanged": False,
        "unitDiagnostic": "NOT_RUN", "unitMismatchKeys": [],
        "status": "BLOCKED",
    }
    try:
        protected_directory("/etc/systemd/system")
        protected_directory("/usr/local")
        if not os.path.exists("/usr/local/libexec"):
            os.mkdir("/usr/local/libexec", 0o755)
            os.chown("/usr/local/libexec", 0, 0)
        protected_directory("/usr/local/libexec")
        protected_directory("/var/lib")
        if not os.path.isdir(BASE) or os.path.islink(BASE):
            raise RuntimeError("PROJECT_RECEIPT_PATH_UNSAFE")
        sources = check_source()
        user = account()
        if not os.path.exists(STATE):
            os.mkdir(STATE, 0o700)
            os.chown(STATE, user.pw_uid, user.pw_gid)
        meta = os.lstat(STATE)
        if (not stat.S_ISDIR(meta.st_mode) or
                meta.st_uid != user.pw_uid or meta.st_gid != user.pw_gid or
                meta.st_mode & 0o077):
            raise RuntimeError("NONROOT_STATE_DIR_UNSAFE")
        for target, sha, data in sources:
            mode = next(m for _, dest, _, m in FILES if dest == target)
            stage_root_file(target, data, sha, mode)
        report["installed"] = True
        reload_result = command(["/usr/bin/systemctl", "daemon-reload"], timeout=20)
        if reload_result is None or reload_result.returncode != 0:
            raise RuntimeError("SYSTEMD_RELOAD_FAILED")
        diagnostic = effective_unit_diagnostic()
        report["unitAttested"] = diagnostic["status"] == "MATCH"
        report["unitDiagnostic"] = diagnostic["status"]
        report["unitMismatchKeys"] = diagnostic["mismatchKeys"]
        if not report["unitAttested"]:
            raise RuntimeError("EFFECTIVE_SANDBOX_UNVERIFIED")
        # One-shot offline Git revision probe. Never enable a permanent
        # service, restart agent/gateway, or touch protected production.
        run = command(["/usr/bin/systemctl", "start", UNIT], timeout=30)
        report["nonRootProbePassed"] = run is not None and run.returncode == 0
        report["status"] = ("NONROOT_PROBE_PASS" if
                            report["nonRootProbePassed"] else
                            "NONROOT_PROBE_FAILED_NEEDS_REVIEW")
    except (RuntimeError, OSError, KeyError) as exc:
        code = str(exc)
        if not code.isupper() and not all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for c in code):
            code = "SAFE_INSTALL_EXCEPTION"
        report["status"] = code[:100]
    ok = receipt(report)
    print("KMJ_CB_DEV_SANDBOX=" + report["status"])
    print("KMJ_CB_DEV_SANDBOX_RECEIPT=" + ("WRITTEN" if ok else "UNAVAILABLE"))
    print("KMJ_CB_AUTONOMOUS_CODING=NOT_YET_LIVE")
    return 0 if report["nonRootProbePassed"] and ok else 3


if __name__ == "__main__":
    raise SystemExit(main())
