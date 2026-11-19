#!/usr/bin/env python3
"""KMJ-elite unattended owner-signed stable release (systemd oneshot, root).

Runs every few minutes from kmj-codebridge-auto-release.timer. It never signs
anything: it only applies a release that is ALREADY owner-signed (Ed25519 against
the root-owned trust file + pinned owner SPKI) and already merged to protected
main through an owner-approved PR. The signature plus that approval are the
release approval; this replaces the manual --manifest-sha256 root block.

Per tick, at most one release is processed, always the LOWEST sequence above the
live gateway sequence (releases are applied one at a time, never skipped):
  publish -> feed -> cutover   (all delegated to the hash-pinned owner_elite_release.py)

Safety rails:
  * kill switch: /etc/kmj-codebridge-release/auto-release.disabled stops everything
  * a release whose gateway cutover failed or rolled back is never retried
    automatically (recorded in root-owned state; the owner clears it)
  * cooldown between successful cutovers; no waiting inside a tick
  * root-only, KMJ-elite-only; no arguments, URLs or paths from outside
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import stat
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
RELEASE_FILE = "owner_elite_release.py"
RELEASE_SHA256 = "e11e9d463d432bb0f2fbbc5b0eededbfb554e0f71653dad8d005c3d16f3aafd3"
STATE_DIR = pathlib.Path("/var/lib/kmj-codebridge-release")
STATE = STATE_DIR / "auto-release-state.json"
DISABLED = pathlib.Path("/etc/kmj-codebridge-release/auto-release.disabled")
RUN_DIR = pathlib.Path("/run/kmj-codebridge-release")
API = ("https://api.github.com/repos/kmjtechno/kmj-codebridge/contents/"
       "releases/stable?ref=main")
COOLDOWN_SECONDS = 1800
MAX_STATE_BYTES = 32768
MAX_LISTING = 400


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


# ---------------------------------------------------------------- pure logic
def kill_switch_active(path=DISABLED):
    return os.path.lexists(path)


def parse_listing(raw, rev_re):
    """Names of directories that look like a release revision."""
    try:
        items = json.loads(raw)
    except ValueError:
        raise Blocked("LISTING_NOT_JSON") from None
    need(isinstance(items, list) and len(items) <= MAX_LISTING, "LISTING_SHAPE_INVALID")
    names = []
    for item in items:
        if (isinstance(item, dict) and item.get("type") == "dir"
                and isinstance(item.get("name"), str)
                and rev_re.fullmatch(item["name"])):
            names.append(item["name"])
    return sorted(names)


def pick_next(known, live_sequence, state):
    """Lowest sequence above the live one that was not already attempted."""
    attempted = state.get("attempted", {})
    options = [(seq, rev) for rev, seq in known.items()
               if seq > live_sequence and rev not in attempted]
    return min(options)[1] if options else None


def cooldown_ok(state, now, seconds=COOLDOWN_SECONDS):
    last = state.get("lastCutoverAt", 0)
    if not last or not isinstance(last, (int, float)):
        return True  # no earlier automatic cutover recorded
    return now - last >= seconds


def clean_state(raw):
    need(isinstance(raw, dict), "STATE_INVALID")
    seen = raw.get("seen", {})
    attempted = raw.get("attempted", {})
    need(isinstance(seen, dict) and isinstance(attempted, dict)
         and len(seen) <= 1000 and len(attempted) <= 1000, "STATE_INVALID")
    for rev, seq in seen.items():
        need(isinstance(rev, str) and len(rev) == 40 and type(seq) is int and seq >= 1,
             "STATE_INVALID")
    for rev, when in attempted.items():
        need(isinstance(rev, str) and len(rev) == 40 and isinstance(when, (int, float)),
             "STATE_INVALID")
    last = raw.get("lastCutoverAt", 0)
    need(isinstance(last, (int, float)), "STATE_INVALID")
    return {"seen": dict(seen), "attempted": dict(attempted), "lastCutoverAt": last}


def process(r, key, names, now, state, tmp, persist=None):
    """One tick. Returns (outcome, state); raises Blocked for hard failures.

    `r` is the pinned owner_elite_release module (or a stand-in in tests)."""
    live_sequence = r.newest_conf(os.listdir(r.DIR))[0]
    known = dict(state["seen"])
    for rev in names:
        if rev in known:
            continue
        raw = r.fetch(f"{r.RAW}/{rev}/release-manifest.json", tmp / f"m-{rev[:8]}")
        try:
            known[rev] = r.parse_manifest(raw, rev)["sequence"]
        except r.Blocked:
            continue
    state = {**state, "seen": known}
    rev = pick_next(known, live_sequence, state)
    if rev is None:
        return "NOTHING_TO_DO", state
    manifest = r.fetch(f"{r.RAW}/{rev}/release-manifest.json", tmp / "manifest-approve")
    args = {"rev": rev, "manifest_sha256": hashlib.sha256(manifest).hexdigest(),
            "step": "all", "apply": True}
    try:
        release = r.step_publish(args, key, tmp)
    except r.Blocked as error:
        # The GitHub release archive appears only after the publish workflow ran.
        if error.args and error.args[0] == "HTTPS_DOWNLOAD_FAILED":
            return "NOT_READY_ARCHIVE_MISSING", state
        raise
    r.step_feed(args)
    if not cooldown_ok(state, now):
        return "COOLDOWN_CUTOVER_DEFERRED", state
    attempted = dict(state["attempted"])
    attempted[rev] = now
    state = {**state, "attempted": attempted}
    if persist:
        persist(state)  # recorded BEFORE the restart: a crash never auto-retries
    r.UPDATER_WAIT_SECONDS = 0
    r.step_cutover(args, tmp)
    after = r.newest_conf(os.listdir(r.DIR))[0]
    if after == release["sequence"]:
        return "CUTOVER_DONE", {**state, "lastCutoverAt": now}
    # Runtime not installed by the signed updater yet: retry on the next tick.
    attempted.pop(rev, None)
    return "WAITING_FOR_UPDATER", {**state, "attempted": attempted}


# ------------------------------------------------------------------ real host
def load_release():
    path = HERE / RELEASE_FILE
    need(path.is_file() and not path.is_symlink()
         and hashlib.sha256(path.read_bytes()).hexdigest() == RELEASE_SHA256,
         "RELEASE_SCRIPT_MISSING_OR_CHANGED")
    spec = importlib.util.spec_from_file_location("kmj_elite_release", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_state(strict=True, path=STATE):
    if not os.path.lexists(path):
        return {"seen": {}, "attempted": {}, "lastCutoverAt": 0}
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1
             and st.st_size <= MAX_STATE_BYTES and (st.st_mode & 0o077) == 0
             and (not strict or st.st_uid == 0), "STATE_UNTRUSTED")
        raw = os.read(fd, MAX_STATE_BYTES + 1)
    finally:
        os.close(fd)
    try:
        return clean_state(json.loads(raw))
    except ValueError:
        raise Blocked("STATE_INVALID") from None


def save_state(state, path=STATE):
    path.parent.mkdir(mode=0o700, exist_ok=True)
    need(not path.parent.is_symlink(), "STATE_DIR_UNTRUSTED")
    data = json.dumps(clean_state(state), sort_keys=True).encode()
    temp = path.with_name(path.name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)


def run():
    need(getattr(os, "geteuid", lambda: 1)() == 0
         and socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_ROOT_OR_HOST")
    if kill_switch_active():
        print("AUTO_RELEASE=DISABLED_BY_OWNER")
        return 0
    r = load_release()
    key = r.trust_key()
    state = load_state()
    RUN_DIR.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tick-", dir=RUN_DIR) as directory:
        tmp = pathlib.Path(directory)
        listing = r.fetch(API, tmp / "listing")
        names = parse_listing(listing, r.REV_RE)
        try:
            outcome, state = process(r, key, names, time.time(), state, tmp, save_state)
        except r.Blocked as error:
            # Hard failure after the cutover was attempted stays recorded: no auto retry.
            reason = error.args[0] if error.args else "UNCLASSIFIED"
            print("AUTO_RELEASE=BLOCKED_NO_AUTO_RETRY")
            print("REASON=" + str(reason))
            return 2
        save_state(state)
    print("AUTO_RELEASE=" + outcome)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Blocked as error:
        print("AUTO_RELEASE=BLOCKED")
        print("REASON=" + (str(error.args[0]) if error.args else "UNCLASSIFIED"))
        sys.exit(2)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        print("AUTO_RELEASE=BLOCKED")
        print("REASON=UNCLASSIFIED")
        sys.exit(2)
