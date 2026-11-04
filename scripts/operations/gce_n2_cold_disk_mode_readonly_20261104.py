#!/usr/bin/env python3
"""Read-only exact GCE N2 boot-disk and existing-relay compatibility audit.

NO VM start/stop, SSH, attaching/detaching disks, snapshots, network writes,
secrets, or paid resource creation. Does not approve disk-mode transitions.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
N2 = "kmj-cloudos-kvm-test"
ALLOWED_API_HOSTS = frozenset({"compute.googleapis.com", "www.googleapis.com"})
LABEL = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
MAX_GCLOUD_JSON = 2_000_000


class Blocked(RuntimeError):
    pass


def api_path(raw: object) -> str:
    if not isinstance(raw, str) or len(raw) > 512:
        raise Blocked("UNEXPECTED_COMPUTE_RESOURCE_LINK")
    try:
        url = urlsplit(raw)
    except ValueError as exc:
        raise Blocked("INVALID_COMPUTE_RESOURCE_URL") from exc
    if (url.scheme != "https" or url.hostname not in ALLOWED_API_HOSTS
            or url.username or url.password or url.port
            or url.query or url.fragment):
        raise Blocked("UNTRUSTED_COMPUTE_RESOURCE_URL")
    prefix = "/compute/v1/projects/" + PROJECT + "/"
    if not url.path.startswith(prefix):
        raise Blocked("WRONG_PROJECT_RESOURCE_LINK")
    return url.path[len(prefix):]


def exact_instance(raw: object, name: str = N2) -> bool:
    return (isinstance(raw, dict) and raw.get("name") == name
            and isinstance(name, str) and LABEL.fullmatch(name) is not None
            and api_path(raw.get("selfLink")) == f"zones/{ZONE}/instances/{name}")


def boot_source(n2: object) -> tuple[str, str]:
    if not exact_instance(n2):
        raise Blocked("N2_EXACT_IDENTITY_FAILED")
    if n2.get("status") != "TERMINATED" or n2.get("deletionProtection") is not True:
        raise Blocked("N2_NOT_TERMINATED_OR_DELETE_PROTECTED")
    disks = n2.get("disks")
    if not isinstance(disks, list) or len(disks) != 1 or not isinstance(disks[0], dict):
        raise Blocked("N2_BOOT_DISK_NOT_UNIQUE")
    d = disks[0]
    if d.get("boot") is not True or d.get("autoDelete") is not False:
        raise Blocked("N2_BOOT_OR_AUTO_DELETE_POLICY_CHANGED")
    mode = d.get("mode")
    if mode not in ("READ_WRITE", "READ_ONLY"):
        raise Blocked("N2_DISK_ATTACHMENT_MODE_UNVERIFIED")
    src = api_path(d.get("source"))
    prefix = f"zones/{ZONE}/disks/"
    if not src.startswith(prefix) or not LABEL.fullmatch(src[len(prefix):]):
        raise Blocked("N2_BOOT_DISK_OUT_OF_ZONE")
    return src[len(prefix):], mode


def disk_metadata(disk: object, disk_name: str, mode: str) -> dict:
    if not isinstance(disk, dict) or disk.get("name") != disk_name:
        raise Blocked("SOURCE_DISK_NAME_CHANGED")
    if api_path(disk.get("selfLink")) != f"zones/{ZONE}/disks/{disk_name}":
        raise Blocked("SOURCE_DISK_RESOURCE_MISMATCH")
    if api_path(disk.get("type")) != f"zones/{ZONE}/diskTypes/pd-standard":
        raise Blocked("SOURCE_DISK_NOT_EXPECTED_PD_STANDARD")
    size = disk.get("sizeGb")
    if type(size) not in (str, int) or str(size) != "30":
        raise Blocked("SOURCE_DISK_NOT_EXPECTED_30GB")
    if disk.get("status") != "READY":
        raise Blocked("SOURCE_DISK_NOT_READY")
    users = disk.get("users")
    if (not isinstance(users, list) or len(users) != 1
            or api_path(users[0]) != f"zones/{ZONE}/instances/{N2}"):
        raise Blocked("SOURCE_DISK_USERS_OR_ATTACHMENT_CHANGED")
    return {
        "source_disk": disk_name,
        "disk_size_gb": 30,
        "attachment_mode": mode,
        # This is a logical eligibility fact, NOT a permission to change mode.
        "mixed_mode_conflict": mode == "READ_WRITE",
    }


def same_zone_relay_candidates(listing: object, original: object) -> list[str]:
    if not isinstance(listing, list) or len(listing) > 10000:
        raise Blocked("RELAY_VM_INVENTORY_INVALID")
    nics = original.get("networkInterfaces")
    if not isinstance(nics, list) or len(nics) != 1 or not isinstance(nics[0], dict):
        raise Blocked("N2_NETWORK_IDENTITY_NOT_UNIQUE")
    expected = api_path(nics[0].get("network"))
    candidates = []
    seen = set()
    for item in listing:
        if not isinstance(item, dict):
            raise Blocked("RELAY_VM_ROW_INVALID")
        name = item.get("name")
        if not isinstance(name, str) or not LABEL.fullmatch(name):
            raise Blocked("RELAY_VM_NAME_INVALID")
        if name == N2 or item.get("status") != "RUNNING":
            continue
        try:
            if not exact_instance(item, name):
                continue
            nic = item.get("networkInterfaces")
            if not isinstance(nic, list) or len(nic) != 1:
                continue
            if api_path(nic[0].get("network")) != expected:
                continue
        except (Blocked, TypeError):
            continue
        if name in seen:
            raise Blocked("DUPLICATE_RELAY_INVENTORY")
        seen.add(name)
        candidates.append(name)
    return sorted(candidates)


def gcloud(*args: str) -> object:
    try:
        r = subprocess.run(
            ["gcloud", "compute", *args, "--project=" + PROJECT,
             "--format=json", "--quiet"],
            capture_output=True, text=True, timeout=65, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("GCLOUD_READ_UNAVAILABLE") from exc
    if r.returncode or len(r.stdout.encode("utf-8")) > MAX_GCLOUD_JSON:
        raise Blocked("GCLOUD_READ_FAILED_OR_OVERSIZE")
    try:
        return json.loads(r.stdout)
    except (ValueError, UnicodeError) as exc:
        raise Blocked("INVALID_GCLOUD_JSON") from exc


def inspect() -> int:
    n2 = gcloud("instances", "describe", N2, "--zone=" + ZONE)
    disk_name, mode = boot_source(n2)
    disk = gcloud("disks", "describe", disk_name, "--zone=" + ZONE)
    metadata = disk_metadata(disk, disk_name, mode)
    listing = gcloud("instances", "list")
    candidates = same_zone_relay_candidates(listing, n2)
    print("N2_SOURCE_PROJECT_ZONE_INSTANCE=EXACT_VERIFIED")
    print("N2_PROTECTED_TERMINATED=PASS_READ_ONLY_GCE_INVENTORY")
    print("N2_BOOT_DISK_STANDARD_PD_30GB=PASS_READ_ONLY_GCE_INVENTORY")
    print("N2_BOOT_DISK_SOURCE_NAME=" + metadata["source_disk"])
    print("N2_BOOT_DISK_ATTACHMENT_MODE=" + mode)
    print("N2_BOOT_DISK_SAME_MODE_RO_SHARE_CONFLICT=" +
          ("YES_EXISTING_RW_ATTACHMENT" if metadata["mixed_mode_conflict"] else
           "NO_MODE_CONFLICT_OBSERVED_ONLY"))
    print("N2_SAME_ZONE_RUNNING_RELAY_CANDIDATES=" + str(len(candidates)))
    for i, name in enumerate(candidates[:12], 1):
        print("N2_RELAY_CANDIDATE_" + str(i) + "=" + name)
    print("N2_READ_ONLY_ATTACHMENT_OR_DETACH=NOT_AUTHORIZED_NOT_ATTEMPTED")
    print("N2_DISK_MODE_TRANSITION_ROLLBACK=NOT_VERIFIED")
    print("N2_RELAY_BACKUP_EGRESS_ZERO_COST=NOT_VERIFIED")
    print("N2_CONSISTENT_ENCRYPTED_DISK_BACKUP=NOT_ATTEMPTED")
    print("N2_INDEPENDENT_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED")
    print("GCE_RESOURCE_MUTATIONS=NONE_BY_THIS_PROGRAM")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0


def self_test() -> int:
    base = f"https://compute.googleapis.com/compute/v1/projects/{PROJECT}/"
    disk_name = "n2-preserved-boot"
    n2 = {
        "name": N2, "selfLink": base + f"zones/{ZONE}/instances/{N2}",
        "status": "TERMINATED", "deletionProtection": True,
        "disks": [{"boot": True, "autoDelete": False, "mode": "READ_WRITE",
                   "source": base + f"zones/{ZONE}/disks/{disk_name}"}],
        "networkInterfaces": [{"network": base + "global/networks/default"}],
    }
    disk = {
        "name": disk_name, "selfLink": base + f"zones/{ZONE}/disks/{disk_name}",
        "type": base + f"zones/{ZONE}/diskTypes/pd-standard",
        "status": "READY", "sizeGb": "30",
        "users": [base + f"zones/{ZONE}/instances/{N2}"],
    }
    assert boot_source(n2) == (disk_name, "READ_WRITE")
    assert disk_metadata(disk, disk_name, "READ_WRITE")["mixed_mode_conflict"]
    bads = (
        {**n2, "status": "RUNNING"},
        {**n2, "deletionProtection": False},
        {**n2, "disks": [{**n2["disks"][0], "autoDelete": True}]},
        {**n2, "disks": [{**n2["disks"][0], "source":
             base + "zones/us-central1-b/disks/" + disk_name}]},
    )
    for bad in bads:
        try:
            boot_source(bad)
        except Blocked:
            pass
        else:
            raise AssertionError("UNSAFE_PROTECTED_N2_ACCEPTED")
    for bad in (
        {**disk, "sizeGb": "32"},
        {**disk, "users": []},
        {**disk, "type": base + f"zones/{ZONE}/diskTypes/pd-ssd"},
    ):
        try:
            disk_metadata(bad, disk_name, "READ_WRITE")
        except Blocked:
            pass
        else:
            raise AssertionError("UNTRUSTED_BOOT_DISK_ACCEPTED")
    relay = {
        "name": "instance-20260912-094732",
        "selfLink": base + f"zones/{ZONE}/instances/instance-20260912-094732",
        "status": "RUNNING", "networkInterfaces": [{
            "network": base + "global/networks/default"
        }],
    }
    assert same_zone_relay_candidates([relay, n2], n2) == [relay["name"]]
    assert same_zone_relay_candidates([{**relay, "status": "TERMINATED"}], n2) == []
    assert same_zone_relay_candidates([{
        **relay, "selfLink": base +
        "zones/us-central1-b/instances/" + relay["name"]
    }], n2) == []
    print("N2_COLD_DISK_MODE_READONLY_OFFLINE_TESTS=PASS")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--self-test"]:
            raise SystemExit(self_test())
        if sys.argv[1:] != ["--inspect", PROJECT, ZONE, N2]:
            print("USAGE: script.py --self-test | --inspect kmj-techno us-central1-a kmj-cloudos-kvm-test")
            raise SystemExit(64)
        raise SystemExit(inspect())
    except (Blocked, OSError, TypeError, ValueError):
        print("N2_COLD_DISK_MODE_AUDIT=BLOCKED")
        print("GCE_RESOURCE_MUTATIONS=NONE_BY_THIS_PROGRAM")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        raise SystemExit(2)
