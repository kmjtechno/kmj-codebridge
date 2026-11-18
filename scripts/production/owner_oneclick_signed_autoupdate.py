#!/usr/bin/env python3
"""KMJ TECHNO owner one-click: opt in to the existing signed stable AUTO updater.

First installation requires an independently trusted, root-owned, reviewed
helper and an owner approval receipt. Once enabled, systemd handles checks.
This controls the EXISTING AGENT signed updater only: it does not grant
unreviewed gateway, root Supervisor, Main Platform or database deployments.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile

CONFIG = Path("/etc/kmj-codebridge-update/stable-update.json")
APPROVAL = Path("/etc/kmj-codebridge-oneclick/signed-auto-update-approval.json")
SIGNED_TIMER = "kmj-codebridge-stable-update.timer"
SIGNED_SERVICE = "kmj-codebridge-stable-update.service"
DEV_TIMER = "kmj-codebridge-auto-update.timer"
NODE = Path("/opt/kmj-codebridge-node/bin/node")
FEED_ROOT = "https://kmjtechno.com/codebridge/releases/stable"
FEED_MANIFEST = FEED_ROOT + "/latest/release-manifest.json"
FEED_SIG = FEED_ROOT + "/latest/release-manifest.sig"
CURRENT = "40655678db7fa62edca28ccc4988614010253ef1"
OLD_MANIFEST = FEED_ROOT + "/" + CURRENT + "/release-manifest.json"
OLD_SIG = FEED_ROOT + "/" + CURRENT + "/release-manifest.sig"
OWNER_FP = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
KEY_ID = "kmj-release-2026"
BACKUP = CONFIG.parent / "stable-update.before-oneclick-feed.json"
CONFIRM = "--confirm-signed-auto-owner-go"
SYSTEMCTL = "/usr/bin/systemctl"


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def trusted_ancestors(file):
    for parent in reversed(file.parents):
        try:
            st = os.lstat(parent)
        except OSError:
            raise Blocked("TRUSTED_PARENT_MISSING") from None
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and
                not (st.st_mode & 0o022), "TRUSTED_PARENT_UNSAFE")


def read_root(file, limit=65536, private=True):
    trusted_ancestors(file)
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("ROOT_FILE_MISSING") from None
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and
                st.st_nlink == 1 and 0 < st.st_size <= limit and
                not (st.st_mode & (0o077 if private else 0o022)),
                "ROOT_FILE_UNTRUSTED")
        data = b""
        while len(data) < st.st_size:
            chunk = os.read(fd, st.st_size - len(data))
            require(bool(chunk), "ROOT_FILE_RACE")
            data += chunk
        now = os.fstat(fd)
        require((st.st_dev, st.st_ino, st.st_size,
                 st.st_mtime_ns, st.st_ctime_ns) ==
                (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns,
                 now.st_ctime_ns), "ROOT_FILE_RACE")
        return data
    finally:
        os.close(fd)


def owner_approval():
    try:
        policy = json.loads(read_root(APPROVAL, 2048))
    except (ValueError, UnicodeError):
        raise Blocked("OWNER_POLICY_INVALID") from None
    require(type(policy) is dict and set(policy) ==
            {"schema", "profile", "allowedComponents", "keySpkiSha256",
             "minimumSequence", "ownerGo"}, "OWNER_POLICY_FIELDS")
    require(policy["schema"] == 1 and
            policy["profile"] == "signed-stable-agent-only" and
            policy["allowedComponents"] == ["agent"] and
            policy["keySpkiSha256"] == OWNER_FP and
            type(policy["minimumSequence"]) is int and
            policy["minimumSequence"] == 27 and policy["ownerGo"] is True,
            "OWNER_POLICY_NOT_APPROVED")
    return policy


def parse_config(raw):
    try:
        cfg = json.loads(raw)
    except (ValueError, UnicodeError):
        raise Blocked("UPDATE_CONFIG_INVALID") from None
    require(type(cfg) is dict and cfg.get("schema") == 1 and
            cfg.get("channel") == "stable", "STABLE_CHANNEL_INVALID")
    u = (cfg.get("manifestUrl"), cfg.get("signatureUrl"))
    require(u in ((OLD_MANIFEST, OLD_SIG), (FEED_MANIFEST, FEED_SIG)),
            "CONFIG_URL_UNRECOGNIZED")
    keys = cfg.get("trustedKeys")
    require(type(keys) is dict and type(keys.get(KEY_ID)) is str and
            len(keys[KEY_ID]) <= 8192 and "PRIVATE KEY" not in keys[KEY_ID],
            "TRUSTED_OWNER_KEY_MISSING")
    require(cfg.get("supervisorSocket") == "/run/kmj-codebridge/supervisor.sock",
            "UPDATER_SUPERVISOR_SCOPE_DRIFT")
    return cfg


def command(*args, timeout=18, data=None):
    try:
        p = subprocess.run(args, input=data, capture_output=True,
                           timeout=timeout, check=False,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                                "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("GUARDED_COMMAND_UNAVAILABLE") from None
    require(p.returncode == 0 and len(p.stdout) <= 131072,
            "GUARDED_COMMAND_FAILED")
    return p.stdout


def status(unit):
    require(unit in (SIGNED_TIMER, SIGNED_SERVICE, DEV_TIMER),
            "UNEXPECTED_UNIT")
    args = [SYSTEMCTL, "show", unit, "--no-pager"]
    for prop in ("LoadState", "FragmentPath", "NeedDaemonReload",
                 "ActiveState", "UnitFileState", "User", "ExecStart", "Result"):
        args.extend(("-p", prop))
    raw = command(*args, timeout=12)
    result = {}
    allowed = {"LoadState", "FragmentPath", "NeedDaemonReload",
               "ActiveState", "UnitFileState", "User", "ExecStart", "Result"}
    for line in raw.decode("utf-8", "replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in allowed:
                require(key not in result, "UNIT_PROPERTY_DUPLICATE")
                result[key] = value
    # systemctl show <timer> omits service-only properties (User and
    # ExecStart) on real systemd versions, rather than printing empty values.
    # Do not weaken mandatory identity checks for the signed SERVICE.
    optional = {"User", "ExecStart"} if unit in (SIGNED_TIMER, DEV_TIMER) else set()
    require((allowed - optional).issubset(result), "UNIT_PROPERTIES_INCOMPLETE")
    if unit == SIGNED_SERVICE:
        require(len(result) == len(allowed), "UNIT_PROPERTIES_INCOMPLETE")
    else:
        for name in optional:
            require(result.get(name, "") == "", "TIMER_SERVICE_PROPERTY_DRIFT")
            result.setdefault(name, "")
    return result


def systemd_policy(timer, service, dev):
    require(timer["LoadState"] == "loaded" and
            timer["FragmentPath"] == "/etc/systemd/system/" + SIGNED_TIMER and
            timer["NeedDaemonReload"] == "no",
            "SIGNED_TIMER_INSTALL_UNVERIFIED")
    require(service["LoadState"] == "loaded" and
            service["FragmentPath"] == "/etc/systemd/system/" + SIGNED_SERVICE and
            service["NeedDaemonReload"] == "no" and
            service["User"] in ("root", "") and
            "stable-update" in service["ExecStart"] and
            "/etc/kmj-codebridge-update/stable-update.json" in service["ExecStart"],
            "SIGNED_SERVICE_INSTALL_UNVERIFIED")
    require(service["ActiveState"] == "inactive" and
            service["Result"] in ("success", ""),
            "SIGNED_UPDATE_BUSY_OR_FAILED")
    require(dev["LoadState"] in ("loaded", "not-found") and
            dev["ActiveState"] != "active" and
            dev["UnitFileState"] not in ("enabled", "enabled-runtime"),
            "UNSIGNED_DEVELOPMENT_TIMER_CONFLICT")
    # A pre-enabled timer with trusted feed and an idle service is a no-op.
    return (timer["UnitFileState"] in ("enabled", "enabled-runtime") and
            timer["ActiveState"] == "active")


def fetch(url, size=65536):
    require(url in (FEED_MANIFEST, FEED_SIG), "UNTRUSTED_FEED_URL")
    return command("/usr/bin/curl", "-fsS", "--proto", "=https",
                   "--max-time", "15", "--max-filesize", str(size),
                   "--connect-timeout", "5", url, timeout=22)


def verify_feed(cfg):
    manifest, sig = fetch(FEED_MANIFEST), fetch(FEED_SIG, 1024)
    require(len(manifest) <= 65536 and len(sig) <= 1024,
            "SIGNED_FEED_OVERSIZE")
    try:
        m = json.loads(manifest)
        pub = cfg["trustedKeys"][KEY_ID]
        sigtext = sig.decode("ascii").strip()
    except (ValueError, UnicodeError):
        raise Blocked("SIGNED_FEED_FORMAT_INVALID") from None
    require(type(m) is dict and m.get("schema") == 1 and
            m.get("product") == "KMJ CodeBridge" and
            m.get("channel") == "stable" and
            type(m.get("sequence")) is int and m["sequence"] >= 27 and
            m.get("keyId") == KEY_ID and m.get("nodeMajor") == 24 and
            bool(re.fullmatch(r"[a-f0-9]{40}", str(m.get("revision", "")))) and
            bool(re.fullmatch(r"[a-f0-9]{64}", str(m.get("sha256", "")))) and
            type(m.get("bytes")) is int and 1 <= m["bytes"] <= 300000000,
            "SIGNED_FEED_METADATA_REJECTED")
    path = f"{FEED_ROOT}/{m['revision']}/"
    require(type(m.get("archive")) is str and
            m["archive"].startswith(path) and
            bool(re.fullmatch(r"kmj-codebridge-[A-Za-z0-9._-]+\.tar\.gz",
                              m["archive"][len(path):])),
            "SIGNED_FEED_ARCHIVE_ORIGIN_REJECTED")
    trusted_ancestors(NODE)
    st = os.lstat(NODE)
    require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and
            (st.st_mode & 0o022) == 0 and os.access(NODE, os.X_OK),
            "PINNED_NODE_UNTRUSTED")
    js = r"""
const fs=require('node:fs'),c=require('node:crypto'),x=JSON.parse(fs.readFileSync(0,'utf8'));
const pub=c.createPublicKey(x.key);
const fp=c.createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex');
const sig=Buffer.from(x.sig.trim(),'base64url');
if(pub.asymmetricKeyType!=='ed25519'||fp!==x.fp||sig.length!==64||
!c.verify(null,Buffer.from(x.data,'base64'),pub,sig))process.exit(2);
"""
    payload = json.dumps({"key": pub, "fp": OWNER_FP, "sig": sigtext,
                          "data": base64.b64encode(manifest).decode()}).encode()
    command(str(NODE), "-e", js, timeout=15, data=payload)
    return m["sequence"]


def write_exact(fd, data):
    offset = 0
    while offset < len(data):
        n = os.write(fd, data[offset:])
        require(n > 0, "AUTO_CONFIG_SHORT_WRITE")
        offset += n


def sync_private_config_parent():
    # Both the protected backup and config replacement must survive a crash.
    fd = os.open(CONFIG.parent, os.O_RDONLY | os.O_DIRECTORY |
                 os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_replace_config(before, obj):
    # Never alter any field except the two signed feed URLs.
    updated = dict(obj, manifestUrl=FEED_MANIFEST, signatureUrl=FEED_SIG)
    require({k: updated[k] for k in obj if k not in
             ("manifestUrl", "signatureUrl")} ==
            {k: obj[k] for k in obj if k not in
             ("manifestUrl", "signatureUrl")}, "CONFIG_UNRELATED_CHANGE")
    new = (json.dumps(updated, indent=2) + "\n").encode()
    require(not os.path.lexists(BACKUP), "OWNER_CONFIG_BACKUP_EXISTS")
    trusted_ancestors(CONFIG)
    fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        write_exact(fd, before)
        os.fsync(fd)
    finally:
        os.close(fd)
    # A durable backup is a prerequisite to touching the live config.
    sync_private_config_parent()
    require(read_root(BACKUP) == before, "AUTO_CONFIG_BACKUP_UNVERIFIED")
    # This check prevents overwriting an administrator's concurrent change.
    require(read_root(CONFIG) == before, "CONFIG_CONCURRENT_CHANGE")
    fd, path = tempfile.mkstemp(prefix=".stable-update-feed-", dir=CONFIG.parent)
    try:
        os.fchmod(fd, 0o600)
        write_exact(fd, new)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        require(read_root(CONFIG) == before, "CONFIG_CONCURRENT_CHANGE")
        os.replace(path, CONFIG)
        sync_private_config_parent()
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.lexists(path):
            os.unlink(path)
    require(read_root(CONFIG) == new, "FEED_CONFIG_NOT_PERSISTED")
    return new


def rollback_config(before, written):
    # Never clobber a third-party change after a failed timer activation.
    if read_root(CONFIG) != written:
        raise Blocked("CONFIG_CHANGED_ROLLBACK_REFUSED")
    fd, path = tempfile.mkstemp(prefix=".stable-update-restore-", dir=CONFIG.parent)
    try:
        os.fchmod(fd, 0o600)
        write_exact(fd, before)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(path, CONFIG)
        sync_private_config_parent()
    finally:
        if fd >= 0: os.close(fd)
        if os.path.lexists(path): os.unlink(path)
    require(read_root(CONFIG) == before, "CONFIG_RESTORE_FAILED")


def main(argv):
    require(argv in ([], ["--status"], ["--enable", CONFIRM],
                     ["--disable", CONFIRM]), "ONECLICK_INVALID_ACTION")
    require(os.geteuid() == 0 and
            socket.gethostname().split(".")[0].lower() == "kmj-elite",
            "OWNER_ROOT_KMJ_ELITE_REQUIRED")
    # Program itself must be a trusted, installed root-owned file.
    read_root(Path(__file__), 262144, private=False)
    timer = status(SIGNED_TIMER)
    service = status(SIGNED_SERVICE)
    dev = status(DEV_TIMER)
    if argv == ["--disable", CONFIRM]:
        owner_approval()
        require(timer["LoadState"] == "loaded", "SIGNED_TIMER_MISSING")
        command(SYSTEMCTL, "disable", "--now", SIGNED_TIMER, timeout=25)
        # systemctl exit 0 is not proof that a timer stopped or stayed disabled.
        # Fail closed rather than reporting a false DISABLED state.
        after = status(SIGNED_TIMER)
        require(after["LoadState"] == "loaded" and
                after["FragmentPath"] ==
                "/etc/systemd/system/" + SIGNED_TIMER and
                after["NeedDaemonReload"] == "no" and
                after["ActiveState"] == "inactive" and
                after["UnitFileState"] == "disabled",
                "SIGNED_TIMER_DISABLE_UNVERIFIED")
        print("ONECLICK_AUTO_SIGNED=DISABLED")
        return
    is_on = systemd_policy(timer, service, dev)
    if argv in ([], ["--status"]):
        print("ONECLICK_AUTO_SIGNED=" + ("ENABLED" if is_on else "DISABLED"))
        print("AUTO_DEPLOY_SCOPE=SIGNED_AGENT_ONLY")
        print("GATEWAY_SUPERVISOR_AUTOPROMOTION=NOT_ENABLED")
        return
    owner_approval()
    original = read_root(CONFIG)
    cfg = parse_config(original)
    observed_sequence = verify_feed(cfg)
    require(observed_sequence >= 27, "SIGNED_FEED_SEQUENCE_TOO_OLD")
    if is_on:
        require(cfg["manifestUrl"] == FEED_MANIFEST, "TIMER_ACTIVE_WITH_STATIC_CONFIG")
        print("ONECLICK_AUTO_SIGNED=ALREADY_ENABLED")
        return
    changed = False
    written = None
    try:
        if cfg["manifestUrl"] == OLD_MANIFEST:
            written = atomic_replace_config(original, cfg)
            changed = True
        command(SYSTEMCTL, "enable", "--now", SIGNED_TIMER, timeout=30)
        fresh = status(SIGNED_TIMER)
        require(fresh["ActiveState"] == "active" and
                fresh["UnitFileState"] in ("enabled", "enabled-runtime"),
                "SIGNED_TIMER_ENABLE_UNVERIFIED")
    except Blocked:
        # Fail closed. Try to stop the timer before restoring the original
        # static release URLs. Never claim success if recovery was incomplete.
        try:
            command(SYSTEMCTL, "disable", "--now", SIGNED_TIMER, timeout=25)
            if changed: rollback_config(original, written)
        except Blocked:
            raise Blocked("AUTO_ENABLE_ROLLBACK_OWNER_REVIEW_REQUIRED") from None
        raise
    print("ONECLICK_AUTO_SIGNED=ENABLED")
    print("SIGNED_RELEASE_FEED_SEQUENCE=" + str(observed_sequence))
    print("AUTO_DEPLOY_SCOPE=SIGNED_AGENT_ONLY")
    print("GATEWAY_SUPERVISOR_AUTOPROMOTION=NOT_ENABLED")
    print("UNSIGNED_GITHUB_MERGE_AUTOPROMOTION=DENIED")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Blocked, OSError, ValueError, KeyError, TypeError) as exc:
        reason = str(exc) if isinstance(exc, Blocked) else "UNCLASSIFIED"
        print("ONECLICK_AUTO_SIGNED=BLOCKED:" +
              (reason if re.fullmatch(r"[A-Z_]{4,90}", reason) else "UNCLASSIFIED"))
        raise SystemExit(2)
