#!/usr/bin/env python3
"""Seal/verify public Cargo registry caches; never copy credentials or config."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tomllib

LIMIT = 512 * 1024 * 1024

def fail():
    raise ValueError("CI_PREREQUISITE_CACHE_INVALID")

def regular_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            fail()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            content = stream.read(LIMIT + 1)
        after = os.fstat(fd)
        before_state = (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_uid, info.st_mode)
        after_state = (after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_uid, after.st_mode)
        if len(content) > LIMIT or len(content) != info.st_size or before_state != after_state: fail()
        return content
    finally:
        os.close(fd)

def locked_crates(lock):
    raw = regular_bytes(lock)
    doc = tomllib.loads(raw.decode("utf-8"))
    expected = {}
    for package in doc.get("package", []):
        source = package.get("source")
        if source is None:
            if package.get("name") != "kmj-license-core": fail()
            continue
        if source != "registry+https://github.com/rust-lang/crates.io-index": fail()
        name, version, digest = package.get("name"), package.get("version"), package.get("checksum")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", name): fail()
        if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version): fail()
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest): fail()
        key = f"{name}-{version}.crate"
        if key in expected: fail()
        expected[key] = digest
    if not expected: fail()
    return hashlib.sha256(raw).hexdigest(), expected

def registry_files(root, expected):
    output, crates, total = {}, set(), 0
    registry = root / "registry"
    if root.is_symlink() or registry.is_symlink(): fail()
    for kind in ["cache", "index"]:
        base = registry / kind
        if not base.is_dir() or base.is_symlink(): fail()
        for location, directories, files in os.walk(base, followlinks=False):
            for name in directories:
                if (Path(location) / name).is_symlink(): fail()
            for name in files:
                path = Path(location) / name
                relative = path.relative_to(root)
                pieces = relative.parts
                if len(pieces) < 4 or not re.fullmatch(r"index\.crates\.io-[A-Za-z0-9]+", pieces[2]): fail()
                content = regular_bytes(path)
                total += len(content)
                if total > LIMIT or len(output) >= 10000: fail()
                if kind == "cache":
                    if len(pieces) != 4 or name not in expected or hashlib.sha256(content).hexdigest() != expected[name]: fail()
                    crates.add(name)
                elif name == "config.json":
                    cfg = json.loads(content)
                    if cfg.get("dl") != "https://static.crates.io/crates" or cfg.get("api") != "https://crates.io" or cfg.get("auth-required", False) is not False: fail()
                output[str(relative)] = content
    if crates != set(expected): fail()
    return output

def seal(source, lock, destination):
    digest, expected = locked_crates(lock)
    files = registry_files(source, expected)
    if destination.exists() or destination.is_symlink(): fail()
    destination.mkdir(mode=0o755)
    hashes = {}
    for name, content in files.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(0o444)
        hashes[name] = hashlib.sha256(content).hexdigest()
    manifest = {"schema": 1, "lock_sha256": digest, "files": hashes}
    (destination / "manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
    (destination / "manifest.json").chmod(0o444)

def trusted_parents(root):
    path = root
    while True:
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: fail()
        if path == Path("/"): break
        path = path.parent

def verify(root, lock):
    trusted_parents(root)
    digest, expected = locked_crates(lock)
    manifest = json.loads(regular_bytes(root / "manifest.json"))
    if manifest.get("schema") != 1 or manifest.get("lock_sha256") != digest: fail()
    files = registry_files(root, expected)
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    if manifest.get("files") != hashes: fail()
    # Published caches must be root-owned and immutable to unprivileged workers.
    for location, dirs, files in os.walk(root, followlinks=False):
        for name in [".", *dirs, *files]:
            info = os.lstat(Path(location) / name)
            if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode): fail()
    return digest

# These Linux SONAME aliases are produced by checksum-pinned PostgreSQL17.10
# src/Makefile.shlib and each library's SO_MAJOR_VERSION/MAJORVERSION values.
PG_LIBRARY_LINKS = {}
for library, major in [("pq", "5"), ("ecpg", "6"), ("ecpg_compat", "3"), ("pgtypes", "3")]:
    for alias in [f"lib{library}.so", f"lib{library}.so.{major}"]:
        PG_LIBRARY_LINKS[f"lib/{alias}"] = f"lib{library}.so.{major}.17"

def output_tree(root, postgres=False, require_root=False):
    if root.is_symlink() or not root.is_dir() or not any(root.iterdir()): fail()
    for location, dirs, files in os.walk(root, followlinks=False):
        for name in [".", *dirs, *files]:
            path = Path(location) / name
            info = os.lstat(path)
            if require_root and info.st_uid != 0: fail()
            if stat.S_ISLNK(info.st_mode):
                target = PG_LIBRARY_LINKS.get(str(path.relative_to(root))) if postgres else None
                if target is None or os.readlink(path) != target or info.st_nlink != 1: fail()
                linked = os.lstat(path.parent / target)
                if not stat.S_ISREG(linked.st_mode) or linked.st_nlink != 1 or linked.st_mode & 0o6022 or (require_root and linked.st_uid != 0): fail()
                continue
            if info.st_mode & 0o6022 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)): fail()

def runtime(root):
    trusted_parents(root)
    if regular_bytes(root / "vendor-version") != b"rust1.90.0-pg17.10-v1\n": fail()
    for name in ["rust/bin/cargo", "rust/bin/rustc", "rust/bin/rustfmt", "postgres/bin/postgres", "postgres/bin/initdb", "postgres/bin/pg_ctl", "postgres/bin/psql"]:
        path = root / name
        if not path.is_file() or not os.access(path, os.X_OK): fail()
    output_tree(root / "rust", require_root=True)
    output_tree(root / "postgres", postgres=True, require_root=True)
    for path in [root, root / "vendor-version"]:
        info = os.lstat(path)
        if info.st_uid != 0 or info.st_mode & 0o6022 or stat.S_ISLNK(info.st_mode): fail()

if __name__ == "__main__":
    try:
        if len(sys.argv) == 5 and sys.argv[1] == "seal":
            seal(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        elif len(sys.argv) == 4 and sys.argv[1] == "verify":
            verify(Path(sys.argv[2]), Path(sys.argv[3]))
        elif len(sys.argv) == 4 and sys.argv[1] == "outputs":
            output_tree(Path(sys.argv[2]))
            output_tree(Path(sys.argv[3]), postgres=True)
        elif len(sys.argv) == 3 and sys.argv[1] == "lock":
            locked_crates(Path(sys.argv[2]))
        elif len(sys.argv) == 3 and sys.argv[1] == "runtime":
            runtime(Path(sys.argv[2]))
        else:
            fail()
        print("CI_PREREQUISITE_CACHE_VALID")
    except Exception:
        print("CI_PREREQUISITE_CACHE_INVALID", file=sys.stderr)
        raise SystemExit(3)
