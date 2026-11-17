#!/usr/bin/env python3
"""Owner-root activation of the opt-in FreeLLMAPI zero-cost verifier env.

Adds ONLY these variables to the existing /etc/kmj-freellmapi/codebridge.env
(root:root, 0600) and sets the approved chain to the one verified chain:
  CODEBRIDGE_OPENROUTER_KEY            from a HIDDEN prompt, never printed
  CODEBRIDGE_FREELLMAPI_PINS_DIR       /etc/kmj-freellmapi-pins
  CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR   /var/lib/kmj-freellmapi-chain
  CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS=<chain>

Refuses unless the pinned manifest and a fresh live snapshot both exist for
the chain and contain only OpenRouter exact `:free` models, and the key is
accepted by OpenRouter. Rewrites the env file by atomic replace and restarts
the agent once; on failure restores the original bytes and restarts.
Touches nothing else: no gateway, updater, nginx, unit file or source.

Dry-run by default (checks only, no prompt). Writing needs:
  <chain> --apply --confirm-no-active-jobs
Replacing only the OpenRouter key later (the other variables must already be
set for that chain) needs:
  <chain> --rotate-key --confirm-no-active-jobs
A key whose credit limit or budget is exhausted/zero, or that shows any
recorded spend, is refused before anything is written: the verifier would
reject it anyway. Create the evidence key WITHOUT a credit limit and keep the
account balance at zero.
Generation stays blocked until the running agent build contains the verifier
wiring AND a real-account proof exists; this script proves neither.
"""
import getpass
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

UNIT = "kmj-codebridge-kmj-main-platform.service"
ENV_FILE = pathlib.Path("/etc/kmj-freellmapi/codebridge.env")
PINS_DIR = pathlib.Path("/etc/kmj-freellmapi-pins")
SNAPSHOT_DIR = pathlib.Path("/var/lib/kmj-freellmapi-chain")
OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
CHAIN_RE = re.compile(r"^auto:([A-Za-z0-9._-]{1,48})$")
MODEL_RE = re.compile(r"^[a-z0-9._-]+/[A-Za-z0-9._-]+:free$")
KEY_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{16,300}$")
SNAPSHOT_MAX_AGE_MS = 120_000
NEW_KEYS = (
    "CODEBRIDGE_OPENROUTER_KEY",
    "CODEBRIDGE_FREELLMAPI_PINS_DIR",
    "CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR",
)
APPROVED_KEY = "CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS"


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def cmd(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, timeout=120,
                          check=check)


def protected(path):
    try:
        st = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022)


def read_json(path, code):
    try:
        st = path.lstat()
        guard(stat.S_ISREG(st.st_mode) and not (st.st_mode & 0o022), code)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError(code) from None


def chain_models(chain, now_ms):
    """Pin and fresh snapshot must agree on an all-OpenRouter :free set."""
    match = CHAIN_RE.match(chain)
    guard(match, "CHAIN_NAME_REJECTED")
    name = match.group(1)
    pin = read_json(PINS_DIR / f"route-binding-{name}.json", "PIN_MISSING_OR_UNSAFE")
    guard(pin.get("version") == 1 and pin.get("chain") == chain, "PIN_CHAIN_MISMATCH")
    pinned = pin.get("models")
    guard(isinstance(pinned, list) and pinned
          and all(isinstance(m, str) and MODEL_RE.match(m) for m in pinned)
          and len(set(pinned)) == len(pinned), "PIN_MODELS_NOT_ALL_FREE")
    snap = read_json(SNAPSHOT_DIR / f"{name}.json", "SNAPSHOT_MISSING_OR_UNSAFE")
    guard(snap.get("version") == 1 and snap.get("chain") == chain,
          "SNAPSHOT_CHAIN_MISMATCH")
    observed = snap.get("observedAtEpochMs")
    guard(isinstance(observed, int) and 0 <= now_ms - observed <= SNAPSHOT_MAX_AGE_MS,
          "SNAPSHOT_STALE")
    members = snap.get("members")
    guard(isinstance(members, list)
          and all(isinstance(m, dict) and m.get("platform") == "openrouter"
                  for m in members), "SNAPSHOT_NOT_ALL_OPENROUTER")
    guard(sorted(m.get("modelId") for m in members) == sorted(pinned),
          "SNAPSHOT_DIFFERS_FROM_PIN")
    return pinned


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def openrouter_accepts(key):
    req = urllib.request.Request(
        OPENROUTER_KEY_URL, headers={"Authorization": f"Bearer {key}"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=15) as resp:
            guard(resp.status == 200, "OPENROUTER_KEY_NOT_ACCEPTED")
            body = json.load(resp)
    except urllib.error.HTTPError:
        raise ValueError("OPENROUTER_KEY_NOT_ACCEPTED") from None
    except (OSError, ValueError):
        raise ValueError("OPENROUTER_UNREACHABLE") from None
    guard(isinstance(body, dict) and isinstance(body.get("data"), dict),
          "OPENROUTER_KEY_NOT_ACCEPTED")
    reasons = key_blockers(body["data"])
    guard(not reasons, "OPENROUTER_KEY_WOULD_BE_REJECTED:" + ",".join(reasons))


def key_blockers(d):
    """Same blocking rules as src/openrouter-free-evidence.js, categories only."""
    reasons = []
    for field in ("usage", "usage_daily", "usage_weekly", "usage_monthly",
                  "byok_usage"):
        v = d.get(field)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != 0:
            reasons.append("SPEND_NOT_ZERO_" + field)
    budget = d.get("effective_budget")
    if budget is not None:
        r = budget.get("remaining_usd") if isinstance(budget, dict) else None
        if isinstance(r, bool) or not isinstance(r, (int, float)) or r <= 0:
            reasons.append("BUDGET_BLOCKING")
    left = d.get("limit_remaining")
    if left is not None and (isinstance(left, bool)
                             or not isinstance(left, (int, float)) or left <= 0):
        reasons.append("KEY_LIMIT_EXHAUSTED_SET_NO_CREDIT_LIMIT")
    return reasons


def env_lines():
    st = ENV_FILE.lstat()
    guard(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o077),
          "ENV_FILE_UNSAFE")
    original = ENV_FILE.read_bytes()
    return original, original.decode("utf-8").splitlines()


def build_env(lines, key, chain):
    present = {ln.split("=", 1)[0] for ln in lines if "=" in ln}
    guard(not present.intersection(NEW_KEYS), "ENV_ALREADY_HAS_VERIFIER_KEYS")
    guard("CODEBRIDGE_FREELLMAPI_KEY" in present, "FREELLMAPI_KEY_LINE_MISSING")
    out = [ln for ln in lines if not ln.startswith(f"{APPROVED_KEY}=")]
    out += [
        f"{APPROVED_KEY}={chain}",
        f"CODEBRIDGE_OPENROUTER_KEY={key}",
        f"CODEBRIDGE_FREELLMAPI_PINS_DIR={PINS_DIR}",
        f"CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR={SNAPSHOT_DIR}",
    ]
    return ("\n".join(out) + "\n").encode("utf-8")


def rotate_env(lines, key, chain):
    """Replace only the OpenRouter key line; everything else stays identical."""
    index = [i for i, ln in enumerate(lines)
             if ln.startswith("CODEBRIDGE_OPENROUTER_KEY=")]
    guard(len(index) == 1, "ENV_HAS_NO_SINGLE_OPENROUTER_KEY_LINE")
    present = {ln.split("=", 1)[0]: ln.split("=", 1)[1]
               for ln in lines if "=" in ln}
    guard(present.get("CODEBRIDGE_FREELLMAPI_PINS_DIR") == str(PINS_DIR)
          and present.get("CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR") == str(SNAPSHOT_DIR)
          and present.get(APPROVED_KEY) == chain, "ENV_NOT_ENABLED_FOR_CHAIN")
    out = list(lines)
    out[index[0]] = f"CODEBRIDGE_OPENROUTER_KEY={key}"
    return ("\n".join(out) + "\n").encode("utf-8")


def replace_env(data):
    """Atomic same-directory replace; exclusive no-follow temp, 0600."""
    guard(protected(ENV_FILE.parent), "ENV_PARENT_UNSAFE")
    tmp = ENV_FILE.with_name(ENV_FILE.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, ENV_FILE)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def restart_and_wait():
    cmd("systemctl", "restart", UNIT)
    for _ in range(20):
        time.sleep(2)
        if cmd("systemctl", "is-active", UNIT, check=False).stdout.strip() == "active":
            return
    raise ValueError("AGENT_NOT_ACTIVE_AFTER_RESTART")


def preflight(chain, rotate=False):
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    guard(cmd("systemctl", "is-active", UNIT, check=False).stdout.strip() == "active",
          "AGENT_NOT_ACTIVE")
    guard(protected(PINS_DIR) and protected(SNAPSHOT_DIR.parent),
          "PIN_OR_SNAPSHOT_PARENT_UNSAFE")
    models = chain_models(chain, int(time.time() * 1000))
    original, lines = env_lines()
    if rotate:
        rotate_env(lines, "x" * 16, chain)  # structure check only; dummy value
    else:
        build_env(lines, "x" * 16, chain)  # structure check only; dummy value
    return models, original, lines


def main():
    args = sys.argv[1:]
    modes = {"--apply": "apply", "--rotate-key": "rotate"}
    guard(len(args) in (1, 3) and CHAIN_RE.match(args[0])
          and (len(args) == 1
               or (args[1] in modes and args[2] == "--confirm-no-active-jobs")),
          "USAGE_<chain>_[--apply|--rotate-key]_--confirm-no-active-jobs")
    chain = args[0]
    mode = modes[args[1]] if len(args) == 3 else "dry"
    rotate = mode == "rotate"
    models, original, lines = preflight(chain, rotate)
    print(f"PREFLIGHT=OK CHAIN={chain} MODELS={len(models)} ALL_OPENROUTER_FREE=yes"
          + (" MODE=rotate_key" if rotate else ""))
    if mode == "dry":
        print("ENV=DRY_RUN_UNCHANGED")
        return
    key = getpass.getpass("OpenRouter API key (hidden, not echoed): ").strip()
    guard(KEY_RE.match(key), "OPENROUTER_KEY_FORMAT_REJECTED")
    openrouter_accepts(key)
    print("OPENROUTER_KEY=ACCEPTED")
    replace_env(rotate_env(lines, key, chain) if rotate
                else build_env(lines, key, chain))
    try:
        restart_and_wait()
    except BaseException:
        replace_env(original)
        cmd("systemctl", "restart", UNIT, check=False)
        print("ENV=FAILED_RESTORED")
        raise
    print(f"ENV=OK approved_chains=1 agent=active chain={chain}"
          + (" rotated=yes" if rotate else ""))


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        print(f"BLOCKED={exc}")
        sys.exit(2)
