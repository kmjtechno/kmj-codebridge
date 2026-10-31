#!/usr/bin/env python3
"""Read-only N2 libvirt default NAT DHCP/client-identity forensics.
Never modifies libvirt, qcow2, leases or VM state. Bounded sanitized evidence.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path("/var/lib/libvirt/images/kmj-cloudos-ci")
WORK=ROOT/"provider-smoke-20261031-v1"
REPORT=WORK/"evidence/extended-lifecycle-v1/provider-report.json"
LEASES=Path("/var/lib/libvirt/dnsmasq/default.leases")
RECEIPT=Path("/var/tmp/kmj_n2_cloudos_tenant_dhcp_diagnostic_20261031.json")
def cmd(*argv,limit=15000):
    p=subprocess.run(argv,capture_output=True,text=True,timeout=18)
    return p.returncode,p.stdout[:limit],p.stderr[:500]
def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()[:16]
def main():
    if os.geteuid()!=0 or os.uname().nodename.split(".")[0]!="kmj-cloudos-kvm-test":
        raise ValueError("WRONG_HOST_OR_USER")
    print("KMJ_CLOUDOS_N2_READONLY_TENANT_DHCP_DIAGNOSTIC_V1")
    st,dom,err=cmd("virsh","-c","qemu:///system","list","--all","--name")
    if st: raise ValueError("LIBVIRT_DOMAIN_LIST_ERROR")
    print("DEFINED_DOMAINS="+str(len([v for v in dom.splitlines() if v.strip()])))
    report=json.loads(REPORT.read_text())
    if report.get("failure_code")!="TENANT_DUPLICATE_IPV4_ASSIGNMENT":
        raise ValueError("UNEXPECTED_EXTENDED_REPORT")
    print("EXTENDED_REPORT_FAILURE="+report["failure_code"])
    print("EXTENDED_GUEST_AGENT_READY="+str(report.get("guest_agent_ready")))
    primary_ip=report.get("guest_ip_address")
    print("PRIMARY_IP="+str(primary_ip))
    st,lease_output,err=cmd("virsh","-c","qemu:///system","net-dhcp-leases","default")
    print("VIRSH_DHCP_LEASES_COMMAND="+("PASS" if st==0 else "UNAVAILABLE"))
    # Print at most bounded provider lease records; avoid raw MAC and client IDs.
    parsed=[]
    if LEASES.is_file() and not LEASES.is_symlink():
        for line in LEASES.read_text(errors="replace").splitlines()[:100]:
            parts=line.split()
            if len(parts)<5:continue
            expire,mac,ip,hostname,client=parts[:5]
            if not re.fullmatch(r"(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}",mac):continue
            if not re.fullmatch(r"[0-9a-fA-F:.]+",ip):continue
            parsed.append(dict(ip=ip,mac_digest=digest(mac.lower()),client_digest=digest(client.lower()),
                               hostname_digest=digest(hostname),expiry=expire[:16]))
    print("DNSMASQ_LEASE_ENTRIES="+str(len(parsed)))
    for i,item in enumerate(parsed[:12]):
        print("LEASE_"+str(i)+"_IP="+item["ip"])
        print("LEASE_"+str(i)+"_MAC_HASH="+item["mac_digest"])
        print("LEASE_"+str(i)+"_CLIENT_HASH="+item["client_digest"])
    client_counts={}
    for p in parsed:
        client_counts.setdefault(p["client_digest"],[]).append(p)
    duplicate_ids={k:[x["mac_digest"] for x in v] for k,v in client_counts.items()
                   if len({x["mac_digest"] for x in v})>1 and k!=digest("*")}
    print("MULTIPLE_MACS_SHARE_CLIENT_ID="+str(bool(duplicate_ids)))
    for v in list(duplicate_ids.values())[:3]:
        print("COLLIDING_CLIENT_ID_MAC_COUNT="+str(len(set(v))))
    # Check client-image preparation metadata, not private guest image content.
    prep=ROOT/"guest-qga-offline-20261031-v1/report.json"
    if prep.is_file():
        j=json.loads(prep.read_text())
        print("PREPARED_IMAGE_STATUS="+str(j.get("status")))
        print("PREPARED_IMAGE_GUEST_OS="+str(j.get("guest_os")))
        print("PREPARED_IMAGE_NETWORK_IP="+str(j.get("guest_ip")))
    for tool in ("virt-cat","guestfish","qemu-nbd"):
        from shutil import which
        print("OFFLINE_INSPECTION_TOOL_"+tool.replace("-","_").upper()+"="+str(bool(which(tool))))
    lines=[]
    st,journal,err=cmd("journalctl","-u","libvirtd","-u","virtqemud","--since","-90 minutes","--no-pager","-o","cat",limit=300000)
    if st==0:
        lines=[line for line in journal.splitlines() if "dnsmasq" in line.lower() or "dhcp" in line.lower()]
    print("LIBVIRT_DHCP_LOG_LINE_COUNT="+str(len(lines)))
    # Avoid printing raw adjacent logs; only classified boolean.
    print("DHCP_DUPLICATE_CLIENTID_HINT="+str(any("client-id" in line.lower() or "duid" in line.lower() for line in lines)))
    receipt={
       "schema":"kmj.cloudos.n2.tenant_dhcp.readonly.v1",
       "status":"PASS","domain_count":len([v for v in dom.splitlines() if v.strip()]),
       "previous_failure":report.get("failure_code"),
       "guest_ip":primary_ip,"lease_count":len(parsed),
       "leases":parsed[:20],"multiple_macs_share_client_id":bool(duplicate_ids),
       "release_gate_credit":False
    }
    RECEIPT.write_text(json.dumps(receipt,indent=2)+"\n")
    RECEIPT.chmod(0o600)
    print("RESULT=TENANT_DHCP_READONLY_EVIDENCE_COMPLETE")
    print("RECEIPT_COMPLETE=YES")
    print("RECEIPT_PATH="+str(RECEIPT))
if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("RESULT=TENANT_DHCP_DIAGNOSTIC_BLOCKED")
        print("FAILURE="+type(exc).__name__+":"+str(exc)[:160])
        sys.exit(5)
