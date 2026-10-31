#!/usr/bin/env python3
"""KVM/OVMF-only offline QGA prep on dedicated KMJ CloudOS GCE N2 test node.

No network port forwards, no GCE operations, no libvirt mutations, no base image
writes. Creates a fresh disposable qcow2 overlay and NoCloud ISO. On genuine
guest QGA/OS/IPv4 and clean shutdown it atomically stages a prepared qcow2.
Never reports production-ready. Failure preserves bounded debug evidence.
"""
import argparse
import hashlib
import ipaddress
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
BASE = ROOT / "base.qcow2"
PREPARED = ROOT / "qga-prepared.qcow2"
BASE_SHA = "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94"
QGA = Path("/home/info_kmjtechno_com/kmj_cloudos_guest_tools_20261031/qemu-guest-agent_8.2.2+ds-0ubuntu1.18_amd64.deb")
QGA_SHA = "62abf54bf34fed34dc65cbd973b4b6b6f4685fef30fbaa3fb3e8865e957fda75"
CODE = Path("/usr/share/OVMF/OVMF_CODE_4M.fd")
VARS = Path("/usr/share/OVMF/OVMF_VARS_4M.fd")

def run(*argv, timeout=20, **kwargs):
    return subprocess.run(argv, check=True, timeout=timeout, text=True, capture_output=True, **kwargs)

def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()

def package(path, name):
    r = run("dpkg-deb", "-f", str(path), "Package", timeout=8)
    if r.stdout.strip() != name: raise ValueError("INVALID_DEB_" + name)
    r = run("dpkg-deb", "-f", str(path), "Architecture", timeout=8)
    if r.stdout.strip() != "amd64": raise ValueError("PACKAGE_ARCH_INVALID_" + name)

def qga(socketpath, cmd):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(3)
        s.connect(str(socketpath))
        s.sendall((json.dumps({"execute": cmd}) + "\n").encode("ascii"))
        buf = b""
        while b"\n" not in buf and len(buf) < 32768:
            part = s.recv(4096)
            if not part: break
            buf += part
    if b"\n" not in buf: raise RuntimeError("INCOMPLETE_QGA_REPLY")
    obj = json.loads(buf.split(b"\n", 1)[0])
    if not isinstance(obj, dict) or "return" not in obj or "error" in obj:
        raise RuntimeError("QGA_REPLY_ERROR")
    return obj["return"]

def guestip(values):
    for iface in values if isinstance(values, list) else []:
        for item in iface.get("ip-addresses", []) if isinstance(iface, dict) else []:
            if not isinstance(item, dict) or item.get("ip-address-type") != "ipv4": continue
            try: ip = ipaddress.ip_address(item.get("ip-address", ""))
            except ValueError: continue
            if ip.version == 4 and not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified):
                return str(ip)
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uring-deb", required=True, type=Path)
    ap.add_argument("--uring-sha256", required=True)
    ap.add_argument("--max-wait", type=int, default=540)
    a = ap.parse_args()
    print("KMJ_CLOUDOS_N2_REAL_KVM_OFFLINE_QGA_PREP_V1", flush=True)
    print("SCOPE=ONE_DISPOSABLE_QEMU_NO_HOST_PORTS_NO_CUSTOMER_DOMAIN", flush=True)
    if not 120 <= a.max_wait <= 660: raise ValueError("INVALID_TIMEOUT")
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0] != HOST: raise ValueError("WRONG_HOST_OR_USER")
    if not Path("/dev/kvm").is_char_device(): raise ValueError("KVM_DEVICE_UNAVAILABLE")
    for path in (BASE, QGA, CODE, VARS, a.uring_deb):
        if path.is_symlink() or not path.is_file(): raise ValueError("REQUIRED_FILE_MISSING_OR_SYMLINK: " + path.name)
    if not ROOT.is_dir() or ROOT.is_symlink(): raise ValueError("UNSAFE_STORAGE")
    if PREPARED.exists() or PREPARED.is_symlink(): raise ValueError("PREPARED_IMAGE_ALREADY_EXISTS")
    if sha(BASE) != BASE_SHA: raise ValueError("BASE_IMAGE_SHA_MISMATCH")
    if sha(QGA) != QGA_SHA: raise ValueError("QGA_DEB_SHA_MISMATCH")
    if len(a.uring_sha256) != 64 or sha(a.uring_deb) != a.uring_sha256: raise ValueError("URING_SHA_MISMATCH")
    package(QGA, "qemu-guest-agent")
    package(a.uring_deb, "liburing2")
    if shutil.disk_usage(ROOT).free < 8 * (1024 ** 3): raise ValueError("DISK_HEADROOM_TOO_SMALL")
    domains = run("virsh", "-c", "qemu:///system", "list", "--all", "--name", timeout=12).stdout.strip()
    if domains: raise ValueError("EXISTING_DOMAINS_PRESENT")
    for tool in ("qemu-img", "genisoimage", "qemu-system-x86_64"):
        if not shutil.which(tool): raise ValueError("MISSING_TOOL_" + tool)
    print("INPUTS_AND_ISOLATION=PASS", flush=True)

    work = ROOT / "guest-qga-offline-20261031-v1"
    if work.exists() or work.is_symlink(): raise ValueError("WORKDIR_EXISTS_REQUIRES_REVIEW")
    work.mkdir(mode=0o700)
    overlay = work / "guest.qcow2"
    seed = work / "seed.iso"
    socketpath = work / "qga.sock"
    console = work / "console.log"
    qemulog = work / "qemu.log"
    report = work / "report.json"
    (work / "agent.deb").write_bytes(QGA.read_bytes())
    (work / "uring.deb").write_bytes(a.uring_deb.read_bytes())
    if sha(work / "agent.deb") != QGA_SHA: raise ValueError("COPIED_QGA_SHA_MISMATCH")
    if sha(work / "uring.deb") != a.uring_sha256: raise ValueError("COPIED_URING_SHA_MISMATCH")
    userdata = """#cloud-config
hostname: kmj-cloudos-qga-lab
package_update: false
package_upgrade: false
ssh_pwauth: false
disable_root: true
write_files:
  - path: /usr/local/sbin/kmj-offline-qga-setup
    permissions: '0700'
    content: |
      #!/bin/sh
      set -eu
      echo KMJ_QGA_OFFLINE_INSTALL_BEGIN >/dev/ttyS0
      mkdir -p /mnt/kmj-cidata
      mount -o ro -t iso9660 /dev/disk/by-label/cidata /mnt/kmj-cidata
      dpkg -i /mnt/kmj-cidata/uring.deb /mnt/kmj-cidata/agent.deb
      systemctl enable --now qemu-guest-agent
      systemctl is-active --quiet qemu-guest-agent
      echo KMJ_QGA_OFFLINE_INSTALLED >/dev/ttyS0
runcmd:
  - [sh, -c, "/usr/local/sbin/kmj-offline-qga-setup > /var/log/kmj-offline-qga-setup.log 2>&1"]
final_message: 'KMJ_CLOUDOS_OFFLINE_QGA_CLOUD_INIT_COMPLETE'
"""
    (work / "user-data").write_text(userdata)
    (work / "meta-data").write_text("instance-id: kmj-cloudos-offline-qga-20261031-v1\nlocal-hostname: kmj-cloudos-qga-lab\n")
    (work / "network-config").write_text("version: 2\nethernets:\n  kmj-pci-nic:\n    match:\n      name: 'en*'\n    dhcp4: true\n    dhcp6: false\n")
    run("genisoimage", "-quiet", "-output", str(seed), "-volid", "cidata", "-joliet", "-rock",
        "user-data", "meta-data", "network-config", "agent.deb", "uring.deb", timeout=35, cwd=work)
    run("qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(BASE), str(overlay), "8G")
    shutil.copyfile(VARS, work / "OVMF_VARS_4M.fd")
    cmd = ["qemu-system-x86_64", "-accel", "kvm", "-machine", "q35", "-cpu", "host",
           "-smp", "2", "-m", "1536", "-no-user-config", "-nodefaults",
           "-drive", "file=" + str(overlay) + ",format=qcow2,if=virtio",
           "-drive", "file=" + str(seed) + ",format=raw,if=virtio,readonly=on",
           "-netdev", "user,id=net0,restrict=on",
           "-device", "virtio-net-pci,netdev=net0",
           "-device", "virtio-serial-pci",
           "-chardev", "socket,id=qga,path=" + str(socketpath) + ",server=on,wait=off",
           "-device", "virtserialport,chardev=qga,name=org.qemu.guest_agent.0",
           "-drive", "if=pflash,format=raw,unit=0,readonly=on,file=" + str(CODE),
           "-drive", "if=pflash,format=raw,unit=1,file=" + str(work / "OVMF_VARS_4M.fd"),
           "-display", "none", "-monitor", "none", "-serial", "file:" + str(console),
           "-no-reboot"]
    data = {"kvm": True, "firmware": "UEFI", "base_image_sha256": BASE_SHA,
            "guest_agent_deb_sha256": QGA_SHA, "liburing2_deb_sha256": a.uring_sha256,
            "status": "FAIL", "release_gate_credit": False, "guest_ip": None,
            "guest_agent": False, "cloud_init_complete": False, "clean_shutdown": False}
    proc = None
    start = time.monotonic()
    try:
        with qemulog.open("wb") as log:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            print("QEMU_BOOT=STARTED", flush=True)
            last_failure = "TIMEOUT_WAITING_QGA"
            while time.monotonic() - start < a.max_wait:
                if proc.poll() is not None:
                    last_failure = "QEMU_EXITED_EARLY_" + str(proc.returncode)
                    break
                serial = console.read_text(errors="replace") if console.exists() else ""
                if "KMJ_QGA_OFFLINE_INSTALLED" in serial:
                    data["cloud_init_install_marker"] = True
                if "KMJ_CLOUDOS_OFFLINE_QGA_CLOUD_INIT_COMPLETE" in serial:
                    data["cloud_init_complete"] = True
                if socketpath.exists():
                    try:
                        ping = qga(socketpath, "guest-ping")
                        osinfo = qga(socketpath, "guest-get-osinfo")
                        addr = guestip(qga(socketpath, "guest-network-get-interfaces"))
                        if isinstance(ping, dict) and isinstance(osinfo, dict) and (osinfo.get("id") or osinfo.get("name")) and addr:
                            data["guest_agent"] = True
                            data["guest_ip"] = addr
                            data["guest_os"] = str(osinfo.get("id") or osinfo.get("name"))[:48]
                            if data.get("cloud_init_install_marker") and data["cloud_init_complete"]:
                                last_failure = ""
                                print("GUEST_QGA_PING_OSINFO_IP=PASS", flush=True)
                                break
                    except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
                        pass
                time.sleep(5)
            if last_failure: raise RuntimeError(last_failure)
            print("ACTION=REQUEST_CLEAN_GUEST_SHUTDOWN", flush=True)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(4)
                s.connect(str(socketpath))
                s.sendall(b'{"execute":"guest-shutdown","arguments":{"mode":"powerdown"}}\n')
            proc.wait(timeout=90)
            if proc.returncode != 0: raise RuntimeError("GUEST_SHUTDOWN_NONZERO")
            data["clean_shutdown"] = True
            tempimage = ROOT / (".qga-prepared-20261031-" + str(os.getpid()) + ".qcow2")
            try:
                run("qemu-img", "convert", "-f", "qcow2", "-O", "qcow2",
                    str(overlay), str(tempimage), timeout=180)
                check = json.loads(run("qemu-img", "info", "-f", "qcow2", "--output=json", str(tempimage)).stdout)
                if check.get("format") != "qcow2" or check.get("backing-filename"):
                    raise RuntimeError("UNSAFE_PREPARED_IMAGE")
                if PREPARED.exists(): raise RuntimeError("DESTINATION_ALREADY_EXISTS")
                os.chmod(tempimage, 0o644)
                os.rename(tempimage, PREPARED)
            finally:
                if tempimage.exists(): tempimage.unlink()
            data["status"] = "PASS"
            data["prepared_image_sha256"] = sha(PREPARED)
            data["duration_seconds"] = round(time.monotonic() - start, 2)
            print("PREPARED_IMAGE=" + str(PREPARED), flush=True)
            print("RESULT=OFFLINE_KVM_UEFI_QGA_IMAGE_PREP_PASS", flush=True)
    except Exception as exc:
        data["failure_code"] = type(exc).__name__ + ":" + str(exc)[:160]
        print("RESULT=OFFLINE_QGA_PREP_BLOCKED", flush=True)
        print("FAILURE=" + data["failure_code"], flush=True)
        for name, path in (("CONSOLE_LAST", console), ("QEMU_LAST", qemulog)):
            if path.exists():
                lines = path.read_text(errors="replace").splitlines()
                print(name + "_BEGIN")
                for line in lines[-22:]:
                    print(line[:200])
                print(name + "_END")
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=12)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=10)
        data["duration_seconds"] = round(time.monotonic() - start, 2)
        report.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        os.chmod(report, 0o600)
        print("REPORT=" + str(report), flush=True)
        print("STATUS=" + data["status"], flush=True)
        print("RECEIPT_COMPLETE=YES", flush=True)
    if data["status"] != "PASS": return 6
    return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as exc:
        print("RESULT=PRECHECK_BLOCKED")
        print("FAILURE=" + type(exc).__name__ + ":" + str(exc)[:180])
        sys.exit(5)
