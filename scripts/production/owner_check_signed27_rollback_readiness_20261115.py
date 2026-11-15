#!/usr/bin/env python3
"""KMJ-elite owner-only, READ-ONLY: would a gateway rollback to signed25 start?

A rollback drill without the rollback. The seq25 cutover showed that the
rollback side can be broken without anyone noticing (the config had become
unreadable for the old runtime). This checks, and changes nothing:

- the signed25 override that the signed27 cutover kept is byte-exact;
- the signed25 release tree is present, root-owned and not writable by others;
- the live gateway config has the owner and mode the signed25 runtime accepts;
- the signed25 runtime's own schema accepts the live config as it is now
  (parsed as the service user; no value is printed).

It takes no arguments, writes no file, and calls only `systemctl show`,
`node --check` and one schema parse. It proves startability of the config
and code, not that agents reconnect after a real rollback.
"""
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys

UNIT = "kmj-codebridge-gateway-stage.service"
DIR = pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service.d")
OLD_CONF = DIR / "zzzzzzzzz-kmj-signed25.conf"
NEW_CONF = DIR / "zzzzzzzzzz-kmj-signed27.conf"
OLD_SHA = "55a3f976fd3b71e36b4dcb1864b04d43364418ac"
NEW_SHA = "40655678db7fa62edca28ccc4988614010253ef1"
OLD_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-55a3f976fd3b")
NEW_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-40655678db7f")
NODE = "/opt/kmj-codebridge-node/bin/node"
SERVICE_USER = "kmjcode"
MAX_TREE_ENTRIES = 200000


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def cmd(*argv, timeout=40):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    need(p.returncode == 0, "COMMAND_FAILED")
    need(len(p.stdout) <= 1024 * 1024, "COMMAND_OUTPUT_TOO_LARGE")
    return p.stdout.decode("utf-8", "replace").strip()


def show(prop):
    return cmd("systemctl", "show", UNIT, "-P", prop, timeout=12)


def override(release_dir, sha, config):
    return ("[Service]\n"
            f"WorkingDirectory={release_dir}\n"
            f"Environment=CODEBRIDGE_SOURCE_COMMIT={sha}\n"
            "ExecStart=\n"
            f"ExecStart={NODE} {release_dir}/src/cli.js gateway {config}\n").encode()


def root_file(path, max_size=16384):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("OVERRIDE_UNAVAILABLE") from None
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
             and 1 <= st.st_size <= max_size and (st.st_mode & 0o022) == 0,
             "OVERRIDE_UNTRUSTED")
        return os.read(fd, max_size + 1)
    finally:
        os.close(fd)


def live_config_path():
    need(show("LoadState") == "loaded" and show("ActiveState") == "active",
         "GATEWAY_UNIT_NOT_ACTIVE")
    need(f"CODEBRIDGE_SOURCE_COMMIT={NEW_SHA}" in show("Environment"),
         "GATEWAY_NOT_ON_SIGNED27")
    found = re.findall(r"argv\[\]=(.*?) ;", show("ExecStart"))
    need(len(found) == 1, "GATEWAY_EXECSTART_NOT_SINGLE")
    m = re.fullmatch(re.escape(f"{NODE} {NEW_DIR}/src/cli.js gateway ")
                     + r"(/[A-Za-z0-9_./-]+)", found[0])
    need(m is not None and ".." not in m.group(1), "GATEWAY_EXECSTART_UNEXPECTED")
    return m.group(1)


def check_overrides(config):
    names = sorted(n for n in os.listdir(DIR) if n.endswith(".conf"))
    need(names[-2:] == [OLD_CONF.name, NEW_CONF.name], "DROPIN_ORDER_UNEXPECTED")
    need(root_file(NEW_CONF) == override(NEW_DIR, NEW_SHA, config),
         "SIGNED27_OVERRIDE_DRIFT")
    need(root_file(OLD_CONF) == override(OLD_DIR, OLD_SHA, config),
         "SIGNED25_OVERRIDE_DRIFT")


def check_old_tree():
    count = 0
    for root, dirs, files in os.walk(OLD_DIR, followlinks=False):
        for name in [".", *dirs, *files]:
            count += 1
            need(count <= MAX_TREE_ENTRIES, "SIGNED25_TREE_TOO_LARGE")
            st = os.lstat(os.path.join(root, name))
            need(st.st_uid == 0, "SIGNED25_TREE_NOT_ROOT_OWNED")
            if stat.S_ISLNK(st.st_mode):
                continue
            need((st.st_mode & 0o022) == 0, "SIGNED25_TREE_WRITABLE_BY_NON_ROOT")
    need(count > 10, "SIGNED25_TREE_MISSING")
    for relative in ("src/cli.js", "src/gateway.js", "src/config.js", "package.json"):
        file = OLD_DIR / relative
        need(file.is_file() and not file.is_symlink() and file.stat().st_size > 0,
             "SIGNED25_RUNTIME_FILE_MISSING")
    for relative in ("src/cli.js", "src/gateway.js", "src/config.js"):
        cmd(NODE, "--check", str(OLD_DIR / relative))


def check_config_startable(config):
    try:
        uid = pwd.getpwnam(SERVICE_USER).pw_uid
        st = os.lstat(config)
    except (KeyError, OSError):
        raise Blocked("GATEWAY_CONFIG_UNAVAILABLE") from None
    # signed25 (before #929) starts only on a file with no group/other bits,
    # and it runs as the service user, so that user must own it.
    need(stat.S_ISREG(st.st_mode) and st.st_uid == uid and (st.st_mode & 0o077) == 0,
         "CONFIG_NOT_STARTABLE_ON_SIGNED25_MODE_OR_OWNER")
    script = ("import fs from 'node:fs';"
              f"import {{ gatewaySchema }} from '{OLD_DIR}/src/config.js';"
              "gatewaySchema.parse(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));"
              "console.log('SCHEMA_OK');")
    try:
        out = cmd("runuser", "-u", SERVICE_USER, "--", NODE, "--input-type=module",
                  "-e", script, config)
    except Blocked:
        out = ""
    need(out == "SCHEMA_OK", "CONFIG_REJECTED_BY_SIGNED25_SCHEMA")


def run():
    need(sys.platform.startswith("linux") and os.geteuid() == 0, "ROOT_REQUIRED")
    need(sys.argv[1:] == [], "USAGE")
    config = live_config_path()
    check_overrides(config)
    print("SIGNED25_OVERRIDE=BYTE_EXACT")
    check_old_tree()
    print("SIGNED25_RUNTIME_TREE=PRESENT_ROOT_OWNED")
    check_config_startable(config)
    print("LIVE_CONFIG_ON_SIGNED25=MODE_OWNER_AND_SCHEMA_PASS")
    print("SIGNED27_ROLLBACK_READINESS=PASS")
    print("CHANGED=NOTHING")
    print("NOT_PROVEN=AGENT_RECONNECT_AFTER_A_REAL_ROLLBACK")


if __name__ == "__main__":
    try:
        run()
    except Blocked as reason:
        safe = re.sub(r"[^A-Z0-9_]", "", str(reason))[:80]
        print("SIGNED27_ROLLBACK_READINESS=BLOCKED:" + safe)
        sys.exit(1)
