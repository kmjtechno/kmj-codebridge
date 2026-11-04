#!/usr/bin/env python3
"""Exact owner-only GCE relay inventory; read-only and non-mutating."""
import json
import subprocess
import sys

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
SOURCE = "kmj-cloudos-kvm-test"
RELAY = "instance-20260912-094732"

def describe(kind, name):
    p = subprocess.run(["gcloud","compute",kind,"describe",name,
                        "--project="+PROJECT,"--zone="+ZONE,
                        "--format=json","--quiet"],
                       capture_output=True,text=True,timeout=60,check=False)
    if p.returncode or len(p.stdout) > 2_000_000:
        raise ValueError("GCE_READ_FAILED")
    return json.loads(p.stdout)

def exact_url(value, suffix):
    return isinstance(value,str) and value in (
        "https://www.googleapis.com/compute/v1/projects/"+PROJECT+"/"+suffix,
        "https://compute.googleapis.com/compute/v1/projects/"+PROJECT+"/"+suffix)

def inspect(source, disk, relay):
    assert source["name"] == SOURCE and source["status"] == "TERMINATED"
    assert source["deletionProtection"] is True
    assert len(source["disks"]) == 1
    boot = source["disks"][0]
    assert boot["boot"] is True and boot["autoDelete"] is False
    assert boot["mode"] == "READ_WRITE"
    assert exact_url(boot["source"],"zones/"+ZONE+"/disks/"+SOURCE)
    assert disk["name"] == SOURCE and disk["sizeGb"] == "30"
    assert disk["status"] == "READY"
    assert exact_url(disk["type"],"zones/"+ZONE+"/diskTypes/pd-standard")
    assert disk["users"] == ["https://www.googleapis.com/compute/v1/projects/"+PROJECT+"/zones/"+ZONE+"/instances/"+SOURCE] or disk["users"] == ["https://compute.googleapis.com/compute/v1/projects/"+PROJECT+"/zones/"+ZONE+"/instances/"+SOURCE]
    assert relay["name"] == RELAY and relay["status"] == "RUNNING"
    assert exact_url(relay["selfLink"],"zones/"+ZONE+"/instances/"+RELAY)
    assert source["networkInterfaces"][0]["network"] == relay["networkInterfaces"][0]["network"]
    assert len(relay["disks"]) > 0 and sum(d["boot"] is True for d in relay["disks"]) == 1
    assert all(not exact_url(d["source"],"zones/"+ZONE+"/disks/"+SOURCE) for d in relay["disks"])
    configs = relay["networkInterfaces"][0].get("accessConfigs",[])
    tier = configs[0].get("networkTier","UNVERIFIED") if len(configs)==1 else "UNVERIFIED"
    assert tier in ("PREMIUM","STANDARD","UNVERIFIED")
    return tier

def main():
    if sys.argv[1:] != ["--inspect",PROJECT,ZONE,SOURCE,RELAY]:
        return 64
    try:
        source = describe("instances",SOURCE)
        disk = describe("disks",SOURCE)
        relay = describe("instances",RELAY)
        tier = inspect(source,disk,relay)
        print("EXACT_RELAY_SAME_ZONE_VPC_DISK_COLLISION_CHECK=PASS_READ_ONLY")
        print("RELAY_EGRESS_TIER="+tier)
    except (AssertionError,KeyError,ValueError,TypeError,OSError,subprocess.TimeoutExpired):
        print("EXACT_RELAY_READ_ONLY_AUDIT=BLOCKED")
        return 2
    finally:
        print("N2_DISK_RECOVERY_AND_COST_GATES=NOT_VERIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
