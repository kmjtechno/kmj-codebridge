#!/usr/bin/env python3
"""Owner-root: inspect and pin a FreeLLMAPI named chain for the zero-cost verifier.

Opens the router SQLite READ-ONLY, resolves the named chain (e.g. auto:free-code),
lists its enabled members and says whether every member is an OpenRouter exact
`vendor/model:free` model. Dry-run by default: prints a verdict, writes nothing.
`--apply --confirm-pin <chain>` writes the digest-checked manifest consumed by
src/freellmapi-zero-cost-verifier.js (version 1, sha256 over the sorted id list).
Writing a manifest does NOT enable generation and proves nothing about billing.
Never prints keys; the router's encrypted key table is never opened.
"""
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys

DEFAULT_DB = "/opt/kmj-freellmapi/data/freeapi.db"
OUT_DIR = pathlib.Path("/etc/kmj-freellmapi-pins")  # root-owned, agent-readable, non-secret
CHAIN = re.compile(r"^auto:[A-Za-z0-9._-]{1,48}$")
MODEL = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}:free$")
MAX_MODELS = 50
QUERY = """
SELECT m.platform, m.model_id
FROM profiles p
JOIN profile_models pm ON pm.profile_id = p.id AND pm.enabled = 1
JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
WHERE LOWER(p.name) = ?
ORDER BY pm.priority
"""


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def digest(models):
    return hashlib.sha256(
        json.dumps(sorted(models), separators=(",", ":")).encode()).hexdigest()


def members(db, chain):
    uri = pathlib.Path(db).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=10)
    try:
        return con.execute(QUERY, (chain.split(":", 1)[1].lower(),)).fetchall()
    finally:
        con.close()


def verdict(rows):
    problems = []
    if not rows:
        problems.append("CHAIN_EMPTY_OR_UNKNOWN")
    if len(rows) > MAX_MODELS:
        problems.append("TOO_MANY_MEMBERS")
    for platform, model_id in rows:
        if platform != "openrouter":
            problems.append(f"NON_OPENROUTER_MEMBER:{platform}")
        elif not MODEL.match(model_id):
            problems.append(f"NOT_EXACT_FREE_ID:{model_id[:60]}")
    if len({r[1] for r in rows}) != len(rows):
        problems.append("DUPLICATE_MEMBERS")
    return sorted(set(problems))


def main(argv):
    args = list(argv)
    db = DEFAULT_DB
    out = None
    if "--db" in args:
        i = args.index("--db")
        db = args[i + 1]
        del args[i:i + 2]
    if "--out" in args:
        i = args.index("--out")
        out = pathlib.Path(args[i + 1])
        del args[i:i + 2]
    guard(len(args) >= 1 and CHAIN.match(args[0]), "USAGE_CHAIN_auto:<name>")
    chain = args[0]
    apply = args[1:] == ["--apply", "--confirm-pin", chain]
    guard(args[1:] in ([], ["--apply", "--confirm-pin", chain]),
          "USAGE_DRY_RUN_OR_--apply_--confirm-pin_<chain>")
    if db == DEFAULT_DB:
        guard(os.geteuid() == 0, "ROOT_REQUIRED")
    guard(pathlib.Path(db).is_file(), "DB_NOT_FOUND")
    rows = members(db, chain)
    problems = verdict(rows)
    print(f"CHAIN={chain} MEMBERS={len(rows)}")
    for platform, model_id in rows:
        print(f"  {platform} {model_id}")
    if problems:
        for p in problems:
            print(f"PROBLEM={p}")
        print("PIN=BLOCKED_CHAIN_NOT_ALL_OPENROUTER_FREE")
        sys.exit(2)
    ids = [r[1] for r in rows]
    print(f"DIGEST={digest(ids)}")
    if not apply:
        print("PIN=DRY_RUN_UNCHANGED")
        return
    target = out or OUT_DIR / f"route-binding-{chain.split(':', 1)[1]}.json"
    guard(not target.exists(), "MANIFEST_ALREADY_EXISTS")
    target.parent.mkdir(mode=0o755, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "w") as fh:
        json.dump({"version": 1, "chain": chain, "models": sorted(ids),
                   "sha256": digest(ids)}, fh)
    print(f"PIN=WRITTEN {target}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, sqlite3.Error, IndexError) as exc:
        print(f"BLOCKED={exc if isinstance(exc, ValueError) else type(exc).__name__}")
        sys.exit(2)
