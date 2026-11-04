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

def require(value):
    if not value:
        raise ValueError("EXACT_GCE_STATE_MISMATCH")

def inspect(source, disk, relay):
    require(source.get("name") == SOURCE and source.get("status") == "TERMINATED")
    require(source.get("deletionProtection") is True)
    require(type(source.get("disks")) is list and len(source["disks"]) == 1)
    boot = source["disks"][0]
    require(boot.get("boot") is True and boot.get("autoDelete") is False)
    require(boot.get("mode") == "READ_WRITE")
    require(exact_url(boot.get("source"),"zones/"+ZONE+"/disks/"+SOURCE))
    require(disk.get("name") == SOURCE and str(disk.get("sizeGb")) == "30" and type(disk.get("sizeGb")) is not bool)
    require(disk.get("status") == "READY")
    require(exact_url(disk.get("type"),"zones/"+ZONE+"/diskTypes/pd-standard"))
    users = disk.get("users")
    require(type(users) is list and len(users) == 1 and exact_url(users[0],"zones/"+ZONE+"/instances/"+SOURCE))
    require(relay.get("name") == RELAY and relay.get("status") == "RUNNING")
    require(exact_url(relay.get("selfLink"),"zones/"+ZONE+"/instances/"+RELAY))
    nics_source = source.get("networkInterfaces")
    nics_relay = relay.get("networkInterfaces")
    require(type(nics_source) is list and len(nics_source) == 1 and type(nics_relay) is list and len(nics_relay) == 1)
    n = nics_source[0].get("network")
    r = nics_relay[0].get("network")
    require(type(n) is str and n == r and "/global/networks/" in n and len(n) <= 400)
    disks = relay.get("disks")
    require(type(disks) is list and 1 <= len(disks) <= 16 and sum(d.get("boot") is True for d in disks) == 1)
    require(all(type(d) is dict and type(d.get("boot")) is bool and type(d.get("source")) is str for d in disks))
    require(all(not exact_url(d["source"],"zones/"+ZONE+"/disks/"+SOURCE) for d in disks))
    configs = nics_relay[0].get("accessConfigs",[])
    require(type(configs) is list and len(configs) <= 1)
    tier = configs[0].get("networkTier","UNVERIFIED") if len(configs)==1 else "UNVERIFIED"
    require(tier in ("PREMIUM","STANDARD","UNVERIFIED"))
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
    except (KeyError,ValueError,TypeError,AttributeError,OSError,subprocess.TimeoutExpired):
        print("EXACT_RELAY_READ_ONLY_AUDIT=BLOCKED")
        return 2
    finally:
        print("N2_DISK_RECOVERY_AND_COST_GATES=NOT_VERIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
