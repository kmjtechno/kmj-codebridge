#!/usr/bin/env python3
"""Owner-root guarded rotation of the gateway-held GitHub token (issue #723).

Replaces ONLY the gateway's GitHub token line in the one EnvironmentFile that
defines it, after the new token is proven against api.github.com. The token is
typed into a hidden prompt (never an argument, never printed, never logged).
Dry-run by default.

  python3 -I owner_rotate_github_token_20261119.py                 # dry-run
  python3 -I owner_rotate_github_token_20261119.py --apply --confirm-gateway-restart

Apply: backs up the original file (root 0600), writes the new line atomically,
restarts the gateway unit once, and restores the original bytes and restarts
again if the gateway is not active with a new PID within the timeout.
"""
import getpass
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

UNIT = "kmj-codebridge-gateway-stage.service"
GATEWAY_JSON = pathlib.Path("/etc/kmj-codebridge-stage/gateway.json")
CANDIDATE_VARS = ("CODEBRIDGE_GITHUB_PROXY_TOKEN", "KMJ_CODEBRIDGE_GITHUB_TOKEN")
VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
TOKEN_RE = re.compile(r"^github_pat_[A-Za-z0-9_]{30,250}$")
REPOS = ("kmjtechno/kmj-codebridge", "kmjtechno/kmj-main-platform")
API = "https://api.github.com"
BACKUP_DIR = pathlib.Path("/root/github-token-rotation-backup")


def out(key, value):
    print(f"{key}={value}")


def run(*args, timeout=30):
    return subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, check=False)


def show(prop):
    return run("/usr/bin/systemctl", "show", UNIT, "-P", prop, timeout=15).stdout.strip()


def valid_token(tok):
    return isinstance(tok, str) and TOKEN_RE.match(tok) is not None


def find_line(text, names):
    """Return (name, index) when exactly one assignment of a candidate var exists."""
    hits = []
    lines = text.split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"^(?:export\s+)?([A-Z][A-Z0-9_]*)=", line)
        if m and m.group(1) in names:
            hits.append((m.group(1), i))
    return hits[0] if len(hits) == 1 else None


def replace_line(text, name, index, token):
    lines = text.split("\n")
    prefix = "export " if lines[index].startswith("export ") else ""
    lines[index] = f"{prefix}{name}={token}"
    return "\n".join(lines)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def gh_get(path, tok):
    req = urllib.request.Request(
        API + path,
        headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kmj-codebridge-rotate"})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as r:
            return r.status, r.read(262144)
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:
        return 0, b""


def probe(tok):
    """Prove read on both repos; report push only when GitHub says so."""
    ok = True
    for repo in REPOS:
        st, body = gh_get("/repos/" + repo, tok)
        push = "unknown"
        if st == 200:
            try:
                p = json.loads(body).get("permissions")
                if isinstance(p, dict):
                    push = "yes" if p.get("push") else "no"
            except Exception:
                pass
        out("PROBE", f"{repo} http={st} push={push}")
        if st != 200 or push == "no":
            ok = False
    return ok


def locate_env_file():
    names = list(CANDIDATE_VARS)
    try:
        te = json.loads(GATEWAY_JSON.read_text()).get("github", {}).get("tokenEnv")
        if isinstance(te, str) and VAR_RE.match(te) and te not in names:
            names.append(te)
    except Exception:
        pass
    raw = show("EnvironmentFiles")
    files = []
    for part in raw.split("\n"):
        m = re.match(r"^(/\S+)", part.strip())
        if m:
            files.append(pathlib.Path(m.group(1)))
    found = []
    for f in files:
        try:
            st = f.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0:
                continue
            text = f.read_text()
        except Exception:
            continue
        hit = find_line(text, names)
        if hit:
            found.append((f, hit[0], hit[1]))
    return found[0] if len(found) == 1 else None


def atomic_write(path, data, like):
    st = like.stat()
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".ghtok-")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def wait_active(old_pid, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        time.sleep(2)
        try:
            pid = int(show("MainPID"))
        except ValueError:
            pid = 0
        if show("ActiveState") == "active" and pid > 0 and pid != old_pid:
            return pid
    return 0


def main(argv):
    apply = "--apply" in argv
    if apply and "--confirm-gateway-restart" not in argv:
        out("BLOCKED", "CONFIRM_FLAG_REQUIRED")
        return 2
    if os.geteuid() != 0:
        out("BLOCKED", "ROOT_REQUIRED")
        return 2
    try:
        old_pid = int(show("MainPID"))
    except ValueError:
        old_pid = 0
    if old_pid <= 0:
        out("BLOCKED", "GATEWAY_NOT_RUNNING")
        return 2
    loc = locate_env_file()
    if not loc:
        out("BLOCKED", "TOKEN_ENV_FILE_NOT_UNIQUE_OR_NOT_IN_ENVIRONMENTFILE")
        return 2
    path, name, index = loc
    out("ENV_FILE", str(path))
    out("PREFLIGHT", "OK")
    tok = getpass.getpass("New GitHub fine-grained token (hidden): ").strip()
    if not valid_token(tok):
        out("BLOCKED", "TOKEN_FORMAT_INVALID")
        return 2
    if not probe(tok):
        out("BLOCKED", "NEW_TOKEN_NOT_ACCEPTED_OR_NO_PUSH")
        return 2
    out("NEW_TOKEN", "ACCEPTED")
    if not apply:
        out("RESULT", "DRY_RUN_UNCHANGED")
        return 0
    original = path.read_text()
    again = find_line(original, [name])
    if again != (name, index):
        out("BLOCKED", "ENV_FILE_CHANGED_DURING_RUN")
        return 2
    BACKUP_DIR.mkdir(mode=0o700, exist_ok=True)
    backup = BACKUP_DIR / f"{path.name}.{time.time_ns()}.bak"
    fd = os.open(str(backup), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(original)
    out("BACKUP", "CREATED")
    try:
        atomic_write(path, replace_line(original, name, index, tok), path)
        r = run("/usr/bin/systemctl", "restart", UNIT, timeout=90)
        new_pid = wait_active(old_pid) if r.returncode == 0 else 0
        if not new_pid:
            raise RuntimeError("GATEWAY_NOT_ACTIVE")
    except Exception:
        atomic_write(path, original, path)
        run("/usr/bin/systemctl", "restart", UNIT, timeout=90)
        out("RESULT", "ROLLED_BACK")
        return 2
    out("GATEWAY", f"active old_pid={old_pid} new_pid={new_pid}")
    out("RESULT", "ROTATED")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
