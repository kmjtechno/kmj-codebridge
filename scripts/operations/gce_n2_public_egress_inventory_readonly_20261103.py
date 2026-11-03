#!/usr/bin/env python3
"""No-start, no-write GCE control-plane diagnosis of N2 outbound public SSH.

Only reads exact N2 VM instance, same-project VPC routers/Public NAT configs,
and the static route inventory. Never starts N2, allocates public IPv4,
provisions NAT, enables APIs, writes credentials, or assumes IAP provides
outbound access. NAT presence alone is not proof of TCP/22 reachability.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
REGION = "us-central1"
VM = "kmj-cloudos-kvm-test"
PUBLIC_IP = "103.212.136.154"
ALLOWED_HOSTS = {"compute.googleapis.com", "www.googleapis.com"}
VALID_NAME = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")


class Blocked(RuntimeError):
    pass


def resource_name(link: object, relative_prefix: str) -> str | None:
    if not isinstance(link, str):
        return None
    u = urlsplit(link)
    if (u.scheme != "https" or u.hostname not in ALLOWED_HOSTS
            or u.username or u.password or u.port or u.query or u.fragment):
        return None
    prefix = "/compute/v1/projects/" + PROJECT + "/" + relative_prefix + "/"
    if not u.path.startswith(prefix):
        return None
    name = u.path[len(prefix):]
    return name if VALID_NAME.fullmatch(name) else None


def query(*args: str) -> object:
    argv = ["gcloud", "compute", *args, "--project=" + PROJECT,
            "--format=json", "--quiet"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=50, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("READ_COMMAND_UNAVAILABLE_OR_TIMEOUT") from exc
    if proc.returncode != 0 or len(proc.stdout.encode("utf-8")) > 1_000_000:
        raise Blocked("GCE_READ_FAILED_OR_UNAUTHORIZED")
    try:
        return json.loads(proc.stdout)
    except (ValueError, UnicodeError) as exc:
        raise Blocked("BAD_GCE_JSON") from exc


def parse_vm(inst: object) -> tuple[str, str, bool]:
    if (not isinstance(inst, dict) or inst.get("name") != VM
            or inst.get("status") != "TERMINATED"
            or inst.get("deletionProtection") is not True
            or resource_name(inst.get("selfLink"), "zones/" + ZONE + "/instances") != VM):
        raise Blocked("N2_VM_STATE_OR_IDENTITY_OR_DELETION_GUARD_MISMATCH")
    disks = inst.get("disks")
    if (not isinstance(disks, list) or len(disks) != 1
            or not isinstance(disks[0], dict)
            or disks[0].get("boot") is not True
            or disks[0].get("autoDelete") is not False
            or not resource_name(disks[0].get("source"), "zones/" + ZONE + "/disks")):
        raise Blocked("N2_BOOT_DISK_OR_AUTODELETE_GUARD_MISMATCH")
    nics = inst.get("networkInterfaces")
    if (not isinstance(nics, list) or len(nics) != 1
            or not isinstance(nics[0], dict)):
        raise Blocked("N2_EXPECTED_ONE_NIC_MISMATCH")
    nic = nics[0]
    network = resource_name(nic.get("network"), "global/networks")
    subnet = resource_name(nic.get("subnetwork"), "regions/" + REGION + "/subnetworks")
    if not network or not subnet:
        raise Blocked("N2_NETWORK_OR_SUBNETWORK_OUTSIDE_PROJECT_UNVERIFIED")
    configs = nic.get("accessConfigs", [])
    if not isinstance(configs, list):
        raise Blocked("N2_PUBLIC_IP_CONFIG_UNVERIFIED")
    external = any(
        isinstance(c, dict) and c.get("type") == "ONE_TO_ONE_NAT"
        and isinstance(c.get("natIP"), str) and bool(c["natIP"])
        for c in configs
    )
    if configs and any(not isinstance(c, dict) for c in configs):
        raise Blocked("INVALID_ACCESS_CONFIG_ITEM")
    return network, subnet, external


def applies(nat: dict, subnet: str) -> bool | None:
    kind = nat.get("type", "PUBLIC")
    if kind not in ("PUBLIC", None):
        return False
    mode = nat.get("sourceSubnetworkIpRangesToNat")
    if mode in ("ALL_SUBNETWORKS_ALL_IP_RANGES",
                "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES"):
        return True
    if mode == "LIST_OF_SUBNETWORKS":
        entries = nat.get("subnetworks", [])
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict):
                return None
            if resource_name(entry.get("name"),
                             "regions/" + REGION + "/subnetworks") == subnet:
                ranges = entry.get("sourceIpRangesToNat")
                if not isinstance(ranges, list):
                    return None
                return any(r in ("PRIMARY_IP_RANGE", "ALL_IP_RANGES")
                           for r in ranges)
        return False
    return None


def inspect() -> int:
    inst = query("instances", "describe", VM, "--zone=" + ZONE)
    network, subnet, external = parse_vm(inst)
    print("N2_GCE_CONTROLPLANE=EXACT_STOPPED_PROTECTED_VM_VERIFIED")
    print("N2_GCE_NETWORK=" + network)
    print("N2_GCE_SUBNETWORK=" + subnet)
    print("N2_EXTERNAL_IPV4=" + ("PRESENT" if external else "ABSENT"))
    try:
        routers = query("routers", "list")
        if not isinstance(routers, list) or len(routers) > 5000:
            raise Blocked("GCE_ROUTERS_LIST_INVALID")
        matching = []
        for router in routers:
            if not isinstance(router, dict):
                raise Blocked("ROUTER_RECORD_INVALID")
            if (resource_name(router.get("network"), "global/networks") == network
                    and resource_name(router.get("selfLink"),
                                      "regions/" + REGION + "/routers")
                    == router.get("name")):
                matching.append(router["name"])
        matching = sorted(set(matching))
        covered = 0
        unknown = 0
        nat_count = 0
        for name in matching:
            info = query("routers", "describe", name, "--region=" + REGION)
            if (not isinstance(info, dict) or info.get("name") != name
                    or resource_name(info.get("network"), "global/networks") != network):
                raise Blocked("ROUTER_DESCRIBE_IDENTITY_MISMATCH")
            nats = info.get("nats", [])
            if not isinstance(nats, list):
                raise Blocked("ROUTER_NAT_INVENTORY_INVALID")
            for nat in nats:
                if not isinstance(nat, dict):
                    raise Blocked("NAT_RECORD_INVALID")
                nat_count += 1
                coverage = applies(nat, subnet)
                if coverage is True:
                    covered += 1
                elif coverage is None:
                    unknown += 1
        nat_status = ("MATCHING_PUBLIC_NAT_CONFIG_FOUND" if covered > 0
                      else "CONFIG_UNKNOWN" if unknown > 0
                      else "NO_PUBLIC_NAT_COVERING_N2_SUBNET")
        print("N2_SAME_VPC_REGION_ROUTER_COUNT=" + str(len(matching)))
        print("N2_SAME_VPC_REGION_NAT_COUNT=" + str(nat_count))
        print("N2_PUBLIC_NAT_PRIMARY_SUBNET_COVERAGE=" + nat_status)
    except Blocked:
        nat_status = "READ_UNVERIFIED"
        print("N2_PUBLIC_NAT_PRIMARY_SUBNET_COVERAGE=READ_UNVERIFIED")
    try:
        routes = query("routes", "list")
        if not isinstance(routes, list):
            raise Blocked("GCE_ROUTE_INVENTORY_INVALID")
        default_routes = [
            route for route in routes
            if isinstance(route, dict)
            and resource_name(route.get("network"), "global/networks") == network
            and route.get("destRange") == "0.0.0.0/0"
            and str(route.get("nextHopGateway", "")).endswith(
                "/global/gateways/default-internet-gateway")
        ]
        print("N2_VPC_DEFAULT_INTERNET_GATEWAY_ROUTE=" +
              ("PRESENT_IN_STATIC_ROUTE_INVENTORY" if default_routes
               else "NOT_FOUND_IN_STATIC_ROUTE_INVENTORY"))
    except Blocked:
        print("N2_VPC_DEFAULT_INTERNET_GATEWAY_ROUTE=READ_UNVERIFIED")
    if not external and nat_status == "NO_PUBLIC_NAT_COVERING_N2_SUBNET":
        print("N2_DIRECT_EXTERNAL_EGRESS_CONFIGURATION=NO_EXTERNAL_IP_OR_MATCHING_NAT")
        print("N2_SSH_KEYSCAN_FAILURE_CANDIDATE=MISSING_PUBLIC_EGRESS")
    elif external or nat_status == "MATCHING_PUBLIC_NAT_CONFIG_FOUND":
        print("N2_DIRECT_EXTERNAL_EGRESS_CONFIGURATION=PATH_CANDIDATE_PRESENT")
        print("N2_SSH_KEYSCAN_FAILURE_CANDIDATE=CHECK_ROUTE_FIREWALL_AND_TOOL")
    else:
        print("N2_DIRECT_EXTERNAL_EGRESS_CONFIGURATION=UNKNOWN")
        print("N2_SSH_KEYSCAN_FAILURE_CANDIDATE=REQUIRES_FURTHER_INSPECTION")
    print("N2_INSTANCE_PROXY_EGRESS=NOT_INSPECTED")
    print("N2_EFFECTIVE_FIREWALL_AND_DNS_POLICIES=NOT_VERIFIED")
    print("N2_LIVE_SSH_OR_FINGERPRINT=NOT_RETESTED")
    print("GCE_VM_START_STOP_OR_RESOURCE_MUTATION=NONE")
    print("INDEPENDENT_BOOT_BACKUP_AND_ROLLBACK=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0 if nat_status != "READ_UNVERIFIED" else 3


def self_test() -> int:
    base = f"https://compute.googleapis.com/compute/v1/projects/{PROJECT}"
    disk = base + "/zones/" + ZONE + "/disks/n2-boot"
    inst = {"name": VM, "status": "TERMINATED", "deletionProtection": True,
            "selfLink": base + "/zones/" + ZONE + "/instances/" + VM,
            "disks": [{"boot": True, "autoDelete": False, "source": disk}],
            "networkInterfaces": [{"network": base + "/global/networks/default",
                                   "subnetwork": base + "/regions/" + REGION +
                                                 "/subnetworks/default"}]}
    assert parse_vm(inst) == ("default", "default", False)
    inst["networkInterfaces"][0]["accessConfigs"] = [
        {"type": "ONE_TO_ONE_NAT", "natIP": "203.0.113.1"}]
    assert parse_vm(inst)[2] is True
    inst["disks"][0]["autoDelete"] = True
    try:
        parse_vm(inst)
    except Blocked:
        pass
    else:
        raise AssertionError("autoDelete=true accepted")
    assert applies({"sourceSubnetworkIpRangesToNat": "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES"}, "default") is True
    assert applies({"sourceSubnetworkIpRangesToNat": "LIST_OF_SUBNETWORKS",
                    "subnetworks": [{"name": base + "/regions/" + REGION +
                                     "/subnetworks/default",
                                    "sourceIpRangesToNat": ["PRIMARY_IP_RANGE"]}]},
                   "default") is True
    assert applies({"sourceSubnetworkIpRangesToNat": "LIST_OF_SUBNETWORKS",
                    "subnetworks": []}, "default") is False
    assert resource_name("https://evil.example/compute/v1/projects/" + PROJECT +
                         "/global/networks/default", "global/networks") is None
    print("N2_GCE_EGRESS_CONTROLPLANE_OFFLINE_TESTS=PASS")
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
        print("N2_GCE_EGRESS_CONTROLPLANE=BLOCKED_READ_OR_IDENTITY_UNVERIFIED")
        print("GCE_VM_START_STOP_OR_RESOURCE_MUTATION=NONE")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        raise SystemExit(2)
