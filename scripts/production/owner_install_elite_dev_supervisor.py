#!/usr/bin/env python3
"""Elite-only, fail-closed owner installer for the dedicated read-only dev Supervisor.

Dry-run by default. The only apply mode requires a reviewed, owner-signed
stable release already present in the immutable updater store. The script
verifies its OWN signed source bytes before running any imported installer code.
It NEVER restarts the enrolled dev agent or edits its credentials/config.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import socket
import stat
import subprocess
import sys
import tarfile

REV = re.compile(r"[a-f0-9]{40}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
PRODUCT = "KMJ CodeBridge"
KEY_ID = "kmj-release-2026"
PIN = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
PUBLIC = "https://kmjtechno.com/codebridge/releases/stable"
STATIC = Path("/var/lib/kmj-codebridge-releases/stable")
RELEASES = Path("/opt/kmj-codebridge-stable/releases")
CURRENT = Path("/opt/kmj-codebridge-stable/current")
TRUST = Path("/etc/kmj-codebridge-update/stable-update.json")
NODE = Path("/opt/kmj-codebridge-node/bin/node")
AGENT_UNIT = "kmj-codebridge-dev.service"
AGENT_CONFIG = Path("/etc/kmj-codebridge-dev/agent.json")
SOCKET = Path("/run/kmj-codebridge-dev/supervisor.sock")
SOCKET_UNIT = "kmj-codebridge-dev-supervisor.socket"
SERVICE_UNIT = "kmj-codebridge-dev-supervisor.service"
UNIT_DIR = Path("/etc/systemd/system")
RENDERER = "scripts/production/render-elite-dev-supervisor-units.py"
THIS_FILE = "scripts/production/owner_install_elite_dev_supervisor.py"
CONFIRM = "--confirm-elite-dev-signed-supervisor-owner-go"


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def manifest_identity(raw, revision):
    """Pure shape check; the signature is verified separately before use."""
    need(type(revision) is str and REV.fullmatch(revision) is not None,
         "EXACT_SOURCE_SHA_REQUIRED")
    try:
        d = json.loads(raw)
    except (TypeError, ValueError):
        raise Blocked("MANIFEST_INVALID") from None
    need(type(d) is dict and d.get("schema") == 1
         and d.get("product") == PRODUCT and d.get("channel") == "stable"
         and d.get("keyId") == KEY_ID and d.get("revision") == revision
         and type(d.get("version")) is str
         and VERSION.fullmatch(d["version"]) is not None
         and type(d.get("sha256")) is str
         and HASH.fullmatch(d["sha256"]) is not None
         and type(d.get("bytes")) is int
         and 1024 <= d["bytes"] <= 300_000_000
         and type(d.get("sequence")) is int
         and 1 <= d["sequence"] <= 99999,
         "SIGNED_MANIFEST_IDENTITY_INVALID")
    stem = f"kmj-codebridge-{d['version']}-{revision[:12]}"
    archive = f"{stem}.tar.gz"
    need(d.get("archive") == f"{PUBLIC}/{revision}/{archive}",
         "SIGNED_ARCHIVE_URL_INVALID")
    return d, stem, archive


def root_parents(path):
    for p in reversed(path.parents):
        s = os.lstat(p)
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0
             and not (s.st_mode & 0o022), "ROOT_PARENT_UNTRUSTED")


def root_file(path, limit=65536, private=False, allow_empty=False):
    root_parents(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0
             and (s.st_size > 0 or allow_empty) and s.st_size <= limit
             and (s.st_mode & (0o077 if private else 0o022)) == 0,
             "SIGNED_FILE_UNTRUSTED")
        data = b""
        while len(data) < s.st_size:
            part = os.read(fd, s.st_size - len(data))
            need(bool(part), "SIGNED_FILE_SHORT_READ")
            data += part
        t = os.fstat(fd)
        need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
             == (t.st_dev, t.st_ino, t.st_size, t.st_mtime_ns, t.st_ctime_ns),
             "SIGNED_FILE_RACED")
        return data
    finally:
        os.close(fd)


def run(argv, timeout=20, input_bytes=None):
    try:
        p = subprocess.run(argv, input=input_bytes, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                           check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("OWNER_COMMAND_UNAVAILABLE") from None
    need(p.returncode == 0 and len(p.stdout) <= 8192, "OWNER_COMMAND_FAILED")
    return p.stdout.decode("utf-8", "replace").strip()


def verify_signature(raw, signature):
    try:
        trust = json.loads(root_file(TRUST, 65536, private=True))
        key = trust["trustedKeys"][KEY_ID]
    except (ValueError, TypeError, KeyError):
        raise Blocked("TRUST_CONFIG_INVALID") from None
    need(type(key) is str and 32 <= len(key) <= 8192,
         "TRUST_KEY_MISSING")
    node = NODE.resolve(strict=True)
    need(str(node).startswith("/opt/kmj-codebridge-node/")
         or str(node) in ("/usr/bin/node", "/usr/bin/nodejs"),
         "NODE_TARGET_UNTRUSTED")
    root_parents(node)
    s = os.stat(node)
    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0
         and (s.st_mode & 0o022) == 0 and os.access(node, os.X_OK),
         "NODE_BINARY_UNTRUSTED")
    js = r"""
const c=require('node:crypto'),fs=require('node:fs'),x=JSON.parse(fs.readFileSync(0,'utf8'));
const k=c.createPublicKey(x.key);
const fingerprint=c.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex');
const sig=Buffer.from(x.sig.trim(),'base64url');
if(k.asymmetricKeyType!=='ed25519'||fingerprint!==x.pin||sig.length!==64||
!c.verify(null,Buffer.from(x.manifest,'base64'),k,sig))process.exit(2);
"""
    payload = json.dumps({
        "key": key, "pin": PIN,
        "manifest": base64.b64encode(raw).decode("ascii"),
        "sig": signature.decode("ascii"),
    }).encode("utf-8")
    run([str(node), "-e", js], timeout=30, input_bytes=payload)


def verify_archive_tree(source, archive_bytes, stem):
    """Compare every signed Git archive entry against the immutable installed files.

    The separate updater may install extra node_modules, but no signed source
    file may be omitted or changed. All tree members must be root controlled.
    """
    need(source.is_dir() and not source.is_symlink(), "IMMUTABLE_RUNTIME_MISSING")
    root_parents(source)
    parent = os.lstat(source)
    need(parent.st_uid == 0 and not (parent.st_mode & 0o022),
         "IMMUTABLE_RUNTIME_OWNER_UNTRUSTED")
    files_seen = set()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        for member in archive:
            need(member.name.startswith(stem + "/"),
                 "ARCHIVE_PREFIX_UNEXPECTED")
            relative = member.name[len(stem) + 1:]
            if not relative:
                continue
            parts = PurePosixPath(relative).parts
            need(parts and all(p not in (".", "..") for p in parts)
                 and not relative.startswith("/"),
                 "ARCHIVE_TRAVERSAL")
            target = source.joinpath(*parts)
            need(target.resolve(strict=True).is_relative_to(source),
                 "ARCHIVE_TARGET_ESCAPES")
            if member.isdir():
                need(target.is_dir() and not target.is_symlink(),
                     "SIGNED_DIRECTORY_MISSING")
            else:
                need(member.isfile() and target.is_file()
                     and not target.is_symlink() and relative not in files_seen,
                     "ARCHIVE_TYPE_UNEXPECTED")
                files_seen.add(relative)
                need(member.size <= 100_000_000,
                     "SIGNED_MEMBER_TOO_LARGE")
                stream = archive.extractfile(member)
                need(stream is not None, "SIGNED_MEMBER_UNREADABLE")
                digest = hashlib.sha256()
                while True:
                    part = stream.read(65536)
                    if not part:
                        break
                    digest.update(part)
                need(hashlib.sha256(root_file(target, 100_000_000, allow_empty=True)).digest()
                     == digest.digest(), "IMMUTABLE_SOURCE_BYTES_MISMATCH")
    need(THIS_FILE in files_seen and RENDERER in files_seen
         and "src/cli.js" in files_seen
         and "src/supervisor.js" in files_seen,
         "SIGNED_INSTALLER_FILES_MISSING")
    count = 0
    for directory, children, files in os.walk(source, followlinks=False):
        for name in children + files:
            count += 1
            need(count <= 250000, "RUNTIME_TREE_TOO_LARGE")
            path = Path(directory) / name
            item = os.lstat(path)
            need(item.st_uid == 0 and not (item.st_mode & 0o022),
                 "RUNTIME_WRITABLE_BY_AGENT")
            if stat.S_ISLNK(item.st_mode):
                need(path.resolve(strict=True).is_relative_to(source),
                     "RUNTIME_SYMLINK_ESCAPE")
            else:
                need(stat.S_ISREG(item.st_mode) or stat.S_ISDIR(item.st_mode),
                     "RUNTIME_SPECIAL_FILE")
    need((source / "node_modules").is_dir(), "RUNTIME_DEPENDENCIES_MISSING")


def signed_source(revision):
    need(REV.fullmatch(revision) is not None,
         "EXACT_SOURCE_SHA_REQUIRED")
    location = STATIC / revision
    manifest = root_file(location / "release-manifest.json", 65536)
    signature = root_file(location / "release-manifest.sig", 4096)
    d, stem, archive_name = manifest_identity(manifest, revision)
    verify_signature(manifest, signature)
    archive = root_file(location / archive_name, 300_000_000)
    need(len(archive) == d["bytes"]
         and hashlib.sha256(archive).hexdigest() == d["sha256"],
         "SIGNED_ARCHIVE_DIGEST_MISMATCH")
    source = RELEASES / f"{d['version']}-{revision[:12]}"
    verify_archive_tree(source, archive, stem)
    need(CURRENT.is_symlink() and CURRENT.resolve(strict=True) == source,
         "SIGNED_RELEASE_NOT_CURRENT")
    need(Path(__file__).absolute() == source / THIS_FILE,
         "OWNER_INSTALLER_MUST_RUN_FROM_SIGNED_RELEASE")
    return source, d["version"]


def verify_enrollment():
    uid = pwd.getpwnam("kmjdev")
    need(uid.pw_uid != 0, "DEV_PRINCIPAL_INVALID")
    props = run(["/usr/bin/systemctl", "show", AGENT_UNIT,
                 "-p", "LoadState", "-p", "ActiveState",
                 "-p", "User", "-p", "Group"])
    fields = dict(line.split("=", 1) for line in props.splitlines()
                  if line.count("=") == 1)
    need(fields.get("LoadState") == "loaded"
         and fields.get("ActiveState") == "active"
         and fields.get("User") == "kmjdev"
         and fields.get("Group") == "kmjdev",
         "DEV_AGENT_SERVICE_IDENTITY_MISMATCH")
    fd = os.open(AGENT_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        statbuf = os.fstat(fd)
        need(stat.S_ISREG(statbuf.st_mode) and statbuf.st_uid == uid.pw_uid
             and (statbuf.st_mode & 0o077) == 0
             and 0 < statbuf.st_size < 65536,
             "DEV_ENROLLMENT_FILE_UNTRUSTED")
        d = json.loads(os.read(fd, 65536))
    finally:
        os.close(fd)
    need(type(d) is dict
         and type(d.get("projects")) is list
         and len(d["projects"]) == 1
         and d["projects"][0].get("id") == "kmj-codebridge"
         and d.get("supervisorSocket") in (None, str(SOCKET)),
         "DEV_ENROLLMENT_SCOPE_MISMATCH")
    need(not os.path.lexists(SOCKET), "DEV_SOCKET_ALREADY_EXISTS")
    for u in (SERVICE_UNIT, SOCKET_UNIT):
        need(not os.path.lexists(UNIT_DIR / u),
             "DEV_SUPERVISOR_UNIT_ALREADY_EXISTS")
        need(run(["/usr/bin/systemctl", "show", u, "-p", "LoadState", "--value"])
             == "not-found", "DEV_SUPERVISOR_UNIT_COLLISION")


def unit_texts(source, revision, version):
    file = source / RENDERER
    spec = importlib.util.spec_from_file_location("_kmj_approved_renderer", file)
    need(spec is not None and spec.loader is not None, "RENDERER_NOT_FOUND")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    result = mod.render_units(revision, str(NODE), version)
    need(set(result) == {SERVICE_UNIT, SOCKET_UNIT}, "UNITS_UNEXPECTED")
    need(str(source) in result[SERVICE_UNIT], "RELEASE_PATH_MISMATCH")
    return result


def write_exclusive(path, data):
    root_parents(path)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
                 | os.O_CLOEXEC, 0o644)
    try:
        os.fchmod(fd, 0o644)
        pos = 0
        while pos < len(data):
            n = os.write(fd, data[pos:])
            need(n > 0, "UNIT_SHORT_WRITE")
            pos += n
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(path)  # we alone created this exact O_EXCL leaf
        raise
    else:
        os.close(fd)


def private_socket_probe():
    js = r"""
const n=require('node:net'),p='/run/kmj-codebridge-dev/supervisor.sock';
const cases=[{op:'status',service:'agent'},{op:'restart',service:'agent'},
{op:'status',service:'gateway'}];
async function one(x){return new Promise((resolve,reject)=>{
const s=n.createConnection(p);let b='';
s.setTimeout(3000,()=>s.destroy(Error('timeout')));
s.on('connect',()=>s.write(JSON.stringify(x)+'\n'));
s.on('data',c=>{b+=c;if(b.includes('\n')){s.end();try{resolve(JSON.parse(b.split('\n')[0]))}catch(e){reject(e)}}});
s.on('error',reject);s.on('end',()=>{if(!b.includes('\n'))reject(Error('eof'))});
})}
const r=[];for(const x of cases)r.push(await one(x));
if(!r[0]?.ok||r[1]?.ok!==false||r[2]?.ok!==false)process.exit(2);
process.stdout.write('PRIVATE_READ_ONLY_RPC_PASS\n');
"""
    output = run(["/usr/sbin/runuser", "-u", "kmjdev", "--",
                  str(NODE), "-e", js], timeout=20)
    need(output == "PRIVATE_READ_ONLY_RPC_PASS",
         "PRIVATE_IPC_AUTH_PROBE_FAILED")


def rollback(created, activation_attempted):
    # Only remove files this exact invocation created. Never touch other units.
    if activation_attempted:
        try:
            run(["/usr/bin/systemctl", "disable", "--now", SOCKET_UNIT])
        except Blocked:
            print("DEV_SUPERVISOR_ROLLBACK=FAILED_MANUAL_RECOVERY")
            raise  # preserve unit files for operator recovery
    for path in reversed(created):
        if os.path.lexists(path):
            os.unlink(path)
    run(["/usr/bin/systemctl", "daemon-reload"])
    need(not any(os.path.lexists(p) for p in created),
         "ROLLBACK_FILES_REMAIN")
    print("DEV_SUPERVISOR_ROLLBACK=REMOVED_OWN_FILES")


def main(argv):
    need(type(argv) is list
         and (len(argv) == 2 and argv[0] == "--revision"
              or len(argv) == 4 and argv[0] == "--revision"
              and argv[2:] == ["--apply", CONFIRM]), "ARGUMENTS_REJECTED")
    revision = argv[1]
    apply = len(argv) == 4
    need(os.geteuid() == 0
         and socket.gethostname().split(".")[0].lower() == "kmj-elite",
         "ELITE_ROOT_REQUIRED")
    source, version = signed_source(revision)
    verify_enrollment()
    spec = unit_texts(source, revision, version)
    print("OWNER_SIGNED_RELEASE_AND_DEV_SCOPE=PASS")
    if not apply:
        print("DEV_SUPERVISOR_INSTALL=DRY_RUN_NO_CHANGES")
        return 0
    created = []
    activation_attempted = False
    try:
        for name in (SERVICE_UNIT, SOCKET_UNIT):
            path = UNIT_DIR / name
            write_exclusive(path, spec[name].encode("utf-8"))
            created.append(path)
        run(["/usr/bin/systemd-analyze", "verify",
             str(UNIT_DIR / SERVICE_UNIT), str(UNIT_DIR / SOCKET_UNIT)])
        run(["/usr/bin/systemctl", "daemon-reload"])
        activation_attempted = True
        run(["/usr/bin/systemctl", "enable", "--now", SOCKET_UNIT])
        need(run(["/usr/bin/systemctl", "is-active", SOCKET_UNIT]) == "active",
             "SOCKET_UNIT_INACTIVE")
        s = os.lstat(SOCKET)
        need(stat.S_ISSOCK(s.st_mode) and s.st_uid == pwd.getpwnam("kmjdev").pw_uid
             and stat.S_IMODE(s.st_mode) == 0o600,
             "DEV_SOCKET_ACL_MISMATCH")
        private_socket_probe()
        print("DEV_PRIVATE_SOCKET=READ_ONLY_RPC_PASS")
        print("DEV_SUPERVISOR_INSTALL=PASS_AGENT_BINDING_NOT_ATTEMPTED")
        print("DEV_AGENT_RESTART=NOT_ATTEMPTED")
        return 0
    except BaseException:
        if created:
            rollback(created, activation_attempted)
        raise


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Blocked, OSError, KeyError, ValueError, TypeError, tarfile.TarError):
        print("DEV_SUPERVISOR_INSTALL=BLOCKED_NO_LIVE_CREDIT")
        sys.exit(2)
