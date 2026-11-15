#!/usr/bin/python3
"""KMJ TECHNO one-pass owner approval for signed stable AGENT auto-update.

Only after trusted, owner-controlled root installation of the exact two
already reviewed helpers. No remote script download or arbitrary root shell.
The initial feed is Seq27, future signed monotonic rollover is separate.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import stat
import sys
import types

DIR=Path("/usr/local/libexec/kmj-codebridge")
FEED=DIR/"owner_publish_seq27_signed_latest_feed_20261115.py"
UPDATER=DIR/"owner_oneclick_signed_autoupdate.py"
APPROVAL=Path("/etc/kmj-codebridge-oneclick/signed-auto-update-approval.json")
OWNER_SPKI="2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
CONFIRM="--confirm-owner-production-auto-signed-agent"
POLICY={
  "schema":1,
  "profile":"signed-stable-agent-only",
  "allowedComponents":["agent"],
  "keySpkiSha256":OWNER_SPKI,
  "minimumSequence":27,
  "ownerGo":True
}
class Block(Exception):pass

def need(value,reason):
    if not value:raise Block(reason)

def protected_ancestors(file):
    for parent in reversed(file.parents):
        try:s=os.lstat(parent)
        except OSError:raise Block("OWNER_PARENT_MISSING") from None
        need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and
             not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022,
             "OWNER_PARENT_UNTRUSTED")

def verified_source(file):
    need(file in (FEED,UPDATER),"UNAPPROVED_HELPER_PATH")
    protected_ancestors(file)
    try:fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError:raise Block("INSTALLED_HELPER_MISSING") from None
    try:
        st=os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and
             st.st_nlink==1 and 100<st.st_size<=262144 and
             not st.st_mode&0o022,"INSTALLED_HELPER_UNTRUSTED")
        data=b""
        while len(data)<st.st_size:
            chunk=os.read(fd,st.st_size-len(data))
            need(bool(chunk),"INSTALLED_HELPER_CHANGED")
            data+=chunk
        now=os.fstat(fd)
        need((st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)==
             (now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns,now.st_ctime_ns),
             "INSTALLED_HELPER_CHANGED")
        return data
    finally:os.close(fd)

def load_helper(path):
    # Trusted, root-owned installation replaces mutable Git checkout imports.
    source=verified_source(path)
    module=types.ModuleType("kmj_owner_fixed_"+path.stem)
    module.__file__=str(path)
    module.__package__=""
    exec(compile(source,str(path),"exec"),module.__dict__)
    need(callable(getattr(module,"main",None)),"INSTALLED_HELPER_INTERFACE_DRIFT")
    return module

def read_approval():
    protected_ancestors(APPROVAL)
    try:fd=os.open(APPROVAL,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError:raise Block("OWNER_APPROVAL_MISSING") from None
    try:
        st=os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and
             st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600
             and 0<st.st_size<=2048,"OWNER_APPROVAL_UNTRUSTED")
        raw=os.read(fd,2049)
        need(len(raw)==st.st_size,"OWNER_APPROVAL_RACE")
    finally:os.close(fd)
    try:data=json.loads(raw)
    except (ValueError,UnicodeError):raise Block("OWNER_APPROVAL_INVALID") from None
    need(type(data) is dict and data==POLICY and
         set(data)==set(POLICY),"OWNER_APPROVAL_INVALID")
    return True

def ensure_approval():
    protected_ancestors(APPROVAL.parent/"proof")
    if not os.path.lexists(APPROVAL.parent):
        os.mkdir(APPROVAL.parent,mode=0o700)
        os.chmod(APPROVAL.parent,0o700)
    pst=os.lstat(APPROVAL.parent)
    need(stat.S_ISDIR(pst.st_mode) and pst.st_uid==0
         and stat.S_IMODE(pst.st_mode)==0o700,
         "APPROVAL_DIRECTORY_UNTRUSTED")
    if os.path.lexists(APPROVAL):
        return read_approval()
    payload=(json.dumps(POLICY,sort_keys=True,separators=(",",":"))+"\n").encode()
    fd=os.open(APPROVAL,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(fd,0o600)
        sent=0
        while sent<len(payload):
            n=os.write(fd,payload[sent:])
            need(n>0,"APPROVAL_WRITE_FAILED")
            sent+=n
        os.fsync(fd)
    finally:os.close(fd)
    dirfd=os.open(APPROVAL.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(dirfd)
    finally:os.close(dirfd)
    return read_approval()

def run(argv):
    need(argv in ([],["--status"],["--apply",CONFIRM],
                  ["--disable",CONFIRM]),"ONEPASS_UNEXPECTED_ARGS")
    need(os.geteuid()==0 and socket.gethostname().split(".")[0].lower()=="kmj-elite",
         "OWNER_ROOT_KMJ_ELITE_REQUIRED")
    need(verified_source(Path(__file__)) or True,"ONEPASS_SELF_UNTRUSTED") if Path(__file__) in (FEED,UPDATER) else protected_ancestors(Path(__file__))
    updater=load_helper(UPDATER)
    if argv in ([],["--status"]):
        updater.main([])
        print("ONEPASS_MODE=READ_ONLY_STATUS")
        return
    if argv[0]=="--disable":
        read_approval()
        updater.main(["--disable",updater.CONFIRM])
        print("ONEPASS_MODE=SIGNED_TIMER_DISABLED")
        return
    feed=load_helper(FEED)
    feed.main(["--inspect"])
    print("ONEPASS_SIGNED_FEED_PREFLIGHT=PASS")
    feed.main(["--apply",feed.CONFIRM])
    print("ONEPASS_SIGNED_FEED_PUBLISH=PASS")
    ensure_approval()
    print("ONEPASS_PRIVATE_OWNER_APPROVAL=PASS")
    updater.main(["--enable",updater.CONFIRM])
    print("ONEPASS_SIGNED_AGENT_AUTOMATION=ENABLED")
    print("GATEWAY_SUPERVISOR_WINDOWS_AUTOPROMOTION=NOT_ENABLED")

if __name__=="__main__":
    try:run(sys.argv[1:])
    except (OSError,ValueError,TypeError,KeyError,Block) as exc:
        reason=str(exc) if isinstance(exc,Block) else "UNCLASSIFIED"
        print("ONEPASS_SIGNED_AGENT=BLOCKED:"+reason)
        raise SystemExit(2)
