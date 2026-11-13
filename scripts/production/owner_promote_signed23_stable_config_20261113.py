#!/usr/bin/env python3
"""Promote only CodeBridge signed-stable manifest URLs, root-only and fail-closed.

No service start, gateway cutover, key mutation, or implicit activation.
"""
import base64
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys
import tempfile

CONFIG = pathlib.Path("/etc/kmj-codebridge-update/stable-update.json")
OLD = "0bf9b3cc0c1ffb7555540ec66f1e26ec517bd624"
NEW = "37a6627bff6435a29d6b2863a0304db6e41a680b"
BASE = "https://kmjtechno.com/codebridge/releases/stable/"
ARCHIVE = "kmj-codebridge-0.3.2-37a6627bff64.tar.gz"
ARCHIVE_SHA = "e0df580b809cf8d899b0b0dc59ebc5609da986f3fd89603381f6a72ae5279b71"
ARCHIVE_SIZE = 2118065
MANIFEST_SHA = "905e67da971722c087e88fee100bdaed7e0b7acf30202aeba91ea80aeeb18bfc"
KEY_FINGERPRINT = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"
NODE = "/opt/kmj-codebridge-node/bin/node"
UNIT = "kmj-codebridge-stable-update.service"
BACKUP = CONFIG.with_name("stable-update.before-signed23.json")

def guard(condition, error):
    if not condition:
        raise ValueError(error)

def expected_url(revision, name):
    return BASE + revision + "/" + name

def verify_config(config):
    guard(type(config) is dict and config.get("schema") == 1
          and config.get("channel") == "stable", "UPDATE_CONFIG_SCHEMA_INVALID")
    keys = config.get("trustedKeys")
    guard(type(keys) is dict and type(keys.get("kmj-release-2026")) is str,
          "OWNER_TRUST_MISSING")
    fields = ("manifestUrl", "signatureUrl")
    urls = [config.get(k) for k in fields]
    old = [expected_url(OLD,"release-manifest.json"), expected_url(OLD,"release-manifest.sig")]
    new = [expected_url(NEW,"release-manifest.json"), expected_url(NEW,"release-manifest.sig")]
    guard(urls in (old,new), "UPDATE_CONFIG_URL_DRIFT")
    return urls == new

def updated_config(config):
    already = verify_config(config)
    next_config = dict(config)
    next_config["manifestUrl"] = expected_url(NEW,"release-manifest.json")
    next_config["signatureUrl"] = expected_url(NEW,"release-manifest.sig")
    guard(set(next_config) == set(config)
          and all(next_config[k] == config[k] for k in config if k not in ("manifestUrl","signatureUrl")),
          "CONFIG_FIELD_DRIFT")
    return next_config, already

def protected_file():
    for entry in (pathlib.Path("/"), pathlib.Path("/etc"), CONFIG.parent):
        st=os.lstat(entry)
        guard(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and
              (st.st_mode & 0o022) == 0, "CONFIG_PARENT_UNSAFE")
    fd = os.open(CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        guard(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
              and st.st_size >= 100 and st.st_size < 65536 and
              (st.st_mode & 0o077) == 0, "CONFIG_FILE_UNSAFE")
        data = os.read(fd, 65537)
        guard(len(data) == st.st_size, "CONFIG_INCOMPLETE")
        again = os.fstat(fd)
        guard((st.st_ino,st.st_dev,st.st_size,st.st_mtime_ns,st.st_ctime_ns)==
              (again.st_ino,again.st_dev,again.st_size,again.st_mtime_ns,again.st_ctime_ns),
              "CONFIG_RACE")
        return data, st
    finally:
        os.close(fd)

def check_unit_idle():
    p = subprocess.run(["systemctl","show",UNIT,"-p",
           "LoadState","-p","ActiveState","-p","Result","-p","NeedDaemonReload"],
           capture_output=True, text=True, timeout=15)
    guard(p.returncode == 0, "SIGNED_UNIT_UNVERIFIED")
    props = dict(line.split("=",1) for line in p.stdout.splitlines() if "=" in line)
    guard(props.get("LoadState") == "loaded"
          and props.get("ActiveState") == "inactive"
          and props.get("Result") == "success"
          and props.get("NeedDaemonReload") == "no",
          "SIGNED_UNIT_NOT_IDLE")

def bounded_https(url, dest, maxbytes):
    p = subprocess.run(["curl","-fLSs","--retry","2","--max-time","75",
        "--max-filesize",str(maxbytes),"--proto","=https","--proto-redir","=https",
        url,"-o",str(dest)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=90)
    guard(p.returncode == 0,"NEW_PUBLIC_ASSET_UNREACHABLE")
    data=dest.read_bytes()
    guard(len(data) <= maxbytes,"NEW_PUBLIC_ASSET_OVERSIZE")
    return data

def verify_public_signature(key, manifest, signature):
    script = """
const fs=require('node:fs'),crypto=require('node:crypto');
const x=JSON.parse(fs.readFileSync(0,'utf8'));
const pub=crypto.createPublicKey(x.pub);
const digest=crypto.createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex');
if(pub.asymmetricKeyType!=='ed25519'||digest!==x.fingerprint||
!crypto.verify(null,Buffer.from(x.data,'base64'),pub,Buffer.from(x.sig,'base64url')))process.exit(2);
"""
    payload=json.dumps({"pub":key,"data":base64.b64encode(manifest).decode(),
                        "sig":signature.decode("ascii").strip(),"fingerprint":KEY_FINGERPRINT})
    p=subprocess.run([NODE,"-e",script],input=payload,text=True,
                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    guard(p.returncode == 0,"SIGNED23_ELITE_TRUST_FAILED")

def check_public(config):
    with tempfile.TemporaryDirectory(prefix="kmj-validate23-",dir="/root") as td:
        root=pathlib.Path(td)
        manifest=bounded_https(expected_url(NEW,"release-manifest.json"),root/"manifest",65536)
        signature=bounded_https(expected_url(NEW,"release-manifest.sig"),root/"signature",1024)
        archive=bounded_https(expected_url(NEW,ARCHIVE),root/"archive",2097152)
    guard(hashlib.sha256(manifest).hexdigest() == MANIFEST_SHA,"SIGNED23_MANIFEST_HASH")
    guard(len(archive)==ARCHIVE_SIZE and hashlib.sha256(archive).hexdigest()==ARCHIVE_SHA,
          "SIGNED23_ARCHIVE_HASH")
    item=json.loads(manifest)
    guard(item.get("schema")==1 and item.get("product")=="KMJ CodeBridge"
          and item.get("channel")=="stable" and item.get("sequence")==23
          and item.get("version")=="0.3.2" and item.get("revision")==NEW
          and item.get("keyId")=="kmj-release-2026"
          and item.get("nodeMajor")==24 and item.get("bytes")==ARCHIVE_SIZE
          and item.get("sha256")==ARCHIVE_SHA
          and item.get("archive")==expected_url(NEW,ARCHIVE), "SIGNED23_METADATA_INVALID")
    verify_public_signature(config["trustedKeys"]["kmj-release-2026"],manifest,signature)
    print("SIGNED23_ORIGIN_AND_TRUST=PASS")

def write_config(original, current_st, next_config):
    # A preexisting backup is never overwritten or silently trusted.
    guard(not os.path.lexists(BACKUP), "EXISTING_BACKUP_REQUIRES_REVIEW")
    encoded=(json.dumps(next_config,indent=2,ensure_ascii=False)+"\n").encode()
    backup_fd=os.open(BACKUP,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(backup_fd,0o600)
        with os.fdopen(backup_fd,"wb",closefd=False) as dest:
            dest.write(original)
            dest.flush()
            os.fsync(backup_fd)
    finally:
        os.close(backup_fd)
    print("CONFIG_BACKUP=CREATED_PRIVATE")
    # If the config was concurrently edited, abort without replacing it.
    new_original, again=protected_file()
    guard(new_original==original and
          (again.st_ino,again.st_dev,again.st_mtime_ns)==
          (current_st.st_ino,current_st.st_dev,current_st.st_mtime_ns),
          "CONFIG_CHANGED_BEFORE_REPLACE")
    tmp_fd,tmp_path=tempfile.mkstemp(prefix=".stable-update.seq23-",dir=CONFIG.parent)
    try:
        os.fchmod(tmp_fd,0o600)
        with os.fdopen(tmp_fd,"wb",closefd=False) as dest:
            dest.write(encoded)
            dest.flush()
            os.fsync(tmp_fd)
        os.close(tmp_fd)
        tmp_fd=-1
        os.replace(tmp_path,CONFIG)
        directory_fd=os.open(CONFIG.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    finally:
        if tmp_fd >= 0: os.close(tmp_fd)
        if os.path.lexists(tmp_path): os.unlink(tmp_path)
    after,_=protected_file()
    guard(json.loads(after)==next_config,"CONFIG_PERSISTENCE_MISMATCH")

def main():
    guard(os.geteuid()==0 and socket.gethostname().split(".")[0].lower()=="kmj-elite",
          "OWNER_HOST_MISMATCH")
    guard(sys.argv[1:] in ([],["--apply"]),"ARGUMENTS_NOT_ALLOWED")
    guard(pathlib.Path(NODE).is_file() and os.access(NODE,os.X_OK),"NODE24_UNAVAILABLE")
    check_unit_idle()
    data,st=protected_file()
    cfg=json.loads(data)
    updated,already=updated_config(cfg)
    check_public(cfg)
    print("SIGNED23_CONFIG_FIELDS=ONLY_TWO_URLS")
    if already:
        print("CONFIG_PROMOTION=ALREADY_MATCH")
        return
    if not sys.argv[1:]:
        print("CONFIG_PROMOTION=DRY_RUN_UNCHANGED")
        return
    write_config(data,st,updated)
    print("CONFIG_PROMOTION=PASS")
    print("STABLE_UPDATER=NOT_TRIGGERED")
    print("GATEWAY_SWITCH=NOT_ATTEMPTED")

if __name__=="__main__":
    try: main()
    except Exception as exc:
        safe={"OWNER_HOST_MISMATCH","ARGUMENTS_NOT_ALLOWED","NODE24_UNAVAILABLE",
              "SIGNED_UNIT_UNVERIFIED","SIGNED_UNIT_NOT_IDLE","CONFIG_PARENT_UNSAFE",
              "CONFIG_FILE_UNSAFE","CONFIG_INCOMPLETE","CONFIG_RACE",
              "UPDATE_CONFIG_SCHEMA_INVALID","OWNER_TRUST_MISSING","UPDATE_CONFIG_URL_DRIFT",
              "CONFIG_FIELD_DRIFT","NEW_PUBLIC_ASSET_UNREACHABLE","NEW_PUBLIC_ASSET_OVERSIZE",
              "SIGNED23_ELITE_TRUST_FAILED","SIGNED23_MANIFEST_HASH","SIGNED23_ARCHIVE_HASH",
              "SIGNED23_METADATA_INVALID","EXISTING_BACKUP_REQUIRES_REVIEW",
              "CONFIG_CHANGED_BEFORE_REPLACE","CONFIG_PERSISTENCE_MISMATCH"}
        print("CONFIG_PROMOTION=BLOCKED")
        print("REASON="+(str(exc) if str(exc) in safe else "UNCLASSIFIED"))
        sys.exit(2)
