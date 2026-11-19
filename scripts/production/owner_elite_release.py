#!/usr/bin/env python3
"""KMJ-elite owner-root, sequence-agnostic signed stable release.

One command replaces the per-sequence publish, feed and gateway scripts:

    python3 -I owner_elite_release.py <40-hex revision> \
        --manifest-sha256 <64-hex from your own Get-FileHash> \
        [--step publish|feed|cutover|all] [--apply --confirm-no-active-jobs]

Dry-run is the default and writes nothing. Nothing is pinned per release:
every value (sequence, version, archive, hashes) is read from the owner-signed
manifest, whose Ed25519 signature is verified against the root-owned trust file
AND the pinned owner SPKI. The owner's --manifest-sha256 is the release
approval: it must equal the bytes of the signed manifest on main.

Steps (each idempotent, stops at the first failure):
  publish  immutable stable/<rev>/ on the static origin (never overwrites)
  feed     delegates to the pinned signed-latest-feed roller
  cutover  waits for the signed updater to install the runtime, then switches
           the gateway with a new root-owned override and rolls back on any
           failure. The new catalog must be a superset of the live catalog.

Never touches keys, the updater, the agent, Nginx, source repositories or an
existing override. No arbitrary paths, URLs or shell from arguments.
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

OWNER_REPO = "kmjtechno/kmj-codebridge"
RAW = f"https://raw.githubusercontent.com/{OWNER_REPO}/main/releases/stable"
PUBLIC = "https://kmjtechno.com/codebridge/releases/stable"
PUBLIC_HOST = "kmjtechno.com"
STATIC_ROOT = pathlib.Path("/var/lib/kmj-codebridge-releases/stable")
CFG = "/etc/kmj-codebridge-update/stable-update.json"
NODE = "/opt/kmj-codebridge-node/bin/node"
KEY_ID = "kmj-release-2026"
SPKI_PIN = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
MAX_ARCHIVE = 300_000_000
RELEASES = pathlib.Path("/opt/kmj-codebridge-stable/releases")
STABLE_CURRENT = pathlib.Path("/opt/kmj-codebridge-stable/current")
UNIT = "kmj-codebridge-gateway-stage.service"
UNIT_PATH = pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service")
DIR = pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service.d")
COMMIT_CONF = DIR / "zzzzz-kmj-source-commit.conf"
COMMIT_CONF_SHA = "a6765def2981eec965e3de72bf3ad20824b3f466ea99d1e99c4119cebdb54123"
LOCK = pathlib.Path("/run/lock/kmj-codebridge-gateway-release.lock")
ROLLER = "owner_roll_signed_latest_feed_20261115.py"
ROLLER_SHA256 = "3e0613f8826589c6b718e97cd227899f0fbc65cb97cd0a5aa5afe5de727aa509"
ROLLER_CONFIRM = "--confirm-owner-signed-rolling-feed"
UPDATER_WAIT_SECONDS = 900
CONF_RE = re.compile(r"^(z+)-kmj-signed([0-9]{1,4})\.conf$")
REV_RE = re.compile(r"^[0-9a-f]{40}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")
CRITICAL = {
    "chat_workspace_open": ("device", "project", "lane", "ifNoneMatch", "maxEntries", "recentJobs"),
    "coordination_list": ("device", "project", "limit", "after"),
    "coordination_post": ("device", "project", "actor", "recipient", "requestKey", "kind", "note"),
    "autopilot_claim": ("device", "project"),
    "autopilot_checkpoint": ("device", "project", "task", "leaseToken"),
    "autopilot_wait": ("device", "project", "task", "leaseToken"),
    "autopilot_complete": ("device", "project", "task", "leaseToken"),
}


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


# ---------------------------------------------------------------- pure helpers
def parse_args(argv):
    """Strict, closed argument grammar. Returns a dict."""
    need(len(argv) >= 3, "INVALID_ARGS")
    rev = argv[0]
    need(REV_RE.fullmatch(rev) is not None, "INVALID_REVISION")
    need(argv[1] == "--manifest-sha256" and HEX64_RE.fullmatch(argv[2]) is not None,
         "MANIFEST_SHA256_REQUIRED")
    out = {"rev": rev, "manifest_sha256": argv[2], "step": "all", "apply": False}
    rest = list(argv[3:])
    if rest[:1] == ["--step"]:
        need(len(rest) >= 2 and rest[1] in ("publish", "feed", "cutover", "all"),
             "INVALID_STEP")
        out["step"] = rest[1]
        rest = rest[2:]
    if rest:
        need(rest == ["--apply", "--confirm-no-active-jobs"], "INVALID_ARGS")
        out["apply"] = True
    return out


def parse_manifest(raw, rev):
    """Identity of an owner-signed manifest; signature is verified elsewhere."""
    try:
        info = json.loads(raw)
    except ValueError:
        raise Blocked("MANIFEST_NOT_JSON") from None
    need(isinstance(info, dict) and len(raw) <= 4096, "MANIFEST_SHAPE_INVALID")
    version = info.get("version")
    sequence = info.get("sequence")
    sha256 = info.get("sha256")
    size = info.get("bytes")
    need(info.get("channel") == "stable" and info.get("keyId") == KEY_ID
         and info.get("revision") == rev
         and info.get("product") == "KMJ CodeBridge"
         and isinstance(version, str) and VERSION_RE.fullmatch(version) is not None
         and type(sequence) is int and 1 <= sequence <= 99999
         and isinstance(sha256, str) and HEX64_RE.fullmatch(sha256) is not None
         and type(size) is int and 1 <= size <= MAX_ARCHIVE,
         "SIGNED_RELEASE_IDENTITY_MISMATCH")
    archive = f"kmj-codebridge-{version}-{rev[:12]}.tar.gz"
    need(info.get("archive") == f"{PUBLIC}/{rev}/{archive}",
         "SIGNED_RELEASE_IDENTITY_MISMATCH")
    return {"sequence": sequence, "version": version, "sha256": sha256,
            "bytes": size, "archive": archive,
            "github": f"https://github.com/{OWNER_REPO}/releases/download/"
                      f"codebridge-stable-seq{sequence}-{rev[:8]}/{archive}",
            "runtime_dir": RELEASES / f"{version}-{rev[:12]}"}


def newest_conf(names):
    """The live signed override: highest sequence; ties are ambiguous."""
    found = []
    for name in names:
        m = CONF_RE.fullmatch(name)
        if m:
            found.append((int(m.group(2)), len(m.group(1)), name))
    need(found, "NO_SIGNED_OVERRIDE_FOUND")
    found.sort()
    need(len(found) == 1 or found[-1][0] != found[-2][0], "AMBIGUOUS_SIGNED_OVERRIDE")
    return found[-1]


def next_conf_name(old_z, sequence):
    """Always sorts after every earlier override (systemd applies in name order)."""
    return "z" * (old_z + 1) + f"-kmj-signed{sequence}.conf"


def override_content(directory, sha, node, config):
    return ("[Service]\n"
            f"WorkingDirectory={directory}\n"
            f"Environment=CODEBRIDGE_SOURCE_COMMIT={sha}\n"
            "ExecStart=\n"
            f"ExecStart={node} {directory}/src/cli.js gateway {config}\n").encode()


def parse_override(text):
    """Extract (runtime dir, commit, gateway config) from a signed override."""
    wds = re.findall(r"^WorkingDirectory=(.+)$", text, re.M)
    shas = re.findall(r"^Environment=CODEBRIDGE_SOURCE_COMMIT=([0-9a-f]{40})$", text, re.M)
    execs = re.findall(r"^ExecStart=(.*)$", text, re.M)
    need(len(wds) == 1 and len(shas) == 1 and len(execs) == 2 and execs[0] == "",
         "SIGNED_OVERRIDE_DIRECTIVES_UNEXPECTED")
    m = re.fullmatch(r"/opt/kmj-codebridge-node/bin/node (/[A-Za-z0-9_./-]+)/src/cli\.js"
                     r" gateway (/[A-Za-z0-9_./-]+)", execs[1])
    need(m is not None and m.group(1) == wds[0], "SIGNED_OVERRIDE_EXEC_UNEXPECTED")
    directory = pathlib.PurePosixPath(wds[0])
    need(directory.parent == pathlib.PurePosixPath(RELEASES)
         and re.fullmatch(r"[0-9.]+-" + shas[0][:12], directory.name) is not None,
         "SIGNED_OVERRIDE_RUNTIME_UNEXPECTED")
    # Exact template only: any extra directive (ExecStartPre, Environment, ...) fails.
    need(text.encode() == override_content(wds[0], shas[0], NODE, m.group(2)),
         "SIGNED_OVERRIDE_EXTRA_DIRECTIVES")
    return pathlib.Path(wds[0]), shas[0], m.group(2)


def tools_superset(baseline_names, new_names):
    """The new gateway must keep every tool the live one exposes."""
    need(set(baseline_names) <= set(new_names), "REQUIRED_TOOLS_MISSING")


# ------------------------------------------------------------- trusted helpers
def cmd(*argv, input=None, timeout=25):
    try:
        p = subprocess.run(argv, input=input, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    need(p.returncode == 0, "COMMAND_FAILED")
    need(len(p.stdout) <= 2 * 1024 * 1024, "COMMAND_OUTPUT_TOO_LARGE")
    return p.stdout.decode("utf-8", "replace").strip()


def fetch(url, path):
    result = subprocess.run(
        ["curl", "-fLSs", "--retry", "2", "--max-time", "120",
         "--proto", "=https", "--proto-redir", "=https", url, "-o", str(path)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=135)
    need(result.returncode == 0, "HTTPS_DOWNLOAD_FAILED")
    return path.read_bytes()


def regular_owner_file(path, private=True, max_size=65536):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
                 and 1 <= st.st_size <= max_size
                 and (st.st_mode & (0o077 if private else 0o022)) == 0,
                 "UNTRUSTED_OWNER_FILE")
            data = os.read(fd, max_size + 1)
            need(len(data) == st.st_size, "OWNER_FILE_RACE")
            return data
        finally:
            os.close(fd)
    except (OSError, ValueError):
        raise Blocked("OWNER_FILE_UNAVAILABLE") from None


def require_root_parent(path):
    for ancestor in [pathlib.Path("/"), *reversed(path.parent.parents), path.parent]:
        try:
            st = os.lstat(ancestor)
        except OSError:
            raise Blocked("OWNER_PARENT_MISSING") from None
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and (st.st_mode & 0o022) == 0,
             "OWNER_PARENT_UNTRUSTED")


def trust_key():
    obj = json.loads(regular_owner_file(CFG))
    need(obj.get("channel") == "stable" and KEY_ID in obj.get("trustedKeys", {}),
         "TRUSTED_STABLE_KEY_ABSENT")
    return obj["trustedKeys"][KEY_ID]


def verify_signing(manifest, signature, key):
    js = """
const fs=require('node:fs'),c=require('node:crypto'),x=JSON.parse(fs.readFileSync(0,'utf8'));
const k=c.createPublicKey(x.key);
const fp=c.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex');
const valid=k.asymmetricKeyType==='ed25519' && fp===x.pin &&
c.verify(null,Buffer.from(x.manifest,'base64'),k,Buffer.from(x.signature,'base64url'));
if(!valid)process.exit(2);
"""
    payload = json.dumps({"key": key, "pin": SPKI_PIN,
                          "manifest": base64.b64encode(manifest).decode(),
                          "signature": signature.decode().strip()})
    p = subprocess.run([NODE, "-e", js], input=payload, text=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    need(p.returncode == 0, "ELITE_ED25519_TRUST_FAILED")


def signed_release(rev, approved_sha256, key, tmp):
    """Fetch + approve + verify the signed pair, then the archive bytes."""
    manifest = fetch(f"{RAW}/{rev}/release-manifest.json", tmp / "manifest")
    signature = fetch(f"{RAW}/{rev}/release-manifest.sig", tmp / "signature")
    need(hashlib.sha256(manifest).hexdigest() == approved_sha256,
         "OWNER_MANIFEST_HASH_MISMATCH")
    release = parse_manifest(manifest, rev)
    verify_signing(manifest, signature, key)
    archive = fetch(release["github"], tmp / "archive")
    need(len(archive) == release["bytes"]
         and hashlib.sha256(archive).hexdigest() == release["sha256"],
         "SIGNED_RELEASE_BYTES_INVALID")
    return release, {"release-manifest.json": manifest,
                     "release-manifest.sig": signature,
                     release["archive"]: archive}


# ------------------------------------------------------------------- publish
def previous_published(release, rev, key, tmp):
    """Highest already-published signed release, verified against the live origin."""
    for part in (STATIC_ROOT, STATIC_ROOT.parent):
        need(not part.is_symlink(), "STATIC_ORIGIN_DIR_UNTRUSTED")
    mode = STATIC_ROOT.stat().st_mode
    need(stat.S_ISDIR(mode) and not mode & 0o022, "STATIC_ORIGIN_DIR_UNTRUSTED")
    best = None
    for entry in sorted(STATIC_ROOT.iterdir()):
        if not REV_RE.fullmatch(entry.name) or entry.name == rev:
            continue
        if entry.is_symlink() or not entry.is_dir():
            continue
        manifest = entry / "release-manifest.json"
        signature = entry / "release-manifest.sig"
        if not (manifest.is_file() and not manifest.is_symlink()
                and signature.is_file() and not signature.is_symlink()):
            continue
        info = parse_manifest(manifest.read_bytes(), entry.name)
        verify_signing(manifest.read_bytes(), signature.read_bytes(), key)
        if best is None or info["sequence"] > best[0]["sequence"]:
            best = (info, entry)
    need(best is not None, "PUBLIC_BASELINE_UNEXPECTED")
    info, entry = best
    need(release["sequence"] > info["sequence"], "SEQUENCE_NOT_MONOTONIC")
    for i, name in enumerate(("release-manifest.json", "release-manifest.sig")):
        need((entry / name).read_bytes() == fetch(f"{PUBLIC}/{entry.name}/{name}",
                                                  tmp / f"prev-{i}"),
             "STATIC_ORIGIN_PATH_UNRESOLVED")
    return info, entry.name


def publish_immutable(rev, blobs):
    target = STATIC_ROOT / rev
    if target.exists() or target.is_symlink():
        need(target.is_dir() and not target.is_symlink(), "EXISTING_RELEASE_UNEXPECTED")
        for name, data in blobs.items():
            candidate = target / name
            need(candidate.is_file() and not candidate.is_symlink()
                 and candidate.read_bytes() == data, "EXISTING_RELEASE_UNEXPECTED")
        print("IMMUTABLE_FILES=ALREADY_MATCH")
        return
    os.mkdir(target, 0o755)
    os.chmod(target, 0o755)
    for name, data in blobs.items():
        fd = os.open(str(target / name),
                     os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, "wb", closefd=False) as out:
                out.write(data)
                out.flush()
                os.fchmod(fd, 0o644)
                os.fsync(fd)
        finally:
            os.close(fd)
    need(all((target / n).read_bytes() == v for n, v in blobs.items()),
         "PUBLISHED_FILE_BYTES_DIFFER")
    print("IMMUTABLE_FILES=CREATED")


def step_publish(args, key, tmp):
    release, blobs = signed_release(args["rev"], args["manifest_sha256"], key, tmp)
    print(f"SIGNED_RELEASE_SEQUENCE={release['sequence']}")
    print("SIGNATURE_AND_ARCHIVE=PASS")
    previous, previous_rev = previous_published(release, args["rev"], key, tmp)
    print(f"PREVIOUS_PUBLISHED_SEQUENCE={previous['sequence']}")
    print("STATIC_ORIGIN_MAPPING=PASS")
    if not args["apply"]:
        print("PUBLISH=DRY_RUN_UNCHANGED")
        return release
    publish_immutable(args["rev"], blobs)
    for i, (name, data) in enumerate(blobs.items()):
        need(fetch(f"{PUBLIC}/{args['rev']}/{name}", tmp / f"public-{i}") == data,
             "PUBLIC_HTTPS_MISMATCH")
    print("PUBLIC_ORIGIN=PASS")
    return release


# ---------------------------------------------------------------------- feed
def step_feed(args):
    roller = pathlib.Path(__file__).resolve().parent / ROLLER
    need(roller.is_file() and not roller.is_symlink()
         and hashlib.sha256(roller.read_bytes()).hexdigest() == ROLLER_SHA256,
         "FEED_ROLLER_MISSING_OR_CHANGED")
    argv = ["--apply", ROLLER_CONFIRM] if args["apply"] else ["--inspect"]
    p = subprocess.run(["/usr/bin/python3", "-I", str(roller), *argv],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=600)
    out = p.stdout.decode("utf-8", "replace")
    for line in out.splitlines()[:40]:
        print("FEED: " + line[:200])
    need(p.returncode == 0, "FEED_ROLLOVER_FAILED")
    print("FEED=" + ("APPLIED" if args["apply"] else "INSPECT_ONLY"))


# ------------------------------------------------------------------- cutover
def show(prop):
    return cmd("systemctl", "show", UNIT, "-P", prop, timeout=12)


def safe_gateway_config_bytes(file):
    import grp
    import pwd
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            uid = pwd.getpwnam("kmjcode").pw_uid
            need(stat.S_ISREG(st.st_mode) and st.st_uid in (0, uid)
                 and st.st_nlink == 1 and 1 <= st.st_size <= 262144
                 and (st.st_mode & 0o022) == 0, "GATEWAY_CONFIG_UNTRUSTED")
            gid = grp.getgrnam("kmjcode").gr_gid
            private_service = (st.st_mode & 0o077) == 0 and st.st_uid == uid
            root_group = (st.st_uid == 0 and st.st_gid == gid
                          and (st.st_mode & 0o137) == 0 and (st.st_mode & 0o040) != 0)
            need(private_service or root_group, "GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER")
            data = os.read(fd, 262145)
            need(len(data) == st.st_size, "GATEWAY_CONFIG_RACE")
            return data
        finally:
            os.close(fd)
    except (OSError, KeyError):
        raise Blocked("GATEWAY_CONFIG_UNAVAILABLE") from None


def gateway_port(file):
    cfg = json.loads(safe_gateway_config_bytes(pathlib.Path(file)))
    port = cfg.get("port", 8787)
    host = cfg.get("host", "127.0.0.1")
    need(type(port) is int and 1 <= port <= 65535
         and host in ("127.0.0.1", "localhost", "0.0.0.0"), "GATEWAY_PORT_NOT_LOCAL")
    return port


def rpc_messages(text):
    candidates = [text.strip()]
    candidates += [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    result = []
    for item in candidates:
        try:
            result.append(json.loads(item))
        except (ValueError, TypeError):
            pass
    return result


def origin_probe(origin, port, baseline=None):
    if origin == "DIRECT":
        url = f"http://127.0.0.1:{port}/mcp"
        extra = []
    else:
        url = f"https://{PUBLIC_HOST}/mcp"
        extra = ["--resolve", f"{PUBLIC_HOST}:443:127.0.0.1"] if origin == "LOCAL_NGINX" else []

    def post(method, number, params):
        payload = json.dumps({"jsonrpc": "2.0", "id": number, "method": method,
                              "params": params}, separators=(",", ":")).encode()
        args = ["curl", "-fsS", "--max-time", "15", "--connect-timeout", "4",
                *extra, "-H", f"Host: {PUBLIC_HOST}",
                "-H", "Content-Type: application/json",
                "-H", "Accept: application/json, text/event-stream",
                "--data-binary", "@-", url]
        try:
            p = subprocess.run(args, input=payload, capture_output=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            raise Blocked(origin + "_PROBE_UNAVAILABLE") from None
        need(p.returncode == 0 and len(p.stdout) <= 1048576, origin + "_MCP_RESPONSE_UNVERIFIED")
        return rpc_messages(p.stdout.decode("utf-8", "replace"))

    catalog = post("tools/list", 1, {})
    tools = next((item["result"]["tools"] for item in catalog
                  if isinstance(item, dict) and isinstance(item.get("result"), dict)
                  and isinstance(item["result"].get("tools"), list)), None)
    need(tools is not None and len(tools) >= 100, origin + "_CATALOG_SMALL")
    names = [x.get("name") for x in tools if isinstance(x, dict)]
    need(len(names) == len(tools) and len(set(names)) == len(names), origin + "_CATALOG_INVALID")
    if baseline is not None:
        tools_superset(baseline, names)
    lookup = {x["name"]: x for x in tools}
    for tool, fields in CRITICAL.items():
        shape = lookup.get(tool, {}).get("inputSchema", {})
        props = shape.get("properties", {}) if isinstance(shape, dict) else {}
        need(type(props) is dict and all(field in props for field in fields),
             origin + "_CRITICAL_SCHEMA_MISSING")
    init = post("initialize", 2, {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "elite-release-verifier",
                                                 "version": "1.0.0"}})
    commit = next((item["result"]["serverInfo"].get("commit")
                   for item in init if isinstance(item, dict)
                   and isinstance(item.get("result"), dict)
                   and isinstance(item["result"].get("serverInfo"), dict)), None)
    return {"count": len(tools), "names": names, "commit": commit}


def write_new(path, data):
    require_root_parent(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    dirfd = os.open(DIR, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)


def remove_only_our_new(path, data):
    need(regular_owner_file(path, max_size=16384) == data, "NEW_DROPIN_CHANGED_REFUSE_DELETE")
    os.unlink(path)
    cmd("systemctl", "daemon-reload", timeout=40)


def wait_for_runtime(release, apply):
    target = release["runtime_dir"]
    deadline = time.monotonic() + (UPDATER_WAIT_SECONDS if apply else 0)
    announced = 0
    while True:
        ok = (STABLE_CURRENT.is_symlink()
              and STABLE_CURRENT.resolve(strict=False) == target
              and (target / "src/cli.js").is_file() and not (target / "src/cli.js").is_symlink())
        if ok:
            package = json.loads((target / "package.json").read_text("utf-8"))
            need(package.get("version") == release["version"], "RUNTIME_VERSION_MISMATCH")
            return True
        if time.monotonic() >= deadline:
            return False
        if time.monotonic() - announced > 60:
            print("WAITING_FOR_SIGNED_UPDATER_TO_INSTALL_RUNTIME")
            announced = time.monotonic()
        time.sleep(10)


def step_cutover(args, tmp):
    rev = args["rev"]
    key = trust_key()
    release, _ = signed_release(rev, args["manifest_sha256"], key, tmp)
    need(pathlib.Path(NODE).is_file() and os.access(NODE, os.X_OK), "NODE_UNAVAILABLE")
    require_root_parent(DIR / "x")
    seq_old, z_old, old_name = newest_conf(os.listdir(DIR))
    old_conf = DIR / old_name
    if seq_old == release["sequence"]:
        _, live_sha, _ = parse_override(regular_owner_file(old_conf, max_size=16384).decode("utf-8"))
        need(live_sha == rev, "OVERRIDE_SEQUENCE_CONFLICT")
        print("CUTOVER=ALREADY_LIVE_UNCHANGED")
        return
    need(release["sequence"] > seq_old, "SEQUENCE_NOT_MONOTONIC")
    new_conf = DIR / next_conf_name(z_old, release["sequence"])
    old_data = regular_owner_file(old_conf, max_size=16384)
    old_dir, old_sha, config = parse_override(old_data.decode("utf-8"))
    need(old_data == override_content(old_dir, old_sha, NODE, config), "OVERRIDE_DRIFT")
    need(old_sha != rev and old_dir != release["runtime_dir"], "ALREADY_ON_TARGET")
    new_dir = release["runtime_dir"]
    new_content = override_content(new_dir, rev, NODE, config)

    if not wait_for_runtime(release, args["apply"]):
        print("CUTOVER=WAITING_FOR_UPDATER_RUNTIME_NOT_INSTALLED")
        print("CUTOVER=DRY_RUN_UNCHANGED" if not args["apply"] else "CUTOVER=NOT_APPLIED")
        return

    need(show("LoadState") == "loaded" and show("FragmentPath") == str(UNIT_PATH),
         "UNEXPECTED_SYSTEMD_UNIT")
    need(show("ActiveState") == "active" and show("NeedDaemonReload") == "no", "GATEWAY_NOT_READY")
    need(show("User") == "kmjcode", "GATEWAY_USER_DRIFT")
    need(show("WorkingDirectory") == str(old_dir), "GATEWAY_OLD_RUNTIME_DRIFT")
    oldpid = int(show("MainPID"))
    need(oldpid > 1 and pathlib.Path(f"/proc/{oldpid}/cwd").resolve() == old_dir,
         "GATEWAY_OLD_PROCESS_DRIFT")
    paths = show("DropInPaths").split()
    need(len(paths) <= 30 and str(old_conf) in paths, "SIGNED_DROPIN_NOT_LOADED")
    need(str(COMMIT_CONF) in paths and hashlib.sha256(
        regular_owner_file(COMMIT_CONF, max_size=16384)).hexdigest() == COMMIT_CONF_SHA,
         "SOURCE_COMMIT_OVERRIDE_DRIFT")
    need(not os.path.lexists(new_conf), "NEW_DROPIN_ALREADY_EXISTS")
    need(all(pathlib.PurePosixPath(p).name < new_conf.name for p in paths),
         "LATER_SYSTEMD_OVERRIDE_CONFLICT")
    need(not os.path.lexists(LOCK), "GATEWAY_OWNER_LOCK_PRESENT")
    port = gateway_port(config)
    old = origin_probe("DIRECT", port)
    need(old["count"] >= 100, "GATEWAY_BASELINE_UNVERIFIED")
    print("GATEWAY_PREFLIGHT=PASS")
    print(f"BASELINE_TOOL_COUNT={old['count']}")
    if not args["apply"]:
        print("CUTOVER=DRY_RUN_UNCHANGED")
        return

    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    created = restarted = reconciled = False

    def on_interrupt(signum, frame):
        raise Blocked("INTERRUPTED")

    prior = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    for sig in prior:
        signal.signal(sig, on_interrupt)
    try:
        os.write(fd, str(os.getpid()).encode() + b"\n")
        os.fsync(fd)
        need(show("ActiveState") == "active" and show("WorkingDirectory") == str(old_dir)
             and int(show("MainPID")) == oldpid
             and regular_owner_file(old_conf, max_size=16384) == old_data
             and not os.path.lexists(new_conf), "GATEWAY_BASELINE_CHANGED")
        write_new(new_conf, new_content)
        created = True
        cmd("systemctl", "daemon-reload", timeout=40)
        need(show("NeedDaemonReload") == "no" and show("WorkingDirectory") == str(new_dir)
             and f"{new_dir}/src/cli.js" in show("ExecStart")
             and str(new_conf) in show("DropInPaths").split()
             and f"CODEBRIDGE_SOURCE_COMMIT={rev}" in show("Environment"),
             "SYSTEMD_NEW_NOT_EFFECTIVE")
        restarted = True
        cmd("systemctl", "restart", UNIT, timeout=90)
        need(int(show("MainPID")) != oldpid, "GATEWAY_PID_NOT_CHANGED")
        for attempt in range(6):
            try:
                need(show("ActiveState") == "active", "GATEWAY_RESTART_NOT_ACTIVE")
                pid = int(show("MainPID"))
                need(pid > 1 and pathlib.Path(f"/proc/{pid}/cwd").resolve() == new_dir,
                     "GATEWAY_NEW_PROCESS_WRONG_RUNTIME")
                for origin in ("DIRECT", "LOCAL_NGINX"):
                    seen = origin_probe(origin, port, baseline=old["names"])
                    need(seen["commit"] == rev, origin + "_RUNTIME_COMMIT_UNVERIFIED")
                    print(origin + "_CATALOG_AND_COMMIT=PASS")
                break
            except Blocked:
                if attempt == 5:
                    raise
                time.sleep(2)
        try:
            seen = origin_probe("PUBLIC", port, baseline=old["names"])
            print("PUBLIC_CATALOG_AND_COMMIT=" + ("PASS" if seen["commit"] == rev
                                                   else "MISMATCH_REVIEW"))
        except Blocked:
            print("PUBLIC_CATALOG_AND_COMMIT=NOT_VERIFIED_EDGE")
        reconciled = True
        print("GATEWAY_RELEASE=LIVE_PASS")
        print("AGENT_RECONNECT=REQUIRES_AUTHENTICATED_CLIENT")
    except BaseException as error:
        reason = error.args[0] if isinstance(error, Blocked) and error.args else "UNCLASSIFIED"
        print("GATEWAY_RELEASE=BLOCKED:" + str(reason))
        if created:
            try:
                remove_only_our_new(new_conf, new_content)
                if restarted:
                    cmd("systemctl", "restart", UNIT, timeout=90)
                need(show("ActiveState") == "active" and show("WorkingDirectory") == str(old_dir),
                     "ROLLBACK_SYSTEMD_NOT_OLD")
                pid = int(show("MainPID"))
                need(pid > 1 and pathlib.Path(f"/proc/{pid}/cwd").resolve() == old_dir,
                     "ROLLBACK_RUNTIME_NOT_OLD")
                origin_probe("DIRECT", port, baseline=old["names"])
                print("GATEWAY_ROLLBACK=PASS")
                reconciled = True
            except Exception:
                print("GATEWAY_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED")
        raise Blocked("CUTOVER_FAILED") from None
    finally:
        for sig, handler in prior.items():
            signal.signal(sig, handler)
        os.close(fd)
        if not created or reconciled:
            try:
                os.unlink(LOCK)
            except OSError:
                pass
        else:
            print("GATEWAY_OWNER_LOCK=RETAINED_AFTER_FAILED_ROLLBACK")


# ---------------------------------------------------------------------- main
def run(argv):
    args = parse_args(argv)
    need(getattr(os, "geteuid", lambda: 1)() == 0 and socket.gethostname().split(".")[0].lower() == "kmj-elite",
         "WRONG_ROOT_OR_HOST")
    need(os.path.isfile(NODE) and os.access(NODE, os.X_OK), "PINNED_NODE_MISSING")
    key = trust_key()
    print("MODE=" + ("APPLY" if args["apply"] else "DRY_RUN"))
    with tempfile.TemporaryDirectory(prefix="kmj-elite-release-", dir="/root") as directory:
        tmp = pathlib.Path(directory)
        if args["step"] in ("publish", "all"):
            step_publish(args, key, tmp)
        if args["step"] in ("feed", "all"):
            step_feed(args)
        if args["step"] in ("cutover", "all"):
            step_cutover(args, tmp)
    print("ELITE_RELEASE=" + ("DONE" if args["apply"] else "DRY_RUN_UNCHANGED"))


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except Blocked as error:
        print("ELITE_RELEASE=BLOCKED")
        print("REASON=" + (str(error.args[0]) if error.args else "UNCLASSIFIED"))
        sys.exit(2)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        print("ELITE_RELEASE=BLOCKED")
        print("REASON=UNCLASSIFIED")
        sys.exit(2)
