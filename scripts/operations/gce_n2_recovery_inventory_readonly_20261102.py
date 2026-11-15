#!/usr/bin/env python3
"""GCE N2 backup-candidate inventory. Read-only: no VM start, write, or new costs.

Enumerates existing Compute Engine standard/archive snapshots, machine images,
custom images and zonal instant snapshots. Results are candidate inventories,
NOT restore evidence. Does not inspect Cloud Storage, Backup and DR, offsite
vaults or customers' application data.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
VM = "kmj-cloudos-kvm-test"
MAX_BYTES = 3_000_000
RESOURCE = re.compile(r"^[a-z][a-z0-9-]{0,62}$")


def suffix(value: object, resource: str) -> str | None:
    """Extract validated last component only if project and kind match."""
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("https://"):
        u = urlsplit(value)
        if (u.hostname not in ("compute.googleapis.com", "www.googleapis.com")
                or u.username or u.password or u.port or u.query or u.fragment):
            return None
        path = u.path.lstrip("/")
        if not path.startswith("compute/v1/"):
            return None
        value = path[len("compute/v1/"):]
    prefix = f"projects/{PROJECT}/zones/{ZONE}/{resource}/"
    if value.startswith(prefix):
        name = value[len(prefix):]
    elif value.startswith(f"zones/{ZONE}/{resource}/"):
        name = value[len(f"zones/{ZONE}/{resource}/"):]
    else:
        return None
    return name if RESOURCE.fullmatch(name) else None


def read(parts: list[str], *, zonal: bool = False) -> object:
    args = ["gcloud", "compute", *parts, f"--project={PROJECT}", "--format=json", "--quiet"]
    if zonal:
        args.append(f"--zone={ZONE}")
    try:
        proc = subprocess.run(args, capture_output=True, text=True,
                              timeout=50, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("GCLOUD_READ_UNAVAILABLE") from exc
    if proc.returncode or len(proc.stdout.encode("utf-8")) > MAX_BYTES:
        raise RuntimeError("GCLOUD_READ_FAILED")
    try:
        return json.loads(proc.stdout)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError("INVALID_JSON") from exc


def same_source(obj: dict, field: str, resource: str, name: str, source_id: object) -> bool:
    if suffix(obj.get(field), resource) != name:
        return False
    claimed = obj.get(field + "Id")
    return claimed is None or (source_id is not None and str(claimed) == str(source_id))


def list_candidates(
    kind: str, parts: list[str], check, *, zonal: bool = False
) -> int | None:
    try:
        rows = read(parts, zonal=zonal)
        if not isinstance(rows, list) or len(rows) > 5000:
            raise RuntimeError("INVALID_INVENTORY_SHAPE")
        matched = sum(bool(check(x)) for x in rows if isinstance(x, dict))
        if any(not isinstance(x, dict) for x in rows):
            raise RuntimeError("INVALID_INVENTORY_ITEM")
    except (RuntimeError, TypeError, ValueError):
        print(f"{kind}=UNKNOWN_READ_UNAVAILABLE")
        return None
    print(f"{kind}={matched}")
    return matched


def inventory() -> int:
    inst = read(["instances", "describe", VM], zonal=True)
    if (not isinstance(inst, dict) or inst.get("name") != VM
            or inst.get("status") != "TERMINATED"
            or suffix(inst.get("selfLink"), "instances") != VM
            or not isinstance(inst.get("disks"), list)
            or len(inst["disks"]) != 1
            or inst["disks"][0].get("boot") is not True):
        raise RuntimeError("INSTANCE_IDENTITY_STATE_OR_DISKS_UNVERIFIED")
    boot_link = inst["disks"][0].get("source")
    disk_name = suffix(boot_link, "disks")
    if not disk_name:
        raise RuntimeError("BOOT_DISK_SOURCE_UNVERIFIED")
    disk = read(["disks", "describe", disk_name], zonal=True)
    if (not isinstance(disk, dict)
            or disk.get("name") != disk_name
            or suffix(disk.get("selfLink"), "disks") != disk_name
            or str(disk.get("sizeGb")) != "30"
            or not isinstance(disk.get("users"), list)
            or len(disk["users"]) != 1
            or suffix(disk["users"][0], "instances") != VM):
        raise RuntimeError("BOOT_DISK_IDENTITY_OR_ATTACHMENT_UNVERIFIED")
    disk_id = disk.get("id")
    instance_id = inst.get("id")
    print("N2_INSTANCE=TERMINATED_VERIFIED")
    print("N2_BOOT_DISK=ONE_ATTACHED_30GB_VERIFIED")
    print("N2_BOOT_DISK_AUTO_DELETE_ON_VM_DELETE=" +
          str(inst["disks"][0].get("autoDelete", "UNKNOWN")).upper())

    standard = list_candidates(
        "GCE_STANDARD_ARCHIVE_SNAPSHOT_CANDIDATES",
        ["snapshots", "list"],
        lambda x: x.get("status") == "READY"
        and same_source(x, "sourceDisk", "disks", disk_name, disk_id),
    )
    machine = list_candidates(
        "GCE_MACHINE_IMAGE_CANDIDATES",
        ["machine-images", "list"],
        lambda x: x.get("status") == "READY"
        and same_source(x, "sourceInstance", "instances", VM, instance_id)
        and isinstance(x.get("savedDisks"), list)
        and any(same_source(v, "sourceDisk", "disks", disk_name, disk_id)
                for v in x["savedDisks"] if isinstance(v, dict)),
    )
    custom = list_candidates(
        "GCE_CUSTOM_DISK_IMAGE_CANDIDATES",
        ["images", "list", "--no-standard-images"],
        lambda x: x.get("status") == "READY"
        and same_source(x, "sourceDisk", "disks", disk_name, disk_id),
    )
    instant = list_candidates(
        "GCE_ZONAL_INSTANT_SNAPSHOT_CANDIDATES",
        ["instant-snapshots", "list", f"--zones={ZONE}"],
        lambda x: x.get("status") == "READY"
        and same_source(x, "sourceDisk", "disks", disk_name, disk_id),
    )
    if any(v is None for v in (standard, machine, custom, instant)):
        print("N2_GCE_BACKUP_INVENTORY=PARTIAL_READ_UNVERIFIED")
    else:
        print("N2_GCE_BACKUP_INVENTORY=COMPLETE_LISTS_READ_ONLY")
    print("INSTANT_SNAPSHOT_OFFSITE_PROTECTION=NO")
    print("OTHER_PROJECTS_CLOUD_STORAGE_BACKUP_DR_VAULTS=NOT_INSPECTED")
    print("INDEPENDENT_DISPOSABLE_RESTORE=NOT_VERIFIED")
    print("N2_BACKUP_ROLLBACK_RELEASE_GATE=BLOCKED")
    print("GCE_VM_START_STOP_OR_RESOURCE_MUTATION=NONE")
    return 0 if all(v is not None for v in (standard, machine, custom, instant)) else 3


def self_test() -> int:
    base = f"projects/{PROJECT}/zones/{ZONE}/disks/boot-disk"
    u = "https://compute.googleapis.com/compute/v1/" + base
    assert suffix(u, "disks") == "boot-disk"
    assert suffix(base, "disks") == "boot-disk"
    assert suffix("zones/" + ZONE + "/disks/boot-disk", "disks") == "boot-disk"
    assert suffix("https://evil.example/compute/v1/" + base, "disks") is None
    assert suffix(u + "?token=hidden", "disks") is None
    assert suffix(f"projects/different/zones/{ZONE}/disks/boot-disk", "disks") is None
    assert suffix(u, "instances") is None
    assert same_source({"sourceDisk": u, "sourceDiskId": "123"},
                       "sourceDisk", "disks", "boot-disk", 123)
    assert not same_source({"sourceDisk": u, "sourceDiskId": "999"},
                           "sourceDisk", "disks", "boot-disk", 123)
    assert not same_source({"sourceDisk": u}, "sourceDisk", "disks", "other", 123)
    print("N2_RECOVERY_INVENTORY_SOURCE_TEST=PASS")
    return 0


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if sys.argv[1:] != [PROJECT, ZONE, VM]:
        print("REFUSE_OTHER_PROJECT_ZONE_INSTANCE")
        return 64
    try:
        return inventory()
    except (RuntimeError, ValueError, TypeError, AttributeError):
        print("N2_GCE_BACKUP_INVENTORY=BLOCKED_INSTANCE_OR_DISK_UNVERIFIED")
        print("N2_BACKUP_ROLLBACK_RELEASE_GATE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
