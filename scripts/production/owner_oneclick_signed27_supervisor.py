#!/usr/bin/env python3
"""KMJ TECHNO: one-command, owner-approved Seq27 Supervisor repair.

DRY RUN is default. No caller-supplied unit, executable, URL or path. It reuses
an independently reviewed, pinned root-owned helper (PR #946); it never writes
systemd configuration directly and does not equate success with MCP acceptance.
This profile is for Seq27 only. Every later signed release needs a new reviewed
profile and signed authorization, not an auto-update from untrusted GitHub.
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

REVISION = "40655678db7fa62edca28ccc4988614010253ef1"
RELEASE = Path("/opt/kmj-codebridge-stable/releases/0.3.2-40655678db7f")
CURRENT = Path("/opt/kmj-codebridge-stable/current")
GATEWAY_UNIT = "kmj-codebridge-gateway-stage.service"
SUPERVISOR_UNIT = "kmj-codebridge-supervisor.service"
OLD_SUPERVISOR_RELEASE = "0.3.2-dc14877375a5"
HELPER = Path("/usr/local/libexec/kmj-codebridge/owner_switch_supervisor_signed27_20261115.py")
MANIFEST = Path("/var/lib/kmj-codebridge-releases/stable") / REVISION / "release-manifest.json"
SIGNATURE = MANIFEST.with_name("release-manifest.sig")
TRUST_CONFIG = Path("/etc/kmj-codebridge-update/stable-update.json")
NODE = Path("/opt/kmj-codebridge-node/bin/node")
OWNER_KEY_FINGERPRINT = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
MANIFEST_SHA256 = "82100f7a8bf63c7b73671dfde040cef95d37f96bc7361ea53e0165a92f80996e"
ARCHIVE_SHA256 = "81282d540021bbb4ab345f5c4f2aab639dd70eb8b4ff27202f6c68a46f29d77e"
APPROVAL = Path("/etc/kmj-codebridge-oneclick/signed27-supervisor-approval.json")
EXPECTED_APPROVAL = frozenset(("schema", "profile", "revision", "helperSha256", "ownerGo"))
EXPECTED_KEYS = frozenset(("LoadState", "ActiveState", "WorkingDirectory", "MainPID", "NeedDaemonReload", "ExecStart"))
SUPERVISOR_OVERRIDE = Path("/etc/systemd/system/kmj-codebridge-supervisor.service.d/zzzzzz-kmj-signed27-supervisor.conf")
CONFIRM = "--confirm-signed27-supervisor-owner-go"


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def trusted_parents(path):
    # Reject writable ancestor directories and symlink redirection, including
    # the approval directory itself. Never walk arbitrary caller paths.
    for parent in reversed(path.parents):
        try:
            s = os.lstat(parent)
        except OSError:
            raise Blocked("OWNER_PARENT_MISSING") from None
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not (s.st_mode & 0o022),
             "OWNER_PARENT_UNTRUSTED")


def pinned_read(path, limit, private=False):
    trusted_parents(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("OWNER_PINNED_FILE_MISSING") from None
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1
             and 0 < s.st_size <= limit and (s.st_mode & (0o077 if private else 0o022)) == 0,
             "OWNER_PINNED_FILE_UNTRUSTED")
        result = b""
        while len(result) < s.st_size:
            chunk = os.read(fd, s.st_size - len(result))
            need(bool(chunk), "OWNER_FILE_CHANGED")
            result += chunk
        t = os.fstat(fd)
        need((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) ==
             (t.st_dev, t.st_ino, t.st_size, t.st_mtime_ns, t.st_ctime_ns),
             "OWNER_FILE_CHANGED")
        return result
    finally:
        os.close(fd)


def approved_helper():
    try:
        policy = json.loads(pinned_read(APPROVAL, 2048, private=True))
    except (ValueError, UnicodeError):
        raise Blocked("OWNER_APPROVAL_INVALID") from None
    need(type(policy) is dict and frozenset(policy) == EXPECTED_APPROVAL,
         "OWNER_APPROVAL_SCHEMA_INVALID")
    need(policy["schema"] == 1 and policy["profile"] == "signed27-supervisor"
         and policy["revision"] == REVISION and policy["ownerGo"] is True,
         "OWNER_APPROVAL_NOT_GRANTED")
    digest = policy["helperSha256"]
    need(type(digest) is str and bool(re.fullmatch(r"[a-f0-9]{64}", digest)),
         "OWNER_HELPER_PIN_INVALID")
    data = pinned_read(HELPER, 262144)
    need(hashlib.sha256(data).hexdigest() == digest, "OWNER_HELPER_HASH_MISMATCH")
    need(data.startswith(b"#!/usr/bin/env python3\n"), "OWNER_HELPER_FORMAT_INVALID")
    return digest


def verify_signed_release():
    """Verify the owner public trust and exact raw Ed25519 manifest bytes.

    Never copy the signing key, run a download or treat stable/current as proof.
    Reject missing or stale locally published signed artifacts.
    """
    manifest = pinned_read(MANIFEST, 65536)
    signature = pinned_read(SIGNATURE, 1024)
    need(hashlib.sha256(manifest).hexdigest() == MANIFEST_SHA256,
         "SIGNED27_MANIFEST_PIN_MISMATCH")
    try:
        item = json.loads(manifest)
        trust = json.loads(pinned_read(TRUST_CONFIG, 65536, private=True))
    except (ValueError, UnicodeError):
        raise Blocked("SIGNED27_TRUST_METADATA_INVALID") from None
    need(type(item) is dict and item.get("revision") == REVISION
         and item.get("channel") == "stable" and item.get("sequence") == 27
         and item.get("keyId") == "kmj-release-2026"
         and item.get("sha256") == ARCHIVE_SHA256
         and item.get("bytes") == 2171009,
         "SIGNED27_MANIFEST_IDENTITY_INVALID")
    keys = trust.get("trustedKeys", {}) if type(trust) is dict else {}
    pub = keys.get("kmj-release-2026") if type(keys) is dict else None
    need(type(pub) is str and 32 <= len(pub) <= 8192,
         "SIGNED27_OWNER_TRUST_KEY_MISSING")
    # Node24 is the pinned platform interpreter already used by signed updater.
    trusted_parents(NODE)
    st = os.lstat(NODE)
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0
         and (st.st_mode & 0o022) == 0 and os.access(NODE, os.X_OK),
         "SIGNED27_NODE_RUNTIME_UNTRUSTED")
    verifier = r"""
const c=require('node:crypto'),f=require('node:fs');
const x=JSON.parse(f.readFileSync(0,'utf8'));
const k=c.createPublicKey(x.publicKey);
const h=c.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex');
const s=Buffer.from(x.signature.trim(),'base64url');
if(k.asymmetricKeyType!=='ed25519'||h!==x.fingerprint||s.length!==64||
!c.verify(null,Buffer.from(x.manifest,'base64'),k,s)) process.exit(2);
"""
    payload = json.dumps({"publicKey":pub, "signature":signature.decode("ascii"),
                          "manifest":base64.b64encode(manifest).decode(),
                          "fingerprint":OWNER_KEY_FINGERPRINT}).encode()
    try:
        out = subprocess.run([str(NODE), "-e", verifier], input=payload,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             timeout=20, check=False,
                             env={"PATH":"/usr/bin:/bin", "LC_ALL":"C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SIGNED27_CRYPTO_VERIFIER_UNAVAILABLE") from None
    need(out.returncode == 0, "SIGNED27_ED25519_VERIFICATION_FAILED")
    return True


def systemd(unit):
    need(unit in (GATEWAY_UNIT, SUPERVISOR_UNIT), "UNIT_UNEXPECTED")
    args = ["/usr/bin/systemctl", "show", "--no-pager"]
    for key in sorted(EXPECTED_KEYS):
        args += ["-p", key]
    args.append(unit)
    try:
        proc = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=12, check=False, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SYSTEMD_UNAVAILABLE") from None
    need(proc.returncode == 0 and len(proc.stdout) <= 16384, "SYSTEMD_UNAVAILABLE")
    values = {}
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in EXPECTED_KEYS:
                need(key not in values, "SYSTEMD_DUPLICATE_FIELD")
                values[key] = value
    need(frozenset(values) == EXPECTED_KEYS, "SYSTEMD_FIELDS_INCOMPLETE")
    return values


def gateway_ready(status):
    need(status["LoadState"] == "loaded" and status["ActiveState"] == "active"
         and status["NeedDaemonReload"] == "no"
         and status["WorkingDirectory"] == str(RELEASE),
         "GATEWAY_SIGNED27_NOT_READY")
    try:
        pid = int(status["MainPID"])
        need(pid > 1 and Path(f"/proc/{pid}/cwd").resolve(strict=True) == RELEASE,
             "GATEWAY_PROCESS_RELEASE_MISMATCH")
    except (OSError, ValueError, RuntimeError):
        raise Blocked("GATEWAY_PROCESS_UNVERIFIED") from None


def run_helper(mode):
    # Exact allowlist: only 'dry-run' and '--apply', no caller-controlled argv.
    need(mode in ("check", "apply"), "MODE_UNEXPECTED")
    args = ["/usr/bin/python3", "-I", "-B", str(HELPER)]
    if mode == "apply":
        args.append("--apply")
    try:
        proc = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=150, check=False, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("OWNER_HELPER_UNAVAILABLE") from None
    need(len(proc.stdout) <= 8192, "OWNER_HELPER_OUTPUT_TOO_LARGE")
    # Never echo unknown output: it could contain private system details.
    body = proc.stdout.decode("utf-8", "replace")
    need(proc.returncode == 0, "OWNER_HELPER_REFUSED")
    marker = "SIGNED27_SUPERVISOR=APPLIED" if mode == "apply" else "SIGNED27_SUPERVISOR=DRY_RUN_UNCHANGED"
    need(marker in body.splitlines(), "OWNER_HELPER_RECEIPT_MISSING")
    return marker


def already_applied(supervisor):
    if not os.path.lexists(SUPERVISOR_OVERRIDE):
        return False
    data = pinned_read(SUPERVISOR_OVERRIDE, 16384)
    expected = ("[Service]\nExecStart=\nExecStart=" + str(NODE) + " " +
                str(RELEASE) + "/src/cli.js supervisor\n").encode()
    need(data == expected, "SIGNED27_SUPERVISOR_OVERRIDE_UNTRUSTED")
    match = re.findall(r"argv\[\]=(.*?) ;", supervisor["ExecStart"])
    need(match == [f"{NODE} {RELEASE}/src/cli.js supervisor"],
         "SIGNED27_SUPERVISOR_EFFECTIVE_RUNTIME_MISMATCH")
    return True


def run(argv):
    need(argv in ([], ["--apply", CONFIRM]), "ONECLICK_USAGE")
    need(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower() == "kmj-elite",
         "OWNER_ROOT_HOST_REQUIRED")
    need(CURRENT.is_symlink() and CURRENT.resolve(strict=True) == RELEASE,
         "SIGNED27_RELEASE_POINTER_MISMATCH")
    gateway_ready(systemd(GATEWAY_UNIT))
    supervisor = systemd(SUPERVISOR_UNIT)
    need(supervisor["LoadState"] == "loaded"
         and supervisor["NeedDaemonReload"] == "no"
         and supervisor["ActiveState"] in ("active", "inactive"),
         "SUPERVISOR_UNIT_NOT_READY")
    approved_helper()
    verify_signed_release()
    # Repeated one-click runs are safe: an exact existing override is a no-op,
    # never a blind second mutation. Still demand real post-deploy MCP receipts.
    upgraded = already_applied(supervisor)
    if not upgraded:
        run_helper("check" if not argv else "apply")
    print("ONECLICK_RELEASE=SIGNED27")
    if upgraded:
        print("ONECLICK_SUPERVISOR=ALREADY_APPLIED_NO_MUTATION")
        print("REQUIRED_NEXT=CODEBRIDGE_THREE_FIXED_READONLY_MCP_RECEIPTS")
    elif argv:
        print("ONECLICK_SUPERVISOR=APPLIED_BUT_MCP_UNVERIFIED")
        print("REQUIRED_NEXT=CODEBRIDGE_THREE_FIXED_READONLY_MCP_RECEIPTS")
    else:
        print("ONECLICK_PREFLIGHT=PASS_NO_MUTATIONS")
    print("GATEWAY_RESTARTED=NO")
    print("BACKUP_AND_HEALTH_MUTATIONS=NONE")
    return 0


def main():
    try:
        raise SystemExit(run(sys.argv[1:]))
    except (Blocked, OSError) as exc:
        why = str(exc) if isinstance(exc, Blocked) else "SYSTEM_ERROR"
        code = why if re.fullmatch(r"[A-Z0-9_]{4,80}", why) else "UNCLASSIFIED"
        print("ONECLICK_RELEASE=BLOCKED:" + code)
        print("GATEWAY_AND_SUPERVISOR_DEPLOYMENT=NOT_ATTESTED")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
