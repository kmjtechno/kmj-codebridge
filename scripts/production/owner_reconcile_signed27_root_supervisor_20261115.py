#!/usr/bin/env python3
"""KMJ-elite owner-only, SHA-pinned Seq27 root Supervisor reconciliation.

NOT AN AUTOMATIC UPGRADE. Safe default is --preflight. --apply may only add
one fixed, previously nonexistent root-owned systemd Supervisor drop-in after
proving the signed27 gateway is already running at exact SHA, that its
root-owned stable runtime has the pinned source bytes, and that the old
socket-activated root Supervisor is IDLE. This never restarts the gateway,
agent, backup, health-check or application, never changes archives or keys.
On any postwrite fault it removes only its own byte-identical drop-in,
daemon-reloads and leaves the original Supervisor unit/socket untouched.
The operator must separately verify fixed read-only MCP command receipts.
"""
from __future__ import annotations
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

SOURCE_SHA="40655678db7fa62edca28ccc4988614010253ef1"
SOURCE_ROOT=Path("/opt/kmj-codebridge-stable/releases/0.3.2-40655678db7f")
PINNED_FILES={
    "src/supervisor.js":"141faa14608c4aedec6b29f65ea4c274f14f17af1e466fdf5554abd597e6e084",
    "src/cli.js":"169b01e3ec55cdf7f059e74039cdff8426163d8b108720e2ac5c339a6399471b",
    "src/main-platform-local-backup-evidence.js":"b6e06d2f2ba07715b9d000a41be3c45d71dfff3cf1d5c4bb79ce880ef86ca76f",
    "src/main-platform-backup-inventory.js":"79939cfc76008cf69d33cd0e78244ce73a5f01ac224f3b331ea048de2e11745d",
}
SERVICE="kmj-codebridge-supervisor.service"
SOCKET="kmj-codebridge-supervisor.socket"
GATEWAY="kmj-codebridge-gateway-stage.service"
NODE="/opt/kmj-codebridge-node/bin/node"
DROP_DIR=Path("/etc/systemd/system/kmj-codebridge-supervisor.service.d")
DROP_NAME="zzzzzzzzzz-kmj-signed27-root-supervisor.conf"
DROP_PATH=DROP_DIR/DROP_NAME
ENV={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin","LANG":"C","LC_ALL":"C","HOME":"/root"}
STRICT_BASE="/opt/kmj-codebridge-supervisor-stage/"
UNIT_FIELDS=("Id","LoadState","Type","User","Group","WorkingDirectory",
             "ExecStart","DropInPaths","ActiveState","NeedDaemonReload")
SOCKET_FIELDS=("Id","LoadState","ActiveState")
GATEWAY_FIELDS=("Id","LoadState","ActiveState","Environment","WorkingDirectory","ExecStart")
PREV_RE=r"/opt/kmj-codebridge-supervisor-stage/[a-f0-9]{40}"
REPLACEMENT=(
    "# KMJ owner-approved signed27 root-only Supervisor reconciliation\n"
    "# Source pinned by four 64-hex SHA256 digests; never a writable checkout\n"
    "[Service]\n"
    "WorkingDirectory="+str(SOURCE_ROOT)+"\n"
    "ExecStart=\n"
    "ExecStart="+NODE+" "+str(SOURCE_ROOT)+"/src/cli.js supervisor\n"
)
DROP_SHA=hashlib.sha256(REPLACEMENT.encode()).hexdigest()


class Block(Exception): pass


def fail(reason): raise Block(reason)


def one_path_component(path):
    st=os.lstat(path)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid!=0
            or st.st_mode&0o022 or stat.S_ISLNK(st.st_mode)):
        fail("ROOT_SOURCE_PARENT_UNTRUSTED")


def source_parents():
    for p in ("/","/opt","/opt/kmj-codebridge-stable",
              "/opt/kmj-codebridge-stable/releases",str(SOURCE_ROOT),
              str(SOURCE_ROOT/"src")):
        one_path_component(p)
    node=os.lstat(NODE)
    if (not stat.S_ISREG(node.st_mode) or node.st_uid!=0
            or node.st_mode&0o022):
        fail("PINNED_NODE_UNTRUSTED")


def pinned_bytes(path,digest,cap=300000):
    st=os.lstat(path)
    if (not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022
            or st.st_nlink!=1 or not 256<=st.st_size<=cap):
        fail("PINNED_RELEASE_FILE_UNSAFE")
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        current=os.fstat(fd)
        if (current.st_dev,current.st_ino,current.st_size)!=(st.st_dev,st.st_ino,st.st_size):
            fail("PINNED_RELEASE_FILE_RACE")
        raw=os.read(fd,cap+1)
        end=os.fstat(fd)
        if (len(raw)!=st.st_size or
                (end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns,end.st_ctime_ns)!=
                (current.st_dev,current.st_ino,current.st_size,current.st_mtime_ns,current.st_ctime_ns)):
            fail("PINNED_RELEASE_FILE_RACE")
        if hashlib.sha256(raw).hexdigest()!=digest:
            fail("PINNED_SIGNED27_SOURCE_SHA_MISMATCH")
    finally:os.close(fd)


def approved_source():
    source_parents()
    for name,digest in PINNED_FILES.items():
        pinned_bytes(SOURCE_ROOT/name,digest)
    one_path_component(str(SOURCE_ROOT/"node_modules"))
    # The already-running signed gateway uses the same runtime. Reject a
    # runtime subtree writable by an unprivileged agent; no link traversal.
    count=0
    for root,dirs,files in os.walk(SOURCE_ROOT,followlinks=False):
        count+=len(dirs)+len(files)
        if count>35000:fail("SIGNED27_RUNTIME_TREE_TOO_LARGE")
        for name in dirs+files:
            path=Path(root)/name
            st=os.lstat(path)
            if st.st_uid!=0 or st.st_mode&0o022:
                fail("SIGNED27_RUNTIME_WRITABLE_OR_FOREIGN_OWNED")
            if stat.S_ISLNK(st.st_mode):
                actual=path.resolve(strict=True)
                if not actual.is_relative_to(SOURCE_ROOT):
                    fail("SIGNED27_RUNTIME_EXTERNAL_SYMLINK")
            elif not(stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                fail("SIGNED27_RUNTIME_SPECIAL_ENTRY")


def call(argv,timeout=15):
    try:
        completed=subprocess.run(argv,env=ENV,cwd="/",stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                 check=False,timeout=timeout)
    except (OSError,subprocess.TimeoutExpired):
        fail("SYSTEMD_COMMAND_UNAVAILABLE")
    if completed.returncode!=0 or len(completed.stdout)>16000:
        fail("SYSTEMD_COMMAND_FAILED")
    return completed.stdout.decode("utf-8",errors="strict")


def props(unit,keys):
    argv=["/usr/bin/systemctl","show","--no-pager"]
    for field in keys:argv+=["-p",field]
    argv.append(unit)
    answer={}
    for line in call(argv).splitlines():
        if "=" not in line:fail("UNIT_PROPERTIES_INVALID")
        key,value=line.split("=",1)
        if key not in keys or key in answer:fail("UNIT_PROPERTIES_INVALID")
        answer[key]=value
    if set(answer)!=set(keys):fail("UNIT_PROPERTIES_INCOMPLETE")
    return answer


def validate_baseline(root,sock,gw):
    if (root["Id"]!=SERVICE or root["LoadState"]!="loaded"
            or root["Type"]!="simple" or root["User"] not in ("","root")
            or root["Group"] not in ("","root")
            or root["NeedDaemonReload"]!="no"):
        fail("SUPERVISOR_UNIT_NOT_BASELINE")
    # Require an idle socket-activated root service: no active root job lost.
    if root["ActiveState"]!="inactive":
        fail("SUPERVISOR_BUSY_OR_FAILED_REQUIRE_REVIEW")
    if (sock.get("Id")!=SOCKET or sock.get("LoadState")!="loaded"
            or sock.get("ActiveState")!="active"):
        fail("SUPERVISOR_SOCKET_NOT_READY")
    if not re.fullmatch(PREV_RE,root["WorkingDirectory"]):
        fail("SUPERVISOR_OLD_STAGE_UNEXPECTED")
    old_exec=root["ExecStart"]
    marker=root["WorkingDirectory"]+"/src/cli.js supervisor"
    if (old_exec.count(marker)!=1 or len(old_exec)>5000
            or "argv[]=" not in old_exec):
        fail("SUPERVISOR_OLD_EXEC_UNEXPECTED")
    if (gw.get("Id")!=GATEWAY or gw.get("LoadState")!="loaded"
            or gw.get("ActiveState")!="active" or
            "CODEBRIDGE_SOURCE_COMMIT="+SOURCE_SHA not in gw["Environment"]):
        fail("SIGNED27_GATEWAY_IDENTITY_UNVERIFIED")
    if str(SOURCE_ROOT) not in gw["ExecStart"]+gw["WorkingDirectory"]:
        fail("SIGNED27_GATEWAY_RUNTIME_MISMATCH")
    if str(DROP_PATH) in root["DropInPaths"]:
        fail("NEW_DROPIN_ALREADY_INSTALLED")
    return True


def verified_dropin_directory():
    for part in ("/etc","/etc/systemd","/etc/systemd/system"):
        one_path_component(part)
    if DROP_DIR.exists() or DROP_DIR.is_symlink():
        one_path_component(str(DROP_DIR))
    elif DROP_DIR.parent!=Path("/etc/systemd/system"):
        fail("DROPIN_PARENT_UNEXPECTED")


def preflight():
    if os.geteuid()!=0 or socket.gethostname().split(".")[0]!="KMJ-elite":
        fail("OWNER_ROOT_KMJ_ELITE_REQUIRED")
    if os.path.lexists(DROP_PATH):
        fail("PROTECTED_DROPIN_ALREADY_EXISTS")
    approved_source()
    verified_dropin_directory()
    root=props(SERVICE,UNIT_FIELDS)
    sock=props(SOCKET,SOCKET_FIELDS)
    gw=props(GATEWAY,GATEWAY_FIELDS)
    validate_baseline(root,sock,gw)
    # Pre-existing drop-ins must not be bypassed. The new exact unit
    # effective fields are checked AGAIN after daemon-reload before startup.
    print("PINNED_SIGNED27_SUPERVISOR_SOURCE=PASS")
    print("ORIGINAL_ROOT_SUPERVISOR_IDLE_AND_SOCKET_ACTIVE=PASS")
    print("SIGNED27_GATEWAY_LIVE_SOURCE_IDENTITY=PASS")
    print("ROOT_SUPERVISOR_DROPIN_SCOPE=ONE_CREATE_ONLY")
    print("V2_BACKUP_HEALTH_PRODUCTION_MUTATION=NONE")
    print("RESULT=GUARDED_SUPERVISOR_PREFLIGHT_PASS")


def validate_after():
    current=props(SERVICE,UNIT_FIELDS)
    expected=str(SOURCE_ROOT)
    if (current["Id"]!=SERVICE or current["LoadState"]!="loaded"
            or current["Type"]!="simple" or current["User"] not in ("","root")
            or current["Group"] not in ("","root")
            or current["WorkingDirectory"]!=expected
            or current["NeedDaemonReload"]!="no"
            or str(DROP_PATH) not in current["DropInPaths"]
            or current["ExecStart"].count(expected+"/src/cli.js supervisor")!=1):
        fail("SIGNED27_SUPERVISOR_EFFECTIVE_UNIT_MISMATCH")


def fixed_socket_smoke():
    """Verify actual new Supervisor read-only ops, never expose response data.

    The socket is the exact pre-existing CodeBridge root Supervisor socket,
    not an arbitrary host/path. Never send privileged write requests.
    """
    names=("main_platform_local_backup_evidence",
           "main_platform_backup_inventory",
           "main_platform_health_unit_receipt")
    address="/run/kmj-codebridge/supervisor.sock"
    for op in names:
        encoded=(json.dumps({"op":op},separators=(",",":"))+"\n").encode()
        sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        try:
            sock.settimeout(12)
            sock.connect(address)
            sock.sendall(encoded)
            data=bytearray()
            while b"\n" not in data and len(data)<65536:
                chunk=sock.recv(min(4096,65537-len(data)))
                if not chunk:break
                data.extend(chunk)
        except (OSError,TimeoutError):
            fail("ROOT_SUPERVISOR_SOCKET_PROBE_FAILED")
        finally:
            sock.close()
        if b"\n" not in data or len(data)>65536:
            fail("ROOT_SUPERVISOR_SOCKET_RESPONSE_INVALID")
        try:
            result=json.loads(bytes(data).split(b"\n",1)[0])
        except (UnicodeError,ValueError,TypeError):
            fail("ROOT_SUPERVISOR_SOCKET_RESPONSE_INVALID")
        if not isinstance(result,dict) or result.get("ok") is not True:
            fail("ROOT_SUPERVISOR_READONLY_OP_DENIED")
        if not isinstance(result.get("result"),dict):
            fail("ROOT_SUPERVISOR_READONLY_OP_RESPONSE_SHAPE")
    print("ROOT_SUPERVISOR_FIXED_BACKUP_OPS=3_PASS")


def apply():
    preflight()
    if not DROP_DIR.exists():
        os.mkdir(DROP_DIR,0o755)
    verified_dropin_directory()
    # Never expose a partially written systemd drop-in: first write+fsync a
    # private temporary file, then hard-link create-only and remove temporary.
    fd,temporary=tempfile.mkstemp(prefix=".kmj-signed27-supervisor-",dir=DROP_DIR)
    committed=False
    try:
        encoded=REPLACEMENT.encode()
        os.fchmod(fd,0o644)
        offset=0
        while offset<len(encoded):
            n=os.write(fd,encoded[offset:])
            if n<=0:fail("DROPIN_SHORT_WRITE")
            offset+=n
        os.fsync(fd)
        os.close(fd)
        fd=-1
        if props(SERVICE,UNIT_FIELDS)["ActiveState"]!="inactive":
            fail("ROOT_SUPERVISOR_BECAME_BUSY")
        if os.path.lexists(DROP_PATH):
            fail("PROTECTED_DROPIN_ALREADY_EXISTS")
        os.link(temporary,DROP_PATH,follow_symlinks=False)
        committed=True
        os.unlink(temporary)
        temporary=""
        folder=os.open(DROP_DIR,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(folder)
        finally:os.close(folder)
        try:
            call(["/usr/bin/systemctl","daemon-reload"],timeout=35)
            validate_after()
            if props(SERVICE,UNIT_FIELDS)["ActiveState"]!="inactive":
                fail("ROOT_SUPERVISOR_ACTIVATED_DURING_UNIT_SWAP")
            # Socket already active, root service was idle at admission.
            call(["/usr/bin/systemctl","start",SERVICE],timeout=45)
            live=props(SERVICE,UNIT_FIELDS)
            if live["ActiveState"]!="active":
                fail("SIGNED27_ROOT_SUPERVISOR_NOT_ACTIVE")
            # Unit activity alone is not proof that the newly advertised
            # protected RPCs are actually implemented by the root process.
            # A denied RPC triggers the exact-byte override rollback below.
            fixed_socket_smoke()
            print("ROOT_SUPERVISOR_SIGNED27_EFFECTIVE=PASS")
            print("SUPERVISOR_SERVICE_STARTED=YES")
            print("GATEWAY_AGENT_AND_BACKUPS_RESTARTED=NO")
            print("RESULT=GUARDED_SUPERVISOR_SIGNED27_APPLY_PASS")
        except BaseException:
            # Rollback only our exact bytes. Stop only our newly started root
            # Supervisor (never the gateway/agent), then restore prior unit.
            try:
                current=Path(DROP_PATH).read_bytes()
                if hashlib.sha256(current).hexdigest()==DROP_SHA and current==REPLACEMENT.encode():
                    status=props(SERVICE,UNIT_FIELDS)
                    if status["WorkingDirectory"]==str(SOURCE_ROOT) and status["ActiveState"]=="active":
                        call(["/usr/bin/systemctl","stop",SERVICE],timeout=25)
                    os.unlink(DROP_PATH)
                    call(["/usr/bin/systemctl","daemon-reload"],timeout=35)
                    print("ROOT_SUPERVISOR_OVERRIDE_ROLLBACK=PASS")
                else:
                    print("ROOT_SUPERVISOR_OVERRIDE_ROLLBACK=BLOCKED_SOURCE_DRIFT")
            except Exception:
                print("ROOT_SUPERVISOR_OVERRIDE_ROLLBACK=NEEDS_OWNER_REVIEW")
            raise
    finally:
        if fd!=-1:os.close(fd)
        if temporary:
            try:os.unlink(temporary)
            except FileNotFoundError:pass


def selftest():
    assert len(SOURCE_SHA)==40 and len(PINNED_FILES)==4
    assert "ExecStart=\nExecStart=" in REPLACEMENT
    assert "kmj-codebridge-supervisor.service.d" in str(DROP_PATH)
    assert "main-platform" not in DROP_NAME
    assert "backup" not in REPLACEMENT.lower()
    print("KMJ_SIGNED27_SUPERVISOR_SOURCE_SELFTEST=PASS")
    print("HOST_SERVICE_MUTATION=NONE")


if __name__=="__main__":
    try:
        if sys.argv[1:]==["--selftest"]:
            selftest()
        elif sys.argv[1:] in ([],["--preflight"]):
            preflight()
        elif sys.argv[1:]==["--apply","--confirm-owner-supervisor-only"]:
            apply()
        else:
            fail("OPERATOR_ARGUMENTS_NOT_ALLOWED")
    except (Block,OSError,UnicodeError) as exc:
        reason=str(exc)
        if not re.fullmatch(r"[A-Z_]{5,90}",reason):
            reason="UNVERIFIED_PRECONDITION"
        print("RESULT=BLOCKED_"+reason)
        sys.exit(2)
