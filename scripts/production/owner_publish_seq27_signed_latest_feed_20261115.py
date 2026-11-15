#!/usr/bin/python3
"""KMJ TECHNO — owner-only signed27 latest-feed publication (CREATE ONLY).

Publishes two EXISTING owner-signed immutable release bytes to the pinned
static HTTPS origin as one directory entry. Never signs, downloads executable
code, modifies the updater, changes DNS/nginx/systemd or writes a backup.
No replace of a pre-existing latest feed; a future versioned publisher must
implement separately admitted atomic rollover with anti-rollback and canary.
"""
from __future__ import annotations
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

REV="40655678db7fa62edca28ccc4988614010253ef1"
SEQUENCE=27
ROOT=Path("/var/lib/kmj-codebridge-releases/stable")
SRC=ROOT/REV
DEST=ROOT/"latest"
CONFIG=Path("/etc/kmj-codebridge-update/stable-update.json")
NODE=Path("/opt/kmj-codebridge-node/bin/node")
ORIGIN="https://kmjtechno.com/codebridge/releases/stable"
MANIFEST_SHA="82100f7a8bf63c7b73671dfde040cef95d37f96bc7361ea53e0165a92f80996e"
ARCHIVE_SHA="81282d540021bbb4ab345f5c4f2aab639dd70eb8b4ff27202f6c68a46f29d77e"
ARCHIVE_SIZE=2171009
ARCHIVE="kmj-codebridge-0.3.2-40655678db7f.tar.gz"
KEY_ID="kmj-release-2026"
OWNER_SPKI_SHA="2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
CONFIRM="--confirm-owner-publish-signed27-feed"
SYS_RENAME_NOREPLACE=1

class Block(Exception):pass

def need(condition,code):
    if not condition:raise Block(code)

def ancestry(file):
    for parent in reversed(file.parents):
        try:s=os.lstat(parent)
        except OSError:raise Block("ROOT_PARENT_MISSING") from None
        need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
             and s.st_uid==0 and not s.st_mode&0o022,"ROOT_PARENT_UNTRUSTED")

def read_owned(file,limit,mode=None):
    ancestry(file)
    try:fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError:raise Block("FILE_UNAVAILABLE") from None
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==0
             and before.st_nlink==1 and 0<before.st_size<=limit
             and (before.st_mode&0o022)==0,"SOURCE_FILE_UNTRUSTED")
        if mode is not None:
            need(stat.S_IMODE(before.st_mode)==mode,"PROTECTED_CONFIG_MODE")
        data=bytearray()
        while len(data)<before.st_size:
            part=os.read(fd,before.st_size-len(data))
            need(bool(part),"SOURCE_FILE_CHANGED")
            data.extend(part)
        after=os.fstat(fd)
        need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,
              before.st_ctime_ns)==
             (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,
              after.st_ctime_ns),"SOURCE_FILE_CHANGED")
        return bytes(data)
    finally:os.close(fd)

def run(argv,input=None,limit=4096,timeout=25):
    try:
        p=subprocess.run(argv,input=input,stdout=subprocess.PIPE,
          stderr=subprocess.DEVNULL,timeout=timeout,
          env={"PATH":"/usr/bin:/bin","LC_ALL":"C"},check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise Block("PINNED_COMMAND_FAILED") from None
    need(p.returncode==0 and len(p.stdout)<=limit,"PINNED_COMMAND_FAILED")
    return p.stdout

def validate_manifest(raw):
    need(hashlib.sha256(raw).hexdigest()==MANIFEST_SHA,"SIGNED27_MANIFEST_SHA_MISMATCH")
    try:m=json.loads(raw)
    except (ValueError,UnicodeError):
        raise Block("SIGNED27_MANIFEST_INVALID") from None
    need(type(m) is dict and m.get("schema")==1
         and m.get("product")=="KMJ CodeBridge"
         and m.get("channel")=="stable"
         and type(m.get("sequence")) is int and m["sequence"]==SEQUENCE
         and m.get("revision")==REV and m.get("version")=="0.3.2"
         and m.get("keyId")==KEY_ID and m.get("nodeMajor")==24
         and m.get("archive")==f"{ORIGIN}/{REV}/{ARCHIVE}"
         and m.get("sha256")==ARCHIVE_SHA and m.get("bytes")==ARCHIVE_SIZE,
         "SIGNED27_MANIFEST_IDENTITY_MISMATCH")

def verify_signature(raw,sig,key):
    try:
        sigtext=sig.decode("ascii").strip()
        need(bool(re.fullmatch(r"[A-Za-z0-9_-]{86}",sigtext)),
             "SIGNED27_SIGNATURE_FORMAT")
    except UnicodeDecodeError:
        raise Block("SIGNED27_SIGNATURE_FORMAT") from None
    js=r"""
const fs=require('node:fs'),crypto=require('node:crypto');
const x=JSON.parse(fs.readFileSync(0,'utf8'));
const key=crypto.createPublicKey(x.key);
const fp=crypto.createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
const s=Buffer.from(x.sig,'base64url');
if(key.asymmetricKeyType!=='ed25519'||fp!==x.fp||s.length!==64
 ||s.toString('base64url')!==x.sig
 ||!crypto.verify(null,Buffer.from(x.manifest,'base64'),key,s))process.exit(2);
"""
    need(NODE.is_file() and not NODE.is_symlink(),"PINNED_NODE_UNTRUSTED")
    ancestry(NODE)
    n=os.lstat(NODE)
    need(n.st_uid==0 and not n.st_mode&0o022 and os.access(NODE,os.X_OK),
         "PINNED_NODE_UNTRUSTED")
    payload=json.dumps({"key":key,"fp":OWNER_SPKI_SHA,
                        "manifest":base64.b64encode(raw).decode(),
                        "sig":sigtext}).encode()
    run([str(NODE),"-e",js],input=payload,timeout=15)

def loaded_source():
    raw=read_owned(SRC/"release-manifest.json",65536)
    sig=read_owned(SRC/"release-manifest.sig",1024)
    validate_manifest(raw)
    h=hashlib.sha256()
    archive=SRC/ARCHIVE
    ancestry(archive)
    fd=os.open(archive,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==0
             and before.st_nlink==1 and before.st_size==ARCHIVE_SIZE
             and not before.st_mode&0o022,"SIGNED27_ARCHIVE_UNTRUSTED")
        total=0
        while True:
            chunk=os.read(fd,1048576)
            if not chunk:break
            total+=len(chunk)
            need(total<=ARCHIVE_SIZE,"SIGNED27_ARCHIVE_SIZE_DRIFT")
            h.update(chunk)
        after=os.fstat(fd)
        need(total==ARCHIVE_SIZE and
             (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,
              before.st_ctime_ns)==
             (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,
              after.st_ctime_ns),"SIGNED27_ARCHIVE_CHANGED")
    finally:os.close(fd)
    need(h.hexdigest()==ARCHIVE_SHA,"SIGNED27_ARCHIVE_SHA_MISMATCH")
    cfg=read_owned(CONFIG,65536,mode=0o600)
    try:
        obj=json.loads(cfg)
        need(type(obj) is dict and obj.get("schema")==1
             and obj.get("channel")=="stable"
             and type(obj.get("trustedKeys")) is dict,
             "OWNER_TRUST_CONFIG_INVALID")
        key=obj["trustedKeys"][KEY_ID]
        need(type(key) is str and "BEGIN PUBLIC KEY" in key
             and "PRIVATE KEY" not in key and len(key)<8192,
             "OWNER_PUBLIC_KEY_INVALID")
    except (ValueError,KeyError,TypeError):
        raise Block("OWNER_TRUST_CONFIG_INVALID") from None
    verify_signature(raw,sig,key)
    return {"release-manifest.json":raw,"release-manifest.sig":sig}

def https_exact(url,expected):
    need(url in (f"{ORIGIN}/{REV}/release-manifest.json",
                 f"{ORIGIN}/latest/release-manifest.json",
                 f"{ORIGIN}/latest/release-manifest.sig"),
         "PUBLIC_URL_NOT_PINNED")
    fetched=run(["/usr/bin/curl","-fsS","--proto","=https",
                 "--max-time","15","--connect-timeout","5",
                 "--max-filesize",str(len(expected)+1),url],
                 limit=len(expected)+1,timeout=22)
    need(fetched==expected,"PUBLIC_RELEASE_BYTES_MISMATCH")

def check_existing(blobs):
    if not os.path.lexists(DEST):return False
    ancestry(DEST)
    st=os.lstat(DEST)
    need(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)
         and st.st_uid==0 and not st.st_mode&0o022,
         "EXISTING_FEED_UNTRUSTED")
    need(set(os.listdir(DEST))==set(blobs),"EXISTING_FEED_CONTENTS_UNEXPECTED")
    for name,payload in blobs.items():
        need(read_owned(DEST/name,65536)==payload,
             "EXISTING_FEED_CONTENTS_UNEXPECTED")
    return True

def rename_noreplace(parent_fd,stage):
    import ctypes
    libc=ctypes.CDLL(None,use_errno=True)
    fn=getattr(libc,"renameat2",None)
    need(fn is not None,"ATOMIC_NOREPLACE_UNAVAILABLE")
    fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    fn.restype=ctypes.c_int
    rc=fn(parent_fd,stage.encode(),parent_fd,b"latest",SYS_RENAME_NOREPLACE)
    need(rc==0,"ATOMIC_NOREPLACE_FAILED")
    os.fsync(parent_fd)

def create_feed(blobs):
    ancestry(DEST)
    parent_fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        current=os.fstat(parent_fd)
        need(current.st_uid==0 and not current.st_mode&0o022,
             "STATIC_ROOT_UNTRUSTED")
        need(not os.path.lexists(DEST),"EXISTING_FEED_REVIEW_REQUIRED")
        stage=Path(tempfile.mkdtemp(prefix=".kmj-signed27-latest-",dir=ROOT))
        os.chmod(stage,0o755)
        stage_fd=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            for name,data in blobs.items():
                fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,
                           0o644,dir_fd=stage_fd)
                try:
                    os.fchmod(fd,0o644)
                    offset=0
                    while offset<len(data):
                        n=os.write(fd,data[offset:])
                        need(n>0,"FEED_STAGE_WRITE_FAILED")
                        offset+=n
                    os.fsync(fd)
                finally:os.close(fd)
            os.fsync(stage_fd)
            need({name:read_owned(stage/name,65536) for name in blobs}==blobs,
                 "FEED_STAGE_BYTES_DIFFER")
            need(not os.path.lexists(DEST),"EXISTING_FEED_REVIEW_REQUIRED")
            rename_noreplace(parent_fd,stage.name)
        finally:os.close(stage_fd)
    finally:os.close(parent_fd)

def main(argv):
    need(argv in ([],["--inspect"],["--apply",CONFIRM]),"UNEXPECTED_ARGUMENTS")
    need(os.geteuid()==0 and socket.gethostname().split(".")[0].lower()=="kmj-elite",
         "OWNER_ROOT_ELITE_REQUIRED")
    ancestry(ROOT/"x")
    blobs=loaded_source()
    https_exact(f"{ORIGIN}/{REV}/release-manifest.json",
                blobs["release-manifest.json"])
    already=check_existing(blobs)
    print("SIGNED27_FEED_SOURCE=OWNER_ED25519_AND_ARCHIVE_PASS")
    print("PUBLIC_IMMUTABLE_SEQ27_MANIFEST=EXACT_MATCH")
    if already:
        https_exact(f"{ORIGIN}/latest/release-manifest.json",
                    blobs["release-manifest.json"])
        https_exact(f"{ORIGIN}/latest/release-manifest.sig",
                    blobs["release-manifest.sig"])
        print("SIGNED_LATEST_FEED=ALREADY_PUBLISHED_VERIFIED")
        print("SERVICE_OR_CONFIG_MUTATION=NONE")
        return
    if argv!=["--apply",CONFIRM]:
        print("SIGNED_LATEST_FEED=READY_TO_CREATE_ONLY")
        print("SERVICE_OR_CONFIG_MUTATION=NONE")
        return
    create_feed(blobs)
    https_exact(f"{ORIGIN}/latest/release-manifest.json",
                blobs["release-manifest.json"])
    https_exact(f"{ORIGIN}/latest/release-manifest.sig",
                blobs["release-manifest.sig"])
    print("SIGNED_LATEST_FEED=CREATED_AND_PUBLIC_VERIFIED")
    print("SERVICE_OR_CONFIG_MUTATION=NONE")
    print("AUTO_UPDATE_TIMER=UNCHANGED")

if __name__=="__main__":
    try:main(sys.argv[1:])
    except (OSError,ValueError,TypeError,Block) as exc:
        allowed=str(exc) if isinstance(exc,Block) else "UNCLASSIFIED"
        print("SIGNED_LATEST_FEED=BLOCKED:"+allowed)
        raise SystemExit(2)
