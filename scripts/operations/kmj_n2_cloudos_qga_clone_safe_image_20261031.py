#!/usr/bin/env python3
"""Make a clone-safe *new* QGA-prepared Ubuntu qcow2 without modifying the original.

Dedicated existing KMJ GCE N2 test VM. Runs a single isolated KVM guest using
QEMU user-mode networking with restrict=on and no host port forwards. Uses QGA
guest-exec cloud-init clean --machine-id, verifies uninitialized machine-id,
shuts down, then converts disposable overlay to standalone new test image.
"""
from __future__ import annotations
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time

HOST = "kmj-cloudos-kvm-test"
ROOT = Path("/var/lib/libvirt/images/kmj-cloudos-ci")
BASE = ROOT / "qga-prepared.qcow2"
BASE_REPORT = ROOT / "guest-qga-offline-20261031-v1/report.json"
OUT = ROOT / "qga-clone-sanitized-20261031-v1.qcow2"
WORK = ROOT / "guest-identity-sanitize-20261031-v1"
CODE = Path("/usr/share/OVMF/OVMF_CODE_4M.fd")
VARS = Path("/usr/share/OVMF/OVMF_VARS_4M.fd")
def digest(path: Path):
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
def cmd(*argv, timeout=25):
    p = subprocess.run(list(argv), text=True, capture_output=True, timeout=timeout, check=False)
    if p.returncode:
        raise RuntimeError("COMMAND_FAILED_" + argv[0] + ":" + (p.stderr or p.stdout)[:200].splitlines()[0])
    return p.stdout
def ga(sock:Path, execute:str, arguments=None):
    command={"execute":execute}
    if arguments is not None:command["arguments"]=arguments
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(8)
        s.connect(str(sock))
        s.sendall((json.dumps(command,separators=(",",":"))+"\n").encode())
        buf=b""
        while b"\n" not in buf and len(buf)<65536:
            block=s.recv(4096)
            if not block:break
            buf+=block
    if b"\n" not in buf:raise RuntimeError("QGA_INCOMPLETE_REPLY")
    reply=json.loads(buf.split(b"\n",1)[0])
    if not isinstance(reply,dict) or "error" in reply or "return" not in reply:
        raise RuntimeError("QGA_ERROR_"+execute)
    return reply["return"]
def exec_guest(sock:Path, program:str, args:list[str], timeout:int=60):
    data=ga(sock,"guest-exec",{"path":program,"arg":args,"capture-output":True})
    pid=data.get("pid") if isinstance(data,dict) else None
    if not isinstance(pid,int) or pid<=0:raise RuntimeError("GUEST_EXEC_MISSING_PID")
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        status=ga(sock,"guest-exec-status",{"pid":pid})
        if status.get("exited"):
            output=base64.b64decode(status.get("out-data") or "",validate=True)
            error=base64.b64decode(status.get("err-data") or "",validate=True)
            if len(output)>8192 or len(error)>8192:raise RuntimeError("GUEST_OUTPUT_TOO_LARGE")
            if status.get("exitcode") != 0:raise RuntimeError("GUEST_COMMAND_FAILED_"+program)
            return output.decode("utf8","replace").strip()
        time.sleep(1)
    raise RuntimeError("GUEST_EXEC_TIMEOUT_"+program)
def on_term(sig,frame):
    raise TimeoutError("EXTERNAL_STOP_REQUESTED")
signal.signal(signal.SIGTERM,on_term)
def main():
    print("KMJ_N2_QGA_CLONE_SAFE_IMAGE_PREPARATION_V1",flush=True)
    print("SCOPE=ORIGINAL_QCOW2_IMMUTABLE_ONE_DISPOSABLE_QEMU_NO_HOST_PORTS",flush=True)
    if os.geteuid()!=0 or os.uname().nodename.split(".")[0]!=HOST:
        raise RuntimeError("UNAUTHORIZED_HOST")
    if not Path("/dev/kvm").is_char_device():raise RuntimeError("KVM_MISSING")
    for f in (BASE,BASE_REPORT,CODE,VARS):
        if not f.is_file() or f.is_symlink():raise RuntimeError("UNSAFE_INPUT_"+f.name)
    if not ROOT.is_dir() or ROOT.is_symlink():raise RuntimeError("UNSAFE_ROOT")
    if OUT.exists() or OUT.is_symlink() or WORK.exists() or WORK.is_symlink():
        raise RuntimeError("EXISTING_SANITIZED_OUTPUT_REVIEW_REQUIRED")
    if shutil.disk_usage(ROOT).free<6*1024**3:raise RuntimeError("INSUFFICIENT_DISK")
    r=json.loads(BASE_REPORT.read_text())
    if r.get("status")!="PASS" or r.get("guest_agent") is not True or r.get("clean_shutdown") is not True:
        raise RuntimeError("PREPARED_REPORT_NOT_PASS")
    old_sha=digest(BASE)
    if old_sha != r.get("prepared_image_sha256"):raise RuntimeError("PREPARED_QCOW2_DIGEST_MISMATCH")
    info=json.loads(cmd("qemu-img","info","--output=json","-f","qcow2",str(BASE)))
    if info.get("format")!="qcow2" or info.get("backing-filename"):raise RuntimeError("ORIGINAL_NOT_STANDALONE_QCOW2")
    if cmd("virsh","-c","qemu:///system","list","--all","--name").strip():
        raise RuntimeError("OTHER_LIBVIRT_DOMAINS_PRESENT")
    for tool in ("qemu-system-x86_64","qemu-img"):
        if not shutil.which(tool):raise RuntimeError("REQUIRED_BINARY_MISSING_"+tool)
    print("ORIGINAL_IMAGE_AND_EMPTY_HOST=VERIFIED",flush=True)
    WORK.mkdir(mode=0o700)
    overlay=WORK/"guest-overlay.qcow2"
    varsfile=WORK/"OVMF_VARS_4M.fd"
    sock=WORK/"qga.sock"
    console=WORK/"console.log"
    stderr=WORK/"qemu.log"
    report=WORK/"report.json"
    data={"schema":"kmj.cloudos.n2.clonesafe.v1","status":"FAIL",
          "source_sha256":old_sha,"original_unchanged":False,
          "guest_agent":False,"clean_shutdown":False,
          "prepared_image_sha256":None,"release_gate_credit":False}
    proc=None
    start=time.monotonic()
    try:
        cmd("qemu-img","create","-f","qcow2","-F","qcow2","-b",str(BASE),str(overlay))
        shutil.copyfile(VARS,varsfile)
        args=["qemu-system-x86_64","-accel","kvm","-machine","q35","-cpu","host",
              "-smp","2","-m","1536","-no-user-config","-nodefaults",
              "-drive",f"file={overlay},format=qcow2,if=virtio",
              "-netdev","user,id=net0,restrict=on",
              "-device","virtio-net-pci,netdev=net0",
              "-device","virtio-serial-pci",
              "-chardev",f"socket,id=qga,path={sock},server=on,wait=off",
              "-device","virtserialport,chardev=qga,name=org.qemu.guest_agent.0",
              "-drive",f"if=pflash,format=raw,unit=0,readonly=on,file={CODE}",
              "-drive",f"if=pflash,format=raw,unit=1,file={varsfile}",
              "-display","none","-monitor","none","-serial",f"file:{console}",
              "-no-reboot"]
        with stderr.open("wb") as log:
            proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            print("SANITIZER_GUEST_BOOT=STARTED",flush=True)
            deadline=time.monotonic()+300
            while time.monotonic()<deadline:
                if proc.poll() is not None:raise RuntimeError("QEMU_EARLY_EXIT")
                if sock.exists():
                    try:
                        ga(sock,"guest-ping")
                        osinfo=ga(sock,"guest-get-osinfo")
                        if isinstance(osinfo,dict) and osinfo.get("id","").lower()=="ubuntu":break
                    except (OSError,RuntimeError,ValueError,KeyError,json.JSONDecodeError):
                        pass
                time.sleep(3)
            else:raise RuntimeError("QGA_BOOT_TIMEOUT")
            print("GUEST_QGA_AND_UBUNTU_ID=PASS",flush=True)
            data["guest_agent"]=True
            before=exec_guest(sock,"/usr/bin/cat",["/etc/machine-id"])
            if len(before)!=32 or any(c not in "0123456789abcdef" for c in before):
                raise RuntimeError("PRE_SANITIZE_MACHINE_ID_UNEXPECTED")
            data["before_machine_id_digest"]=hashlib.sha256(before.encode()).hexdigest()[:16]
            print("BEFORE_MACHINE_ID=POPULATED_FINGERPRINT_ONLY",flush=True)
            exec_guest(sock,"/usr/bin/cloud-init",["clean","--machine-id"],timeout=100)
            after=exec_guest(sock,"/usr/bin/cat",["/etc/machine-id"])
            if after!="uninitialized":raise RuntimeError("MACHINE_ID_CLEAN_VERIFICATION_FAILED")
            print("CLOUD_INIT_CLEAN_MACHINE_ID=PASS",flush=True)
            data["machine_id_uninitialized"]=True
            # Guest shutdown returns no guaranteed QGA reply.
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
                channel.settimeout(6)
                channel.connect(str(sock))
                channel.sendall(b'{"execute":"guest-shutdown","arguments":{"mode":"powerdown"}}\n')
            proc.wait(timeout=120)
            if proc.returncode!=0:raise RuntimeError("GUEST_SHUTDOWN_EXIT_NONZERO")
            data["clean_shutdown"]=True
            print("GUEST_CLEAN_SHUTDOWN=PASS",flush=True)
            interim=WORK/"sanitized-standalone.qcow2"
            cmd("qemu-img","convert","-f","qcow2","-O","qcow2",str(overlay),str(interim),timeout=240)
            inf=json.loads(cmd("qemu-img","info","-f","qcow2","--output=json",str(interim)))
            if inf.get("format")!="qcow2" or inf.get("backing-filename"):
                raise RuntimeError("SANITIZED_DISK_NOT_STANDALONE")
            os.chmod(interim,0o644)
            if OUT.exists() or OUT.is_symlink():raise RuntimeError("SANITIZED_OUTPUT_SLOT_CONFLICT")
            os.rename(interim,OUT)
            data["prepared_image_sha256"]=digest(OUT)
            data["original_unchanged"]=digest(BASE)==old_sha
            if not data["original_unchanged"]:raise RuntimeError("ORIGINAL_BASE_HASH_CHANGED")
            data["status"]="PASS"
            data["duration_seconds"]=round(time.monotonic()-start,2)
            print("ORIGINAL_BASE_UNCHANGED=PASS",flush=True)
            print("SANITIZED_STANDALONE_QCOW2=PASS",flush=True)
            print("SANITIZED_IMAGE="+str(OUT),flush=True)
            print("SANITIZED_IMAGE_SHA256="+data["prepared_image_sha256"],flush=True)
            print("RESULT=QGA_CLONE_SAFE_IMAGE_PREPARED_PASS",flush=True)
    except Exception as exc:
        data["failure_code"]=type(exc).__name__+":"+str(exc)[:160]
        print("RESULT=QGA_CLONE_SAFE_IMAGE_PREPARATION_FAILED",flush=True)
        print("FAILURE="+data["failure_code"],flush=True)
        for label,path in (("CONSOLE",console),("QEMU",stderr)):
            if path.exists():
                lines=path.read_text(errors="replace").splitlines()
                print(label+"_TAIL_BEGIN")
                for line in lines[-12:]:print(line[:160])
                print(label+"_TAIL_END")
    finally:
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid,signal.SIGTERM)
                proc.wait(timeout=20)
            except (ProcessLookupError,subprocess.TimeoutExpired):
                try:os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                try:proc.wait(timeout=6)
                except subprocess.TimeoutExpired:pass
        data["release_gate_credit"]=False
        report.write_text(json.dumps(data,indent=2,sort_keys=True)+"\n")
        report.chmod(0o600)
        print("REPORT="+str(report),flush=True)
        print("STATUS="+data["status"],flush=True)
        print("RECEIPT_COMPLETE=YES",flush=True)
    return 0 if data["status"]=="PASS" else 6
if __name__=="__main__":
    try:raise SystemExit(main())
    except Exception as e:
        print("RESULT=QGA_CLONE_SAFE_GUARD_BLOCKED")
        print("FAILURE="+type(e).__name__+":"+str(e)[:160])
        raise SystemExit(7)
