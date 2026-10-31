#!/usr/bin/env python3
"""Read-only, bounded N2 live state after Cloud Shell SSH/IAP disconnect.

No VM start/stop, no image/repo edits, no credentials, and no daemon changes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

HOST="kmj-cloudos-kvm-test"
ROOT=Path("/var/lib/libvirt/images/kmj-cloudos-ci")
WORK=ROOT/"provider-smoke-20261031-v1"
REPORT=WORK/"evidence/extended-clonesafe-v1/provider-report.json"
TEMPLATE=ROOT/"qga-clone-sanitized-20261031-v1.qcow2"
TEMPLATE_REPORT=ROOT/"guest-identity-sanitize-20261031-v1/report.json"
ORIGINAL_REPORT=WORK/"evidence/permission-fix-v2/provider-report.json"

def safe_report(path, prefix):
    if not path.is_file() or path.is_symlink():
        print(prefix+"_REPORT=NOT_PRESENT",flush=True)
        return
    try:
        obj=json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        print(prefix+"_REPORT=INVALID_"+type(exc).__name__,flush=True)
        return
    print(prefix+"_REPORT=PRESENT",flush=True)
    for key in ("status","guest_agent_ready","failure_code","cleanup_retry","release_gate_credit"):
        if key in obj:
            value=obj[key]
            if not isinstance(value,(str,bool,int,type(None))):value="UNEXPECTED_TYPE"
            print(prefix+"_"+key.upper()+"="+str(value)[:170],flush=True)
    checks=obj.get("checks",{})
    if isinstance(checks,dict):
        for name, status in sorted(checks.items()):
            if isinstance(name,str) and name.isidentifier():
                print(prefix+"_CHECK_"+name.upper()+"="+str(status)[:32],flush=True)
    for key in ("graceful_restart","multiprocess_idempotency","tenant_isolation","failed_define_retry"):
        value=obj.get(key)
        if isinstance(value,dict):
            print(prefix+"_DETAIL_"+key.upper()+"="+str(value.get("status"))[:32],flush=True)

def main():
    print("KMJ_N2_CLOUDOS_POST_IAP_BREAK_STATE_V1",flush=True)
    print("SCOPE=ONE_EXISTING_GCE_N2_READ_ONLY",flush=True)
    if os.geteuid()!=0 or os.uname().nodename.split(".")[0]!=HOST:
        raise ValueError("WRONG_HOST_OR_USER")
    print("HOST_IDENTITY=PASS",flush=True)
    uptime=Path("/proc/uptime").read_text().split()[0]
    print("HOST_UPTIME_SECONDS="+str(int(float(uptime))),flush=True)
    try:
        proc=subprocess.run(["virsh","-c","qemu:///system","list","--all","--name"],
                            capture_output=True,text=True,timeout=14)
        if proc.returncode:
            print("LIBVIRT_DOMAIN_ENUMERATION=FAILED",flush=True)
            count=None
        else:
            domains=[x.strip() for x in proc.stdout.splitlines() if x.strip()]
            count=len(domains)
            print("LIBVIRT_DOMAIN_ENUMERATION=PASS",flush=True)
            print("ALL_DEFINED_DOMAINS="+str(count),flush=True)
            print("ONLY_KMJ_CI_DOMAINS="+str(all(x.startswith("kmj-") for x in domains)),flush=True)
    except (OSError,subprocess.TimeoutExpired):
        print("LIBVIRT_DOMAIN_ENUMERATION=UNAVAILABLE",flush=True)
        count=None
    pids=[]
    for file in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            raw=file.read_bytes()
        except (OSError,PermissionError):
            continue
        if b"ci_libvirt_provider_smoke.py" in raw and b"/proc/" not in raw:
            pids.append(int(file.parent.name))
    print("PROVIDER_SMOKE_PROCESS_COUNT="+str(len(pids)),flush=True)
    for pid in sorted(pids)[:5]:
        print("PROVIDER_SMOKE_PID="+str(pid),flush=True)
    print("TEMPLATE_FILE="+("PRESENT" if TEMPLATE.is_file() and not TEMPLATE.is_symlink() else "ABSENT"),flush=True)
    safe_report(TEMPLATE_REPORT,"CLONE_TEMPLATE")
    safe_report(ORIGINAL_REPORT,"BASIC")
    safe_report(REPORT,"EXTENDED")
    try:
        mem={k:int(v.split()[0]) for k,v in (line.split(":",1) for line in Path("/proc/meminfo").read_text().splitlines())}
        print("HOST_MEM_AVAILABLE_MIB="+str(mem["MemAvailable"]//1024),flush=True)
    except (OSError,ValueError,KeyError):pass
    # No process killing, cleanup, network changes or image permissions changed.
    if pids:
        print("STATE=EXTENDED_SMOKE_STILL_RUNNING_DO_NOT_RESTART",flush=True)
    elif count and count>0:
        print("STATE=NO_SMOKE_PROCESS_WITH_GUESTS_REVIEW_BEFORE_ANY_CLEANUP",flush=True)
    elif count==0 and REPORT.is_file():
        try:
            status=json.loads(REPORT.read_text()).get("status")
            print("STATE=EXTENDED_TEST_FINISHED_"+str(status),flush=True)
        except (OSError,ValueError):
            print("STATE=EXTENDED_REPORT_UNREADABLE",flush=True)
    elif count==0:
        print("STATE=TEST_STOPPED_OR_INTERRUPTED_WITHOUT_REPORT",flush=True)
    else:
        print("STATE=UNDETERMINED",flush=True)
    print("RESULT=READ_ONLY_POST_SSH_STATE_COMPLETE",flush=True)
    print("RECEIPT_COMPLETE=YES",flush=True)

if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("RESULT=POST_SSH_READ_ONLY_DIAGNOSTIC_BLOCKED",flush=True)
        print("BLOCKER="+type(exc).__name__,flush=True)
        sys.exit(4)
