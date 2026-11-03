#!/usr/bin/env python3
"""KMJ CodeBridge stable15: read-only sanitized public origin route inventory."""
import hashlib
import os
import pathlib
import re
import socket
import stat
import subprocess
from urllib.parse import urlsplit

PREVIOUS = "2d713aa9aa9a0641f0591ff6c881df62d68bfd22"
URL = ("https://kmjtechno.com/codebridge/releases/stable/" + PREVIOUS
       + "/release-manifest.json")
REL = "codebridge/releases/stable/" + PREVIOUS + "/release-manifest.json"
SCAN_ROOTS = ("/var/www", "/home/kmjprod", "/srv", "/opt/kmj-codebridge-stable")
SKIP = frozenset((".git", "node_modules", "vendor", ".cache", "cache", "logs",
                  "log", "tmp", "private", "secrets", "config", "database"))

def names_from_nginx(raw):
    roots, aliases = set(), set()
    for line in raw.splitlines():
        m = re.match(r"^\s*(root|alias)\s+(/[^;\s]+)\s*;", line)
        if m and "$" not in m.group(2):
            (roots if m.group(1) == "root" else aliases).add(m.group(2))
    return roots, aliases

def safe_public_match(candidate, old_digest, old_size):
    try:
        s = candidate.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_size != old_size or s.st_size > 65536:
            return False
        if candidate.is_symlink() or candidate.parent.is_symlink():
            return False
        return hashlib.sha256(candidate.read_bytes()).hexdigest() == old_digest
    except (OSError, ValueError):
        return False

def candidate_paths(roots, aliases):
    candidates = set()
    for root in roots:
        base = pathlib.Path(root)
        candidates.add(base / REL)
    for alias in aliases:
        base = pathlib.Path(alias)
        for suffix in (REL,
                       "releases/stable/" + PREVIOUS + "/release-manifest.json",
                       "stable/" + PREVIOUS + "/release-manifest.json",
                       PREVIOUS + "/release-manifest.json"):
            candidates.add(base / suffix)
    return candidates

def bounded_named_search(roots, digest, size, max_entries=18000, max_depth=8):
    result = set()
    visits = 0
    for root in roots:
        base = pathlib.Path(root)
        if not base.is_dir() or base.is_symlink():
            continue
        stack = [(base, 0)]
        while stack and visits < max_entries:
            directory, depth = stack.pop()
            try:
                with os.scandir(directory) as it:
                    entries = list(it)
            except OSError:
                continue
            for entry in entries:
                visits += 1
                if visits > max_entries:
                    break
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if depth < max_depth and entry.name not in SKIP:
                            stack.append((pathlib.Path(entry.path), depth + 1))
                    elif entry.name == "release-manifest.json":
                        candidate = pathlib.Path(entry.path)
                        if (candidate.parent.name == PREVIOUS and
                            safe_public_match(candidate, digest, size)):
                            result.add(str(candidate.parent.parent.resolve()))
                except OSError:
                    continue
    return result, visits

def run():
    if os.geteuid() != 0 or socket.gethostname().split(".")[0].lower() != "kmj-elite":
        print("ROUTE_AUDIT=BLOCKED_WRONG_HOST_OR_USER")
        return 2
    public = urlsplit(URL)
    if public.netloc != "kmjtechno.com" or public.scheme != "https":
        print("ROUTE_AUDIT=BLOCKED_PUBLIC_IDENTITY")
        return 2
    curl = subprocess.run(
        ["curl", "-fLSs", "--max-time", "25", "--proto", "=https",
         "--proto-redir", "=https", URL],
        capture_output=True, timeout=32)
    if curl.returncode != 0 or not 2 <= len(curl.stdout) <= 65536:
        print("PUBLIC_OLD_MANIFEST=UNVERIFIED")
        return 2
    old_digest = hashlib.sha256(curl.stdout).hexdigest()
    output = subprocess.run(["nginx", "-T"], capture_output=True, text=True,
                            errors="replace", timeout=25)
    if output.returncode != 0 or len(output.stdout) > 2_000_000:
        print("NGINX_TOPOLOGY=UNVERIFIED")
        return 2
    roots, aliases = names_from_nginx(output.stdout)
    candidates = candidate_paths(roots | {"/var/www/html", "/usr/share/nginx/html",
                         "/home/kmjprod/current/public"}, aliases)
    exact = {str(p.parent.parent.resolve()) for p in candidates
             if p.parent.name == PREVIOUS and safe_public_match(p, old_digest, len(curl.stdout))}
    scanned, visits = bounded_named_search(SCAN_ROOTS, old_digest, len(curl.stdout))
    matches = exact | scanned
    codebridge_locations = [line.strip() for line in output.stdout.splitlines()
                            if re.match(r"^\s*location\s+.*codebridge", line, re.I)]
    release_locations = [line for line in codebridge_locations if "release" in line.lower()]
    print("PUBLIC_OLD_MANIFEST=PASS")
    print("NGINX_TOPOLOGY=PASS")
    print("NGINX_ROOT_ENTRIES=" + str(len(roots)))
    print("NGINX_ALIAS_ENTRIES=" + str(len(aliases)))
    print("CODEBRIDGE_LOCATION_COUNT=" + str(len(codebridge_locations)))
    print("RELEASE_LOCATION_COUNT=" + str(len(release_locations)))
    for kind, token in (
        ("PROXY_ROUTE", "proxy_pass"),
        ("PHP_ROUTE", "fastcgi_pass"),
        ("FALLBACK_ROUTE", "try_files"),
        ("REWRITE_ROUTE", "rewrite"),
    ):
        print("NGINX_" + kind + "=" + ("PRESENT" if token in output.stdout else "ABSENT"))
    print("MATCHED_PUBLIC_MANIFEST_DIR_COUNT=" + str(len(matches)))
    for i, parent in enumerate(sorted(matches)[:3], 1):
        print("PUBLIC_MANIFEST_PARENT_" + str(i) + "=" + parent)
    print("ROUTE_SCAN_BOUNDED_ENTRIES=" + str(visits))
    print("ROUTE_DIAGNOSTIC=READ_ONLY_COMPLETE")
    if not matches:
        print("ORIGIN_CLASS=NOT_A_VERIFIED_LOCAL_STATIC_FILE")
    elif len(matches) == 1:
        print("ORIGIN_CLASS=EXACT_LOCAL_BYTES_MATCH")
    else:
        print("ORIGIN_CLASS=AMBIGUOUS_MULTIPLE_LOCAL_COPIES")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print("ROUTE_DIAGNOSTIC=BLOCKED_UNCLASSIFIED")
        raise SystemExit(2)
