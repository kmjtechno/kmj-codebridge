#!/usr/bin/env python3
"""No-start, no-write inventory of EXISTING same-VPC relay candidates for N2.

N2 has no external IP or matching regional Cloud NAT. Before changing paid
networking, discover running project instances on the same VPC that might
already relay small control traffic or an application-consistent encrypted
backup stream to an independently verified offsite host. This is INVENTORY
ONLY. Internal SSH, authorization, outward egress, relay security, storage
and rollback are not tested or implied by a RUNNING status.
"""
from __future__ import annotations

import ipaddress
import json
import re
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
VM = "kmj-cloudos-kvm-test"
EXPECTED_NET = "default"
EXPECTED_SUBNET = "default"
ALLOWED_HOSTS = {"compute.googleapis.com", "www.googleapis.com"}
IDENT = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
ZONE_PATTERN = re.compile(r"[a-z0-9-]{2,45}\Z")


class Blocked(RuntimeError):
    pass


def qualified(link: object, suffix: str) -> str | None:
    if not isinstance(link, str):
        return None
    try:
        u = urlsplit(link)
        if (u.scheme != "https" or u.hostname not in ALLOWED_HOSTS
                or u.username or u.password or u.port
                or u.query or u.fragment):
            return None
    except ValueError:
        return None
    prefix = "/compute/v1/projects/" + PROJECT + "/"
    if not u.path.startswith(prefix):
        return None
    remain = u.path[len(prefix):]
    if not remain.endswith("/" + suffix):
        return None
    name = remain[:-(len(suffix)+1)]
    return name if name else None


def instance_identity(vm: dict) -> tuple[str, str] | None:
    if not isinstance(vm, dict):
        return None
    name = vm.get("name")
    link = qualified(vm.get("selfLink"), f"instances/{name}")
    if (not isinstance(name, str) or not IDENT.fullmatch(name)
            or not link or not link.startswith("zones/")):
        return None
    zone = link[len("zones/"):]
    if not ZONE_PATTERN.fullmatch(zone):
        return None
    nics = vm.get("networkInterfaces")
    if not isinstance(nics, list) or len(nics) != 1:
        return None
    nic = nics[0]
    if not isinstance(nic, dict):
        return None
    net = qualified(nic.get("network"), "networks/" + EXPECTED_NET)
    if net != "global":
        return None
    subnet = qualified(nic.get("subnetwork"), "subnetworks/" + EXPECTED_SUBNET)
    if not subnet or not subnet.startswith("regions/"):
        return None
    return name, zone


def candidate(vm: dict) -> dict | None:
    identity = instance_identity(vm)
    if not identity or vm.get("status") != "RUNNING" or vm.get("name") == VM:
        return None
    name, zone = identity
    nic = vm["networkInterfaces"][0]
    try:
        internal = str(ipaddress.IPv4Address(nic.get("networkIP", "")))
        if not ipaddress.IPv4Address(internal).is_private:
            return None
    except ValueError:
        return None
    access = nic.get("accessConfigs", [])
    if not isinstance(access, list):
        return None
    public = False
    for cfg in access:
        if not isinstance(cfg, dict):
            return None
        ip = cfg.get("natIP")
        if ip:
            try:
                addr = ipaddress.IPv4Address(ip)
                if cfg.get("type") != "ONE_TO_ONE_NAT" or not addr.is_global:
                    return None
                public = True
            except ValueError:
                return None
    return {"name": name, "zone": zone, "ip": internal, "public": public}


def query(*args: str) -> object:
    try:
        proc = subprocess.run(
            ["gcloud", "compute", *args, "--project=" + PROJECT,
             "--format=json", "--quiet"],
            capture_output=True, text=True, check=False, timeout=55
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("GCLOUD_LIST_UNAVAILABLE_OR_TIMEOUT") from exc
    if proc.returncode or len(proc.stdout.encode("utf-8")) > 2_000_000:
        raise Blocked("GCLOUD_LIST_READ_DENIED_OR_OVERSIZE")
    try:
        return json.loads(proc.stdout)
    except (ValueError, UnicodeError) as exc:
        raise Blocked("INVALID_GCLOUD_LIST_JSON") from exc


def inspect() -> int:
    n2 = query("instances", "describe", VM, "--zone=" + ZONE)
    if not isinstance(n2, dict) or instance_identity(n2) != (VM, ZONE):
        raise Blocked("N2_IDENTITY_OR_NETWORK_MISMATCH")
    disks = n2.get("disks")
    if (n2.get("status") != "TERMINATED"
            or n2.get("deletionProtection") is not True
            or not isinstance(disks, list) or len(disks) != 1
            or not isinstance(disks[0], dict)
            or disks[0].get("boot") is not True
            or disks[0].get("autoDelete") is not False):
        raise Blocked("N2_NOT_STOPPED_AND_PROTECTED")
    if n2["networkInterfaces"][0].get("accessConfigs"):
        raise Blocked("N2_ALREADY_HAS_ACCESS_CONFIG_REINSPECT")
    listing = query("instances", "list")
    if not isinstance(listing, list) or len(listing) > 10000:
        raise Blocked("INSTANCE_INVENTORY_INVALID_OR_OVERSIZE")
    found = []
    for row in listing:
        if not isinstance(row, dict):
            raise Blocked("INSTANCE_ROW_INVALID")
        c = candidate(row)
        if c:
            found.append(c)
    found.sort(key=lambda c: (not c["public"], c["name"], c["zone"]))
    print("N2_EXACT_PROTECTED_TERMINATED=VERIFIED")
    print("N2_VPC_NETWORK=default")
    print("N2_VPC_SUBNETWORK=default")
    print("N2_EXTERNAL_IPV4=ABSENT")
    print("SAME_PROJECT_RUNNING_SAME_VPC_RELAY_CANDIDATES=" + str(len(found)))
    for i, item in enumerate(found[:15], 1):
        print("RELAY_CANDIDATE_" + str(i) + "=" +
              item["name"] + "|" + item["zone"] + "|" + item["ip"] + "|" +
              ("HAS_EXTERNAL_IPV4" if item["public"] else "NO_EXTERNAL_IPV4"))
    if len(found) > 15:
        print("RELAY_CANDIDATES_DISPLAY=TRUNCATED_TO_15")
    print("RELAY_CAPABILITY=" +
          ("POSSIBLE_EXISTING_NETWORK_TOPOLOGY_UNVERIFIED"
           if found else "NO_RUNNING_SAME_VPC_INSTANCE_DISCOVERED_IN_PROJECT"))
    print("RELAY_INTERNAL_TCP22_AND_FIREWALL=NOT_TESTED")
    print("RELAY_TO_ELITE_OUTBOUND_SSH=NOT_TESTED")
    print("RELAY_AUTHORIZATION_AND_ISOLATION=NOT_VERIFIED")
    print("RELAY_DISK_OR_OFFSITE_BACKUP_WRITES=NONE")
    print("IAP_BULK_BACKUP_POLICY=NOT_APPROVED")
    print("N2_VM_START_STOP_AND_GCE_RESOURCE_MUTATIONS=NONE")
    print("BOOTABLE_ENCRYPTED_BACKUP_AND_INDEPENDENT_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_COMMERCIAL_RELEASE=BLOCKED")
    return 0


def self_test() -> int:
    base = "https://compute.googleapis.com/compute/v1/projects/" + PROJECT + "/"
    nic = {"network": base + "global/networks/default",
           "subnetwork": base + "regions/us-central1/subnetworks/default",
           "networkIP": "10.128.0.4",
           "accessConfigs": [{"type":"ONE_TO_ONE_NAT", "natIP":"8.8.8.8"}]}
    vm = {"name":"google-vps1", "selfLink":base+"zones/us-central1-a/instances/google-vps1",
          "status":"RUNNING", "networkInterfaces":[nic]}
    assert instance_identity(vm) == ("google-vps1", "us-central1-a")
    assert candidate(vm) == {"name":"google-vps1","zone":"us-central1-a",
                              "ip":"10.128.0.4","public":True}
    assert candidate({**vm, "status":"TERMINATED"}) is None
    assert candidate({**vm, "name":VM}) is None
    assert candidate({**vm, "networkInterfaces":[{**nic, "network":
        "https://evil.example/compute/v1/projects/"+PROJECT+
        "/global/networks/default"}]}) is None
    assert candidate({**vm, "networkInterfaces":[{**nic, "networkIP":"127.0.0.1"}]}) is None
    assert candidate({**vm, "networkInterfaces":[{**nic, "accessConfigs":[]} ]})["public"] is False
    print("N2_EXISTING_VPC_RELAY_OFFLINE_TESTS=PASS")
    return 0


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--self-test"]:
            raise SystemExit(self_test())
        if sys.argv[1:] != ["--inspect", PROJECT, ZONE, VM]:
            print("REFUSE_OTHER_PROJECT_ZONE_INSTANCE")
            raise SystemExit(64)
        raise SystemExit(inspect())
    except (Blocked, OSError, TypeError, ValueError):
        print("N2_EXISTING_VPC_RELAY_INVENTORY=BLOCKED_UNVERIFIED")
        print("N2_VM_START_STOP_AND_GCE_RESOURCE_MUTATIONS=NONE")
        print("CLOUDOS_COMMERCIAL_RELEASE=BLOCKED")
        raise SystemExit(2)
