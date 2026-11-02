#!/usr/bin/env python3
"""Protect the *existing* KMJ CloudOS N2 lab from accidental GCE deletion.

Changes only two existing-resource metadata flags: autoDelete=false for the
single verified boot disk; deletionProtection=true for the exact stopped VM.
Does not start/stop the VM or create disks, snapshots or other GCE resources.
This DOES NOT create a backup, make disks immune to explicit deletion, or
qualify production. A retained disk can continue to incur storage charges
after a later intentional VM deletion.
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
NAME = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
HOSTS = frozenset({"compute.googleapis.com", "www.googleapis.com"})


class Blocked(RuntimeError):
    pass


def exact_name(link: object, kind: str) -> str | None:
    if not isinstance(link, str):
        return None
    try:
        url = urlsplit(link)
        if (url.scheme != "https" or url.hostname not in HOSTS
                or url.username or url.password or url.port
                or url.query or url.fragment):
            return None
    except ValueError:
        return None
    prefix = f"/compute/v1/projects/{PROJECT}/zones/{ZONE}/{kind}/"
    if not url.path.startswith(prefix):
        return None
    tail = url.path[len(prefix):]
    return tail if NAME.fullmatch(tail) else None


def gcloud(*args: str, json_output: bool = False) -> object:
    argv = ["gcloud", "compute", *args,
            f"--project={PROJECT}", f"--zone={ZONE}", "--quiet"]
    if json_output:
        argv.append("--format=json")
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=75, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("GCLOUD_UNAVAILABLE_OR_TIMEOUT") from exc
    if proc.returncode:
        raise Blocked("GCLOUD_ACTION_FAILED")
    if not json_output:
        return None
    if len(proc.stdout.encode("utf-8")) > 65536:
        raise Blocked("OVERSIZE_GCLOUD_RESPONSE")
    try:
        data = json.loads(proc.stdout)
    except (ValueError, UnicodeError) as exc:
        raise Blocked("INVALID_GCLOUD_JSON") from exc
    if not isinstance(data, dict):
        raise Blocked("INVALID_GCLOUD_JSON_OBJECT")
    return data


def identity(instance: dict, disk: dict) -> dict:
    if (instance.get("name") != VM
            or exact_name(instance.get("selfLink"), "instances") != VM
            or exact_name(instance.get("machineType"), "machineTypes") != "n2-standard-2"
            or instance.get("status") != "TERMINATED"):
        raise Blocked("N2_INSTANCE_IDENTITY_OR_STATUS_MISMATCH")
    attachments = instance.get("disks")
    if (not isinstance(attachments, list) or len(attachments) != 1
            or not isinstance(attachments[0], dict)):
        raise Blocked("N2_BOOT_DISK_TOPOLOGY_MISMATCH")
    boot = attachments[0]
    name = exact_name(boot.get("source"), "disks")
    if (boot.get("boot") is not True or name is None
            or type(boot.get("autoDelete")) is not bool):
        raise Blocked("N2_BOOT_DISK_IDENTITY_UNVERIFIED")
    if (disk.get("name") != name
            or exact_name(disk.get("selfLink"), "disks") != name
            or str(disk.get("sizeGb")) != "30"
            or not isinstance(disk.get("users"), list)
            or len(disk["users"]) != 1
            or exact_name(disk["users"][0], "instances") != VM):
        raise Blocked("N2_BOOT_DISK_ATTACHMENT_MISMATCH")
    protection = instance.get("deletionProtection")
    if type(protection) is not bool:
        raise Blocked("N2_DELETION_PROTECTION_UNVERIFIED")
    return {"disk": name, "auto_delete": boot["autoDelete"],
            "deletion_protection": protection}


def snapshot() -> dict:
    instance = gcloud("instances", "describe", VM, json_output=True)
    if (instance.get("name") != VM
            or instance.get("status") != "TERMINATED"
            or exact_name(instance.get("selfLink"), "instances") != VM
            or not isinstance(instance.get("disks"), list)
            or len(instance["disks"]) != 1
            or not isinstance(instance["disks"][0], dict)):
        raise Blocked("N2_INSTANCE_PRECHECK_UNVERIFIED")
    diskname = exact_name(instance["disks"][0].get("source"), "disks")
    if diskname is None:
        raise Blocked("N2_DISK_SOURCE_PRECHECK_UNVERIFIED")
    disk = gcloud("disks", "describe", diskname, json_output=True)
    return identity(instance, disk)


def protect() -> int:
    before = snapshot()
    print("N2_INSTANCE_PRECHECK=TERMINATED_EXACT_ID_VERIFIED", flush=True)
    print("N2_BOOT_DISK_PRECHECK=ATTACHED_30GB_EXACT_ID_VERIFIED", flush=True)
    if before["auto_delete"]:
        # No VM start, disk/snapshot creation, or data write. Preserve this
        # existing boot disk even if the instance is later deleted.
        gcloud("instances", "set-disk-auto-delete", VM, "--no-auto-delete",
               f"--disk={before['disk']}")
        intermediate = snapshot()
        if intermediate["disk"] != before["disk"] or intermediate["auto_delete"]:
            raise Blocked("BOOT_DISK_AUTO_DELETE_CHANGE_NOT_VERIFIED")
    else:
        intermediate = before
    print("N2_BOOT_DISK_AUTO_DELETE=FALSE_VERIFIED", flush=True)

    if not intermediate["deletion_protection"]:
        gcloud("instances", "update", VM, "--deletion-protection")
    after = snapshot()
    if (after["disk"] != before["disk"] or after["auto_delete"]
            or not after["deletion_protection"]):
        raise Blocked("FINAL_DELETION_GUARDS_NOT_VERIFIED")
    print("N2_VM_DELETION_PROTECTION=TRUE_VERIFIED")
    print("N2_FINAL_STATE=TERMINATED")
    print("NEW_DISKS_SNAPSHOTS_INSTANCES=NONE")
    print("EXISTING_BOOT_DISK_STORAGE_CHARGES=CONTINUE")
    print("RECOVERABLE_BACKUP_AND_INDEPENDENT_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0


def self_test() -> int:
    url = f"https://compute.googleapis.com/compute/v1/projects/{PROJECT}/zones/{ZONE}/"
    disk_name = "kmj-cloudos-boot"
    instance = {
        "name": VM, "status": "TERMINATED",
        "selfLink": url + "instances/" + VM,
        "machineType": url + "machineTypes/n2-standard-2",
        "deletionProtection": False,
        "disks": [{"boot": True, "autoDelete": True,
                   "source": url + "disks/" + disk_name}],
    }
    disk = {"name": disk_name, "selfLink": url + "disks/" + disk_name,
            "sizeGb": "30", "users": [url + "instances/" + VM]}
    assert identity(instance, disk) == {
        "disk": disk_name, "auto_delete": True, "deletion_protection": False
    }
    assert exact_name(url + "disks/" + disk_name, "disks") == disk_name
    for invalid in (
        url + "disks/" + disk_name + "?token=secret",
        url.replace("compute.googleapis.com", "evil.example") + "disks/" + disk_name,
        url.replace(PROJECT, "other-project") + "disks/" + disk_name,
        url.replace(ZONE, "us-west1-a") + "disks/" + disk_name,
        url + "instances/" + disk_name,
    ):
        assert exact_name(invalid, "disks") is None
    for mutated_instance, mutated_disk in (
        ({**instance, "status": "RUNNING"}, disk),
        ({**instance, "disks": [{**instance["disks"][0], "autoDelete": "true"}]}, disk),
        ({**instance, "deletionProtection": None}, disk),
        (instance, {**disk, "sizeGb": "99"}),
        (instance, {**disk, "users": []}),
    ):
        try:
            identity(mutated_instance, mutated_disk)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe instance or disk was accepted")
    print("N2_DELETION_GUARD_HERMETIC_TESTS=PASS")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if sys.argv[1:] != ["--protect", PROJECT, ZONE, VM]:
        print("USAGE: script --protect kmj-techno us-central1-a kmj-cloudos-kvm-test")
        return 64
    try:
        return protect()
    except Blocked as exc:
        print("N2_DELETION_GUARDS=BLOCKED_" + str(exc))
        print("N2_ACTION=REINSPECT_CURRENT_GCE_STATE_BEFORE_RETRY")
        print("RECOVERABLE_BACKUP_AND_INDEPENDENT_RESTORE=NOT_VERIFIED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
