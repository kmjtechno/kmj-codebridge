#!/usr/bin/python3
"""KMJ TECHNO signed latest-feed ROLLOVER, source-review only.

Owner-root, fixed static root, no arbitrary paths or shell, no service changes.
A future separately owner-admitted systemd timer may invoke --apply. This does
not sign or build releases; only already signed, fully immutable, public
archives may move the latest feed forward. A previous pair stays on disk.
"""
from __future__ import annotations
import base64
import ctypes
import fcntl
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

ROOT=Path("/var/lib/kmj-codebridge-releases/stable")
CONFIG=Path("/etc/kmj-codebridge-update/stable-update.json")
NODE=Path("/opt/kmj-codebridge-node/bin/node")
LATEST=ROOT/"latest"
LOCK=Path("/run/lock/kmj-codebridge-signed-latest-roll.lock")
ORIGIN="https://kmjtechno.com/codebridge/releases/stable"
PUBLIC_KEY_ID="kmj-release-2026"
OWNER_SPKI="2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
MAX_ARCHIVE=300_000_000
MAX_ENTRIES=256
RENAME_EXCHANGE=2
CONFIRM="--confirm-owner-signed-rolling-feed"

class Block(Exception):pass

def need(value, code):
    if not value:raise Block(code)

def trusted_parent_chain(file):
    for parent in reversed(file.parents):
        try:s=os.lstat(parent)
        except OSError:raise Block("TRUSTED_PARENT_MISSING") from None
        need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
             and s.st_uid==0 and not s.st_mode&0o022,"TRUSTED_PARENT_UNSAFE")

def regular_bytes(file,maxbytes,*,mode=None):
    trusted_parent_chain(file)
    try:fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError:raise Block("SOURCE_FILE_MISSING") from None
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==0
             and before.st_nlink==1 and 1<=before.st_size<=maxbytes
             and not before.st_mode&0o022, "SOURCE_FILE_UNTRUSTED")
        if mode is not None:need(stat.S_IMODE(before.st_mode)==mode,"PRIVATE_MODE_DRIFT")
        data=b""
        while len(data)<before.st_size:
            chunk=os.read(fd,before.st_size-len(data))
            need(bool(chunk),"SOURCE_FILE_CHANGED")
            data+=chunk
        after=os.fstat(fd)
        need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,
              before.st_ctime_ns)==
             (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,
              after.st_ctime_ns),"SOURCE_FILE_CHANGED")
        return data
    finally:os.close(fd)

def pinned_call(argv,*,input=None,maxstdout=65536,timeout=25):
    try:
        p=subprocess.run(argv,input=input,capture_output=True,timeout=timeout,
            env={"PATH":"/usr/bin:/bin","LC_ALL":"C"},check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise Block("PINNED_COMMAND_UNAVAILABLE") from None
    need(p.returncode==0 and len(p.stdout)<=maxstdout,"PINNED_COMMAND_FAILED")
    return p.stdout

def trusted_public_key():
    try:cfg=json.loads(regular_bytes(CONFIG,65536,mode=0o600))
    except (ValueError,UnicodeError):raise Block("TRUST_CONFIG_INVALID") from None
    need(type(cfg) is dict and cfg.get("schema")==1
         and cfg.get("channel")=="stable"
         and type(cfg.get("trustedKeys")) is dict
         and type(cfg["trustedKeys"].get(PUBLIC_KEY_ID)) is str,
         "TRUST_CONFIG_INVALID")
    key=cfg["trustedKeys"][PUBLIC_KEY_ID]
    need("BEGIN PUBLIC KEY" in key and "PRIVATE KEY" not in key and
         len(key)<=8192,"TRUST_PUBLIC_KEY_INVALID")
    return key

def verify_signature(manifest,signature,pub):
    try:sign=signature.decode("ascii").strip()
    except UnicodeError:raise Block("SIGNED_RELEASE_SIGNATURE_INVALID") from None
    need(bool(re.fullmatch(r"[A-Za-z0-9_-]{86}",sign)),
         "SIGNED_RELEASE_SIGNATURE_INVALID")
    trusted_parent_chain(NODE)
    try:st=os.lstat(NODE)
    except OSError:raise Block("PINNED_NODE_MISSING") from None
    need(stat.S_ISREG(st.st_mode) and st.st_uid==0
         and not st.st_mode&0o022 and os.access(NODE,os.X_OK),
         "PINNED_NODE_UNTRUSTED")
    js=r"""
const fs=require('node:fs'),c=require('node:crypto'),x=JSON.parse(fs.readFileSync(0,'utf8'));
const key=c.createPublicKey(x.pem);
const fp=c.createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
const sig=Buffer.from(x.sig,'base64url');
if(key.asymmetricKeyType!=='ed25519'||fp!==x.fp||sig.length!==64||
sig.toString('base64url')!==x.sig||!c.verify(null,Buffer.from(x.m,'base64'),key,sig))
process.exit(2);
"""
    payload=json.dumps({"pem":pub,"fp":OWNER_SPKI,"sig":sign,
                       "m":base64.b64encode(manifest).decode()}).encode()
    pinned_call([str(NODE),"-e",js],input=payload,maxstdout=0,timeout=15)

def parse_signed(raw,signature,rev,pub):
    try:m=json.loads(raw)
    except (ValueError,UnicodeError):raise Block("SIGNED_MANIFEST_INVALID") from None
    need(type(m) is dict and m.get("schema")==1
         and m.get("product")=="KMJ CodeBridge"
         and m.get("channel")=="stable"
         and m.get("keyId")==PUBLIC_KEY_ID
         and type(m.get("sequence")) is int and 1<=m["sequence"]<=100000
         and type(m.get("nodeMajor")) is int and m["nodeMajor"]==24
         and m.get("revision")==rev and
         re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+",str(m.get("version",""))) is not None
         and type(m.get("bytes")) is int and 1024<=m["bytes"]<=MAX_ARCHIVE
         and isinstance(m.get("sha256"),str)
         and re.fullmatch(r"[a-f0-9]{64}",m["sha256"]) is not None,
         "SIGNED_MANIFEST_IDENTITY_INVALID")
    filename=f"kmj-codebridge-{m['version']}-{rev[:12]}.tar.gz"
    need(m.get("archive")==f"{ORIGIN}/{rev}/{filename}",
         "SIGNED_ARCHIVE_ORIGIN_INVALID")
    verify_signature(raw,signature,pub)
    return m,filename

def read_pair(folder,pub,rev):
    need(re.fullmatch(r"[a-f0-9]{40}",rev)!=None,"RELEASE_DIRECTORY_NAME_INVALID")
    trusted_parent_chain(folder/"x")
    st=os.lstat(folder)
    need(stat.S_ISDIR(st.st_mode) and st.st_uid==0
         and not st.st_mode&0o022 and not stat.S_ISLNK(st.st_mode),
         "RELEASE_DIRECTORY_UNTRUSTED")
    need(set(os.listdir(folder))=={"release-manifest.json","release-manifest.sig"} or folder!=LATEST,
         "CURRENT_LATEST_UNEXPECTED_ENTRIES")
    manifest=regular_bytes(folder/"release-manifest.json",65536)
    signature=regular_bytes(folder/"release-manifest.sig",1024)
    info,archive=parse_signed(manifest,signature,rev,pub)
    return info,archive,{"release-manifest.json":manifest,
                         "release-manifest.sig":signature}

def validated_release(revision,pub):
    folder=ROOT/revision
    info,filename,blobs=read_pair(folder,pub,revision)
    archive=folder/filename
    trusted_parent_chain(archive)
    fd=os.open(archive,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==0
             and before.st_nlink==1 and not before.st_mode&0o022
             and before.st_size==info["bytes"],"SIGNED_ARCHIVE_FILE_UNTRUSTED")
        h=hashlib.sha256()
        total=0
        while True:
            part=os.read(fd,1048576)
            if not part:break
            total+=len(part)
            need(total<=info["bytes"],"SIGNED_ARCHIVE_SIZE_CHANGED")
            h.update(part)
        after=os.fstat(fd)
        need(total==info["bytes"] and
             (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,
              before.st_ctime_ns)==
             (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,
              after.st_ctime_ns),"SIGNED_ARCHIVE_CHANGED")
        need(h.hexdigest()==info["sha256"],"SIGNED_ARCHIVE_SHA_MISMATCH")
    finally:os.close(fd)
    return info,filename,blobs

def latest_current(pub):
    need(os.path.lexists(LATEST),"INITIAL_FEED_REQUIRES_SIGNED27_BOOTSTRAP")
    # Latest is a directory containing signed bytes; infer immutable revision
    # ONLY from signed manifest, then verify that claim cryptographically.
    raw=regular_bytes(LATEST/"release-manifest.json",65536)
    try:untrusted=json.loads(raw)
    except (ValueError,UnicodeError):raise Block("CURRENT_MANIFEST_INVALID") from None
    revision=untrusted.get("revision") if type(untrusted) is dict else None
    need(type(revision) is str and re.fullmatch(r"[a-f0-9]{40}",revision)!=None,
         "CURRENT_REVISION_INVALID")
    info,filename,blobs=read_pair(LATEST,pub,revision)
    return info,filename,blobs

def choose_candidate(pub):
    trusted_parent_chain(ROOT/"x")
    names=os.listdir(ROOT)
    need(len(names)<=MAX_ENTRIES,"RELEASE_ROOT_ENTRY_LIMIT")
    releases=[]
    for name in names:
        if re.fullmatch(r"[a-f0-9]{40}",name) is None:continue
        info,filename,blobs=validated_release(name,pub)
        releases.append((info["sequence"],name,info,filename,blobs))
    need(releases,"NO_IMMUTABLE_SIGNED_RELEASES")
    sequences=[r[0] for r in releases]
    need(len(sequences)==len(set(sequences)),"SIGNED_SEQUENCE_DUPLICATE")
    releases.sort(key=lambda t:t[0])
    return releases[-1]

def https_bytes(relative,expected,max_size=None):
    need(bool(re.fullmatch(r"(?:latest|[a-f0-9]{40})/"
                            r"(?:release-manifest\.json|release-manifest\.sig|"
                            r"kmj-codebridge-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}\.tar\.gz)",
                            relative)),"PUBLIC_RELATIVE_PATH_INVALID")
    limit=max_size if max_size is not None else len(expected)+1
    remote=pinned_call(["/usr/bin/curl","-fsS","--proto","=https",
                        "--max-time","45","--connect-timeout","5",
                        "--max-filesize",str(limit),
                        f"{ORIGIN}/{relative}"],
                       maxstdout=limit,timeout=50)
    need(remote==expected,"PUBLIC_SIGNED_BYTES_MISMATCH")

def public_archive(info,filename):
    path=f"{info['revision']}/{filename}"
    data=pinned_call(["/usr/bin/curl","-fsS","--proto","=https",
                      "--max-time","45","--connect-timeout","5",
                      "--max-filesize",str(info["bytes"]+1),
                      f"{ORIGIN}/{path}"],
                      maxstdout=info["bytes"]+1,timeout=50)
    need(len(data)==info["bytes"] and
         hashlib.sha256(data).hexdigest()==info["sha256"],
         "PUBLIC_ARCHIVE_HASH_MISMATCH")

def atomic_exchange(rootfd,stage):
    need(re.fullmatch(r"\.kmj-latest-roll-[A-Za-z0-9._-]{1,70}",stage)!=None,
         "EXCHANGE_STAGE_NAME_INVALID")
    libc=ctypes.CDLL(None,use_errno=True)
    fn=getattr(libc,"renameat2",None)
    need(fn is not None,"RENAME_EXCHANGE_UNAVAILABLE")
    fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    fn.restype=ctypes.c_int
    need(fn(rootfd,stage.encode(),rootfd,b"latest",RENAME_EXCHANGE)==0,
         "RENAME_EXCHANGE_FAILED")
    os.fsync(rootfd)

def stage_new(blobs):
    stage=Path(tempfile.mkdtemp(prefix=".kmj-latest-roll-",dir=ROOT))
    os.chmod(stage,0o755)
    fd=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name,content in blobs.items():
            dst=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                        0o644,dir_fd=fd)
            try:
                os.fchmod(dst,0o644)
                off=0
                while off<len(content):
                    written=os.write(dst,content[off:])
                    need(written>0,"STAGE_WRITE_SHORT")
                    off+=written
                os.fsync(dst)
            finally:os.close(dst)
        os.fsync(fd)
    finally:os.close(fd)
    return stage.name

def lock_owner():
    trusted_parent_chain(LOCK)
    fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        st=os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid==0
             and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o600,
             "FEED_LOCK_UNTRUSTED")
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Block("FEED_LOCK_HELD") from None
        return fd
    except BaseException:
        os.close(fd)
        raise

def roll_once(pub,current,candidate):
    _,revision,info,filename,blobs=candidate
    oldblobs=current[2]
    # Fixed per-invocation lock admits one writer. A partially staged
    # directory stays for owner audit, never silently deleted.
    lockfd=lock_owner()
    try:
        again=latest_current(pub)
        need(again[0]["sequence"]==current[0]["sequence"] and
             again[2]==oldblobs,"LATEST_CHANGED_AFTER_PREFLIGHT")
        stage=stage_new(blobs)
        rootfd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            atomic_exchange(rootfd,stage)
            need(latest_current(pub)[2]==blobs,"LATEST_POSTSWAP_BYTES_DRIFT")
            try:
                https_bytes("latest/release-manifest.json",blobs["release-manifest.json"])
                https_bytes("latest/release-manifest.sig",blobs["release-manifest.sig"])
            except Block:
                # Restore prior signed feed only if neither side drifted;
                # the staged previous pair is preserved, never deleted.
                valid_old=(regular_bytes(ROOT/stage/"release-manifest.json",65536)==
                           oldblobs["release-manifest.json"] and
                           regular_bytes(ROOT/stage/"release-manifest.sig",1024)==
                           oldblobs["release-manifest.sig"])
                if valid_old and latest_current(pub)[2]==blobs:
                    atomic_exchange(rootfd,stage)
                    need(latest_current(pub)[2]==oldblobs,
                         "SIGNED_FEED_ROLLBACK_UNPROVEN")
                    raise Block("PUBLIC_READBACK_FAILED_PREVIOUS_FEED_RESTORED") from None
                raise Block("PUBLIC_READBACK_FAILED_OWNER_REVIEW_REQUIRED") from None
        finally:os.close(rootfd)
    finally:os.close(lockfd)
    print("SIGNED_LATEST_FEED=ADVANCED_SEQ_"+str(info["sequence"]))
    print("PREVIOUS_SIGNED_PAIR=PRESERVED")
    print("PRODUCTION_SERVICE_MUTATION=NONE")

def main(argv):
    need(argv in ([],["--inspect"],["--apply",CONFIRM]),"UNEXPECTED_ARGUMENTS")
    need(os.geteuid()==0 and socket.gethostname().split(".")[0].lower()=="kmj-elite",
         "OWNER_ROOT_ELITE_REQUIRED")
    pub=trusted_public_key()
    current=latest_current(pub)
    candidate=choose_candidate(pub)
    _,revision,info,filename,blobs=candidate
    need(info["sequence"]>=27,"SEQ27_MINIMUM_NOT_MET")
    need(info["sequence"]>=current[0]["sequence"],"SIGNED_SEQUENCE_ROLLBACK")
    if info["sequence"]==current[0]["sequence"]:
        need(current[0]["revision"]==revision and current[2]==blobs,
             "SIGNED_SEQUENCE_EQUIVOCATION")
        https_bytes("latest/release-manifest.json",blobs["release-manifest.json"])
        https_bytes("latest/release-manifest.sig",blobs["release-manifest.sig"])
        print("SIGNED_LATEST_FEED=ALREADY_CURRENT")
        print("PRODUCTION_SERVICE_MUTATION=NONE")
        return
    https_bytes(f"{revision}/release-manifest.json",blobs["release-manifest.json"])
    https_bytes(f"{revision}/release-manifest.sig",blobs["release-manifest.sig"])
    public_archive(info,filename)
    print("OWNER_SIGNED_CANDIDATE=VERIFIED")
    print("SIGNED_SEQUENCE_ADVANCE="+str(info["sequence"]))
    if argv!=["--apply",CONFIRM]:
        print("SIGNED_LATEST_FEED=DRY_RUN_UNCHANGED")
        return
    roll_once(pub,current,candidate)

if __name__=="__main__":
    try:main(sys.argv[1:])
    except (OSError,ValueError,TypeError,KeyError,Block) as exc:
        code=str(exc) if isinstance(exc,Block) else "UNCLASSIFIED"
        print("SIGNED_LATEST_FEED=BLOCKED:"+code)
        raise SystemExit(2)
