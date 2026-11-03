#!/usr/bin/env python3
"""No-start, no-write security topology inventory for one existing N2 relay.

Requires the exact user-verified running instance:
  instance-20260912-094732, us-central1-a, internal 10.128.0.2
and protected/stopped CloudOS N2:
  kmj-cloudos-kvm-test, us-central1-a, internal 10.128.0.3

The script only uses Google Compute describe/list/get-effective-firewalls.
It never runs SSH, touches guest agents, changes firewall/IAM/instance
settings, generates keys, moves data or creates billable resources.

A same-VPC host and effective firewall inventory are *not* a proven
network path, a secure relay authorization, or a backup/restore gate.
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
REGION = "us-central1"
N2 = "kmj-cloudos-kvm-test"
RELAY = "instance-20260912-094732"
N2_INTERNAL = "10.128.0.3"
RELAY_INTERNAL = "10.128.0.2"
DOMAIN = {"compute.googleapis.com", "www.googleapis.com"}
PUBLIC_KEY_PIN = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
EXACT_NETWORK = "default"
EXACT_SUBNET = "default"
EXACT_VPC = f"global/networks/{EXACT_NETWORK}"
EXACT_SUBNET_PATH = f"regions/{REGION}/subnetworks/{EXACT_SUBNET}"


class Blocked(RuntimeError):
    pass


def canonical_path(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        if (url.scheme != "https" or url.hostname not in DOMAIN
                or url.username or url.password or url.port or url.query
                or url.fragment):
            return None
    except ValueError:
        return None
    prefix = f"/compute/v1/projects/{PROJECT}/"
    return url.path[len(prefix):] if url.path.startswith(prefix) else None


def check_node(inst: object, *, name: str, address: str, running: bool) -> bool:
    if (not isinstance(inst, dict) or inst.get("name") != name
            or inst.get("status") != ("RUNNING" if running else "TERMINATED")
            or canonical_path(inst.get("selfLink"))
            != f"zones/{ZONE}/instances/{name}"):
        raise Blocked("EXACT_VM_STATUS_OR_IDENTITY_MISMATCH")
    interfaces = inst.get("networkInterfaces")
    if not isinstance(interfaces, list) or len(interfaces) != 1:
        raise Blocked("UNEXPECTED_NIC_CONFIGURATION")
    nic = interfaces[0]
    if (not isinstance(nic, dict)
            or canonical_path(nic.get("network")) != EXACT_VPC
            or canonical_path(nic.get("subnetwork")) != EXACT_SUBNET_PATH
            or nic.get("networkIP") != address):
        raise Blocked("VM_NETWORK_OR_INTERNAL_IP_CHANGED")
    access = nic.get("accessConfigs", [])
    if not isinstance(access, list) or any(not isinstance(x, dict) for x in access):
        raise Blocked("EXTERNAL_ACCESS_CONFIG_INVALID")
    public = False
    for config in access:
        if config.get("type") != "ONE_TO_ONE_NAT":
            raise Blocked("UNEXPECTED_EXTERNAL_ACCESS_CONFIG")
        try:
            external = ipaddress.IPv4Address(config.get("natIP", ""))
        except (ValueError, ipaddress.AddressValueError) as exc:
            raise Blocked("INVALID_EXTERNAL_IPV4") from exc
        if not external.is_global:
            raise Blocked("EXTERNAL_IPV4_NOT_GLOBAL")
        public = True
    if running:
        if not public:
            raise Blocked("EXISTING_RELAY_EXTERNAL_IPV4_NO_LONGER_PRESENT")
    else:
        if public or inst.get("deletionProtection") is not True:
            raise Blocked("N2_PUBLIC_EGRESS_OR_DELETION_GUARD_CHANGED")
        disks = inst.get("disks")
        if (not isinstance(disks, list) or len(disks) != 1
                or not isinstance(disks[0], dict)
                or disks[0].get("boot") is not True
                or disks[0].get("autoDelete") is not False):
            raise Blocked("N2_BOOT_DISK_PROTECTION_NOT_VERIFIED")
    return public


def read_gce(*args: str, required: bool = True) -> object | None:
    argv = ["gcloud", "compute", *args, "--project=" + PROJECT,
            "--format=json", "--quiet"]
    try:
        command = subprocess.run(argv, capture_output=True, text=True,
                                 timeout=50, check=False)
    except (OSError, subprocess.TimeoutExpired):
        if not required:
            return None
        raise Blocked("GCE_READ_UNAVAILABLE_OR_TIMEOUT")
    if command.returncode or len(command.stdout.encode("utf-8")) > 2_000_000:
        if not required:
            return None
        raise Blocked("GCE_READ_FAILED_OR_AUTHORIZATION_MISSING")
    try:
        return json.loads(command.stdout)
    except (ValueError, UnicodeError) as exc:
        if not required:
            return None
        raise Blocked("GCE_RESPONSE_NOT_JSON") from exc


def rules_count(response: object) -> int | None:
    if isinstance(response, list):
        return len(response) if len(response) <= 20000 else None
    if isinstance(response, dict) and isinstance(response.get("firewalls"), list):
        return len(response["firewalls"]) if len(response["firewalls"]) <= 20000 else None
    return None


def inspect() -> int:
    n2 = read_gce("instances", "describe", N2, "--zone=" + ZONE)
    relay = read_gce("instances", "describe", RELAY, "--zone=" + ZONE)
    check_node(n2, name=N2, address=N2_INTERNAL, running=False)
    check_node(relay, name=RELAY, address=RELAY_INTERNAL, running=True)
    print("N2_EXACT_PROTECTED_TERMINATED=VERIFIED")
    print("RELAY_EXACT_RUNNING_GCE_IDENTITY=VERIFIED")
    print("RELAY_EXPECTED_INTERNAL_IPV4=" + RELAY_INTERNAL)
    print("RELAY_SAME_VPC_AND_SUBNET_AS_N2=VERIFIED")
    print("RELAY_EXISTING_EXTERNAL_IPV4=PRESENT_ADDRESS_WITHHELD")
    print("NEW_VM_EXTERNAL_IP_OR_CLOUD_NAT=NONE_CREATED")
    for name, label in ((N2, "N2"), (RELAY, "RELAY")):
        info = read_gce(
            "instances", "network-interfaces", "get-effective-firewalls",
            name, "--zone=" + ZONE, "--network-interface=nic0",
            required=False,
        )
        count = rules_count(info)
        print(label + "_EFFECTIVE_FIREWALL_RULE_INVENTORY=" +
              (("READ_AVAILABLE_COUNT_" + str(count))
               if count is not None else "READ_UNVERIFIED"))
    firewall = read_gce("firewall-rules", "list", required=False)
    if isinstance(firewall, list) and len(firewall) <= 50000:
        matching = []
        for item in firewall:
            if not isinstance(item, dict):
                continue
            if canonical_path(item.get("network")) == EXACT_VPC:
                matching.append(item)
        ingress = [x for x in matching if x.get("direction", "INGRESS") == "INGRESS"]
        egress = [x for x in matching if x.get("direction") == "EGRESS"]
        print("SHARED_VPC_STANDARD_FIREWALL_RULES=" + str(len(matching)))
        print("SHARED_VPC_STANDARD_INGRESS_RULES=" + str(len(ingress)))
        print("SHARED_VPC_STANDARD_EGRESS_RULES=" + str(len(egress)))
    else:
        print("SHARED_VPC_STANDARD_FIREWALL_RULES=READ_UNVERIFIED")
    print("N2_TO_RELAY_TCP22_LIVE_REACHABILITY=NOT_TESTED")
    print("N2_TO_RELAY_EFFECTIVE_TCP22_ALLOW=NOT_ESTABLISHED")
    print("RELAY_GUEST_SSH_AND_FIREWALL=NOT_TESTED")
    print("RELAY_TO_ELITE_ED25519_PIN=" + PUBLIC_KEY_PIN)
    print("RELAY_TO_ELITE_PUBLIC_EGRESS=NOT_TESTED")
    print("RELAY_RESTRICTED_UPLOAD_AUTHORIZATION=NOT_VERIFIED")
    print("RELAY_EXISTING_PRODUCTION_WORKLOAD_COMPATIBILITY=NOT_VERIFIED")
    print("CONSISTENT_ENCRYPTED_DISK_CAPTURE=NOT_ATTEMPTED")
    print("INDEPENDENT_BOOTABLE_RESTORE_ROLLBACK=NOT_VERIFIED")
    print("GCE_OR_HOST_CHANGES=NONE")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    print("RELAY_TOPOLOGY_PREFLIGHT=READ_ONLY_COMPLETE")
    return 0


def self_test() -> int:
    base = f"https://compute.googleapis.com/compute/v1/projects/{PROJECT}/"
    base_nic = {"network": base + EXACT_VPC,
                "subnetwork": base + EXACT_SUBNET_PATH}
    n2 = {"name": N2, "status": "TERMINATED",
          "selfLink": base + f"zones/{ZONE}/instances/{N2}",
          "deletionProtection": True,
          "disks": [{"boot": True, "autoDelete": False}],
          "networkInterfaces": [{**base_nic, "networkIP": N2_INTERNAL}]}
    candidate = {"name": RELAY, "status": "RUNNING",
                 "selfLink": base + f"zones/{ZONE}/instances/{RELAY}",
                 "networkInterfaces": [{**base_nic, "networkIP": RELAY_INTERNAL,
                                         "accessConfigs": [
                                            {"type": "ONE_TO_ONE_NAT",
                                             "natIP": "8.8.8.8"}]}]}
    assert check_node(n2, name=N2, address=N2_INTERNAL, running=False) is False
    assert check_node(candidate, name=RELAY, address=RELAY_INTERNAL,
                      running=True) is True
    assert rules_count([{}, {}]) == 2
    assert rules_count({"firewalls": [{}]}) == 1
    assert rules_count({"firewallPolicys": []}) is None
    invalid = [
        ({**n2, "status": "RUNNING"}, False),
        ({**n2, "deletionProtection": False}, False),
        ({**n2, "disks": [{"boot": True, "autoDelete": True}]}, False),
        ({**candidate, "networkInterfaces": [
            {**candidate["networkInterfaces"][0], "networkIP": "127.0.0.1"}]}, True),
        ({**candidate, "networkInterfaces": [
            {**candidate["networkInterfaces"][0],
             "network": "https://evil.example/compute/v1/projects/" +
                        PROJECT + "/" + EXACT_VPC}]}, True),
    ]
    for vm, is_relay in invalid:
        try:
            check_node(vm, name=RELAY if is_relay else N2,
                       address=RELAY_INTERNAL if is_relay else N2_INTERNAL,
                       running=is_relay)
        except Blocked:
            pass
        else:
            raise AssertionError("Invalid GCE identity/security state accepted")
    print("RELAY_EXACT_IDENTITY_AND_FIREWALL_OFFLINE_TESTS=PASS")
    return 0


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--self-test"]:
            raise SystemExit(self_test())
        if sys.argv[1:] != ["--inspect", PROJECT, ZONE, N2, RELAY]:
            print("REFUSE_UNSCOPED_GCE_INSPECTION")
            raise SystemExit(64)
        raise SystemExit(inspect())
    except (Blocked, OSError, TypeError, ValueError):
        print("RELAY_TOPOLOGY_PREFLIGHT=BLOCKED_OR_READ_UNVERIFIED")
        print("GCE_OR_HOST_CHANGES=NONE")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        raise SystemExit(2)
