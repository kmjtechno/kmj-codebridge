#!/usr/bin/env python3
"""Owner-root READ-ONLY diagnostic for the gateway-held GitHub credential.

Issue #723. Reads the running gateway's own credential from /proc/<MainPID>/environ
(root only), then makes ONLY authenticated GETs to https://api.github.com
(/rate_limit and /repos/<owner>/<repo> for two fixed repositories). It never
prints the token, variable names, headers or response bodies; never changes
anything on the host or any grant. Output is fixed-field tokens only.

Usage: python3 -I owner_diagnose_github_credential_20261119.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

UNIT = "kmj-codebridge-gateway-stage.service"
GATEWAY_JSON = pathlib.Path("/etc/kmj-codebridge-stage/gateway.json")
FIXED_VARS = ("CODEBRIDGE_GITHUB_PROXY_TOKEN", "KMJ_CODEBRIDGE_GITHUB_TOKEN")
VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
REPOS = ("kmjtechno/kmj-codebridge", "kmjtechno/kmj-main-platform")
API = "https://api.github.com"


def out(key, value):
    print(f"{key}={value}")


def systemctl_show(prop):
    r = subprocess.run(
        ["/usr/bin/systemctl", "show", UNIT, "-P", prop],
        capture_output=True, text=True, timeout=12, check=False)
    return r.stdout.strip()


def token_class(tok):
    if tok.startswith("github_pat_"):
        return "fine_grained_pat"
    if tok.startswith("ghp_"):
        return "classic_pat"
    if tok.startswith("ghs_"):
        return "app_installation"
    if tok.startswith("ghu_"):
        return "user_to_server"
    return "unknown"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(path, tok):
    req = urllib.request.Request(
        API + path,
        headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kmj-codebridge-diag"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=15) as resp:
            return resp.status, resp.headers, resp.read(262144)
    except urllib.error.HTTPError as e:
        return e.code, e.headers, b""
    except Exception:
        return 0, {}, b""


def expiry_category(headers):
    raw = headers.get("github-authentication-token-expiration") if headers else None
    if not raw:
        return "none"
    try:
        t = time.mktime(time.strptime(raw.rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S"))
    except Exception:
        return "unparsed"
    left = t - time.time()
    return "expired" if left <= 0 else ("under_7d" if left < 7 * 86400 else "ok")


def classify(status, headers):
    if status == 200:
        return "READ_OK"
    if status == 401:
        return "TOKEN_INVALID_OR_EXPIRED"
    if status == 403:
        rem = headers.get("x-ratelimit-remaining") if headers else None
        return "RATE_LIMITED" if rem == "0" else "FORBIDDEN_GRANT_OR_SSO"
    if status == 404:
        return "NO_ACCESS_OR_MISSING"
    return "NETWORK_OR_OTHER"


def main():
    if os.geteuid() != 0:
        out("BLOCKED", "ROOT_REQUIRED")
        return 2
    try:
        pid = int(systemctl_show("MainPID"))
    except ValueError:
        pid = 0
    if pid <= 0:
        out("GATEWAY_PROCESS", "FAIL")
        return 2
    out("GATEWAY_PROCESS", "OK")
    names = list(FIXED_VARS)
    try:
        tok_env = json.loads(GATEWAY_JSON.read_text()).get("github", {}).get("tokenEnv")
        if isinstance(tok_env, str) and VAR_RE.match(tok_env) and tok_env not in names:
            names.append(tok_env)
    except Exception:
        pass
    try:
        raw = pathlib.Path(f"/proc/{pid}/environ").read_bytes()
    except Exception:
        out("GATEWAY_ENV", "UNREADABLE")
        return 2
    env = {}
    for item in raw.split(b"\0"):
        k, sep, v = item.partition(b"=")
        if sep:
            env[k.decode("utf8", "replace")] = v.decode("utf8", "replace")
    tok = next((env[n] for n in names if len(env.get(n, "")) >= 20), "")
    out("GITHUB_TOKEN_PRESENT", "yes" if tok else "no")
    read_only = env.get("CODEBRIDGE_GITHUB_PUBLIC_READ_ONLY", "").lower() == "true"
    out("PUBLIC_READ_ONLY", "yes" if read_only else "no")
    base = env.get("CODEBRIDGE_GITHUB_API_BASE", "")
    out("API_BASE", "github" if base.rstrip("/") in ("", API) else "other_skipped")
    if not tok or base.rstrip("/") not in ("", API):
        out("RESULT", "NO_PROBE")
        return 1
    out("TOKEN_CLASS", token_class(tok))
    st, hd, _ = get("/rate_limit", tok)
    out("RATE_LIMIT", f"{classify(st, hd)} http={st} token_expiry={expiry_category(hd)}")
    verdicts = []
    for repo in REPOS:
        st, hd, body = get("/repos/" + repo, tok)
        v = classify(st, hd)
        push = "unknown"
        if st == 200:
            try:
                p = json.loads(body).get("permissions")
                push = "unknown" if not isinstance(p, dict) else ("yes" if p.get("push") else "no")
            except Exception:
                pass
        out("REPO", f"{repo} {v} http={st} push={push}")
        verdicts.append(v)
    out("RESULT", "READ_OK" if all(v == "READ_OK" for v in verdicts) else "NEEDS_OPERATOR_REPAIR")
    return 0


if __name__ == "__main__":
    sys.exit(main())
