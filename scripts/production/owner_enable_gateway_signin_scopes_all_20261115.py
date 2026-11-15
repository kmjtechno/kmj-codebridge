#!/usr/bin/env python3
"""KMJ-elite owner-only: enable oauth.signInScopes "all" on the signed27 gateway.

Why: a client that never acts on a later step-up challenge (the Claude.ai
connector) stays read-only, because the first sign-in challenge asks only for
the scope of the tool that was called. With "all" the challenge asks for the
three CodeBridge scopes at once. It grants nothing by itself: the
authorization server and the account's own permissions still decide.

What it changes: exactly one key, oauth.signInScopes, in the gateway config
the running signed27 unit already uses, then one gateway restart. Owner, mode
and every other value are kept. The previous bytes are saved next to the
config and restored automatically if the gateway does not come back with the
expected challenge. The signed25 rollback runtime ignores the key.

Never printed: any config value. Never touched: keys, tokens, agents, the
Supervisor, the updater, Nginx, drop-ins, stable/current.

Modes: (none) dry-run | --apply --confirm-no-active-jobs | --rollback --confirm-no-active-jobs
"""
import http.client
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import time

UNIT = "kmj-codebridge-gateway-stage.service"
NEW_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-40655678db7f")
NEW_SHA = "40655678db7fa62edca28ccc4988614010253ef1"
NODE = "/opt/kmj-codebridge-node/bin/node"
SERVICE_USER = "kmjcode"
PUBLIC_HOST = "kmjtechno.com"
LOCK = pathlib.Path("/run/lock/kmj-codebridge-gateway-signin-scopes.lock")
BACKUP_SUFFIX = ".before-signin-scopes-all-20261115"
ONE_SCOPE = 'scope="codebridge:read"'
ALL_SCOPES = 'scope="codebridge:read codebridge:write codebridge:execute"'
MAX_CONFIG = 262144


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def cmd(*argv, timeout=25):
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


def service_uid():
    try:
        return pwd.getpwnam(SERVICE_USER).pw_uid, pwd.getpwnam(SERVICE_USER).pw_gid
    except KeyError:
        raise Blocked("SERVICE_USER_MISSING") from None


def gateway_config_path():
    need(show("LoadState") == "loaded" and show("ActiveState") == "active"
         and show("NeedDaemonReload") == "no", "GATEWAY_UNIT_NOT_HEALTHY")
    need(f"CODEBRIDGE_SOURCE_COMMIT={NEW_SHA}" in show("Environment"),
         "GATEWAY_NOT_ON_SIGNED27")
    found = re.findall(r"argv\[\]=(.*?) ;", show("ExecStart"))
    need(len(found) == 1, "GATEWAY_EXECSTART_NOT_SINGLE")
    m = re.fullmatch(re.escape(f"{NODE} {NEW_DIR}/src/cli.js gateway ")
                     + r"(/[A-Za-z0-9_./-]+)", found[0])
    need(m is not None and ".." not in m.group(1), "GATEWAY_EXECSTART_UNEXPECTED")
    return pathlib.Path(m.group(1))


def require_trusted_parent(path):
    """Ancestors are root-owned; the config directory itself may belong to the
    service user, who can already rewrite its own config."""
    uid, _ = service_uid()
    for ancestor in [pathlib.Path("/"), *reversed(path.parent.parents), path.parent]:
        try:
            st = os.lstat(ancestor)
        except OSError:
            raise Blocked("CONFIG_PARENT_MISSING") from None
        owners = (0, uid) if ancestor == path.parent else (0,)
        need(stat.S_ISDIR(st.st_mode) and st.st_uid in owners
             and (st.st_mode & 0o022) == 0, "CONFIG_PARENT_UNTRUSTED")


def read_private(path):
    """The gateway only starts on a 0600 file owned by its own user."""
    uid, _ = service_uid()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("GATEWAY_CONFIG_UNAVAILABLE") from None
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1
             and 1 <= st.st_size <= MAX_CONFIG and st.st_uid == uid
             and (st.st_mode & 0o077) == 0, "GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER")
        data = os.read(fd, MAX_CONFIG + 1)
        need(len(data) == st.st_size, "GATEWAY_CONFIG_RACE")
        return data
    finally:
        os.close(fd)


def parse(data):
    try:
        config = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise Blocked("GATEWAY_CONFIG_NOT_JSON") from None
    need(isinstance(config, dict) and isinstance(config.get("oauth"), dict),
         "GATEWAY_OAUTH_NOT_CONFIGURED")
    port = config.get("port", 8787)
    need(type(port) == int and 1 <= port <= 65535
         and config.get("host", "127.0.0.1") in ("127.0.0.1", "localhost", "0.0.0.0"),
         "GATEWAY_PORT_NOT_LOCAL")
    return config, port


def with_all_scopes(data):
    """Change only oauth.signInScopes; key order and all other values stay."""
    config, _ = parse(data)
    need(config["oauth"].get("signInScopes", "requested-tool") == "requested-tool",
         "SIGNIN_SCOPES_ALREADY_SET")
    expected = json.loads(data.decode("utf-8"))
    config["oauth"]["signInScopes"] = "all"
    indent = 2 if b'\n  "' in data else (4 if b'\n    "' in data else None)
    out = (json.dumps(config, indent=indent, ensure_ascii=False) + "\n").encode("utf-8")
    back = json.loads(out.decode("utf-8"))
    need(back["oauth"].pop("signInScopes") == "all", "REWRITE_SELF_CHECK_FAILED")
    expected["oauth"].pop("signInScopes", None)
    need(back == expected and len(out) <= MAX_CONFIG, "REWRITE_CHANGED_OTHER_VALUES")
    return out


def write_private(path, data, exclusive):
    uid, gid = service_uid()
    temp = path.parent / (".kmj-signin-scopes.%d.tmp" % os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        if exclusive:
            os.link(temp, path)  # never overwrite an existing backup
            os.unlink(temp)
        else:
            os.replace(temp, path)
    except OSError:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise Blocked("CONFIG_WRITE_FAILED") from None
    dir_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def schema_accepts(candidate):
    """Parse the candidate with the release's own schema, as the service user."""
    script = ("import fs from 'node:fs';"
              f"import {{ gatewaySchema }} from '{NEW_DIR}/src/config.js';"
              "const c = gatewaySchema.parse(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));"
              "if (c.oauth?.signInScopes !== 'all') process.exit(3);"
              "console.log('SCHEMA_OK');")
    try:
        out = cmd("runuser", "-u", SERVICE_USER, "--", NODE, "--input-type=module",
                  "-e", script, str(candidate), timeout=40)
    except Blocked:
        out = ""
    need(out == "SCHEMA_OK", "CANDIDATE_REJECTED_BY_GATEWAY_SCHEMA")


def challenge(port):
    """Unauthenticated read-tool call: the 401 header names the scopes asked for."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "list_devices", "arguments": {}}},
                      separators=(",", ":")).encode()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request("POST", "/mcp", body=body, headers={
            "Host": PUBLIC_HOST, "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"})
        response = connection.getresponse()
        response.read(65536)
        header = response.getheader("WWW-Authenticate") or ""
        status = response.status
        connection.close()
    except (OSError, http.client.HTTPException):
        raise Blocked("GATEWAY_PROBE_UNAVAILABLE") from None
    need(status == 401 and header.startswith("Bearer "), "GATEWAY_CHALLENGE_UNEXPECTED")
    return header


def restart_and_wait(port, wanted):
    old_pid = show("MainPID")
    cmd("systemctl", "restart", UNIT, timeout=90)
    deadline = time.monotonic() + 45
    last = "GATEWAY_RESTART_NOT_ACTIVE"
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            if show("ActiveState") != "active" or show("MainPID") in ("0", old_pid):
                continue
            if wanted in challenge(port):
                time.sleep(4)  # must still be up, not in a restart loop
                need(show("ActiveState") == "active" and wanted in challenge(port),
                     "GATEWAY_NOT_STABLE_AFTER_RESTART")
                return
            last = "GATEWAY_CHALLENGE_SCOPES_NOT_AS_EXPECTED"
        except Blocked as reason:
            last = str(reason)
    raise Blocked(last)


def preflight():
    config_path = gateway_config_path()
    require_trusted_parent(config_path)
    data = read_private(config_path)
    _, port = parse(data)
    return config_path, data, port


def apply():
    config_path, data, port = preflight()
    new = with_all_scopes(data)
    need(ONE_SCOPE in challenge(port), "BASELINE_CHALLENGE_NOT_SINGLE_SCOPE")
    backup = pathlib.Path(str(config_path) + BACKUP_SUFFIX)
    need(not os.path.lexists(backup), "BACKUP_ALREADY_PRESENT")
    print("SIGNIN_SCOPES_PREFLIGHT=PASS")
    print("BASELINE_CHALLENGE=SINGLE_SCOPE")
    if sys.argv[1:] != ["--apply", "--confirm-no-active-jobs"]:
        print("SIGNIN_SCOPES=DRY_RUN_UNCHANGED")
        return
    candidate = config_path.parent / (".kmj-signin-scopes-candidate.%d.json" % os.getpid())
    write_private(candidate, new, exclusive=True)
    try:
        schema_accepts(candidate)
    finally:
        os.unlink(candidate)
    print("CANDIDATE_SCHEMA=PASS")
    write_private(backup, data, exclusive=True)
    need(read_private(backup) == data, "BACKUP_READBACK_MISMATCH")
    write_private(config_path, new, exclusive=False)
    try:
        need(read_private(config_path) == new, "CONFIG_READBACK_MISMATCH")
        restart_and_wait(port, ALL_SCOPES)
    except Blocked as reason:
        print("SIGNIN_SCOPES=BLOCKED:" + str(reason))
        try:
            write_private(config_path, data, exclusive=False)
            need(read_private(config_path) == data, "RESTORE_READBACK_MISMATCH")
            restart_and_wait(port, ONE_SCOPE)
            os.unlink(backup)
            print("GATEWAY_CONFIG_ROLLBACK=PASS")
        except Blocked:
            print("GATEWAY_CONFIG_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED")
            print("PREVIOUS_CONFIG_BYTES_KEPT_AT_BACKUP_SUFFIX=" + BACKUP_SUFFIX)
        raise
    print("SIGNIN_SCOPES=ALL_LIVE_PASS")
    print("CHALLENGE=READ_WRITE_EXECUTE")
    print("GATEWAY_RESTARTED=YES")
    print("NEXT=RECONNECT_THE_CLAUDE_CONNECTOR_IN_THE_BROWSER")


def rollback():
    config_path, current, port = preflight()
    backup = pathlib.Path(str(config_path) + BACKUP_SUFFIX)
    previous = read_private(backup)
    need(with_all_scopes(previous) == current, "CONFIG_CHANGED_SINCE_APPLY")
    write_private(config_path, previous, exclusive=False)
    need(read_private(config_path) == previous, "RESTORE_READBACK_MISMATCH")
    restart_and_wait(port, ONE_SCOPE)
    os.unlink(backup)
    print("SIGNIN_SCOPES=ROLLED_BACK")
    print("GATEWAY_RESTARTED=YES")


def run():
    need(sys.platform.startswith("linux") and os.geteuid() == 0, "ROOT_REQUIRED")
    confirm = "--confirm-no-active-jobs"
    need(sys.argv[1:] in ([], ["--apply", confirm], ["--rollback", confirm]), "USAGE")
    if not sys.argv[1:]:
        apply()
        return
    try:
        fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise Blocked("GATEWAY_OWNER_LOCK_PRESENT") from None
    os.close(fd)
    try:
        if sys.argv[1] == "--rollback":
            rollback()
        else:
            apply()
    finally:
        try:
            os.unlink(LOCK)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        run()
    except Blocked as reason:
        safe = re.sub(r"[^A-Z0-9_]", "", str(reason))[:80]
        print("SIGNIN_SCOPES_RESULT=BLOCKED:" + safe)
        sys.exit(1)
