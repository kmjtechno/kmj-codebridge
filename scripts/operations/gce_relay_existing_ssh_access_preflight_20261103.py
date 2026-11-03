#!/usr/bin/env python3
"""Read-only Cloud Shell audit of PREEXISTING Compute Engine SSH authorization.

Targets one existing, running, same-VPC relay, never starts N2 or logs in.
This inventory reads no private keys, never calls gcloud compute ssh or
generates/uploads new keys. Host-key trust and live SSH authentication remain
unverified even if an existing public key is found in metadata/OS Login.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
RELAY = "instance-20260912-094732"
IP = "10.128.0.2"
N2 = "kmj-cloudos-kvm-test"
SAFE_HOSTS = {"compute.googleapis.com", "www.googleapis.com"}
SSH_TYPES = {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256",
             "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"}
SIMPLE_KEY = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")


class Blocked(RuntimeError):
    pass


def gcloud(*args: str, required: bool = True):
    argv = ["gcloud", "compute", *args, "--project=" + PROJECT,
            "--format=json", "--quiet"]
    try:
        p = subprocess.run(argv, capture_output=True, text=True,
                           timeout=45, check=False)
    except (OSError, subprocess.TimeoutExpired):
        if not required:
            return None
        raise Blocked("GCLOUD_READ_UNAVAILABLE_OR_TIMEOUT")
    if p.returncode or len(p.stdout.encode("utf-8")) > 750000:
        if not required:
            return None
        raise Blocked("GCLOUD_READ_FAILED_OR_UNAUTHORIZED")
    try:
        return json.loads(p.stdout)
    except ValueError:
        if not required:
            return None
        raise Blocked("GCLOUD_JSON_INVALID")


def link_path(link):
    if not isinstance(link, str):
        return None
    try:
        u = urlsplit(link)
        if (u.scheme != "https" or u.hostname not in SAFE_HOSTS
                or u.username or u.password or u.port or u.query or u.fragment):
            return None
    except ValueError:
        return None
    prefix = "/compute/v1/projects/" + PROJECT + "/"
    return u.path[len(prefix):] if u.path.startswith(prefix) else None


def metadata_items(obj, field):
    value = obj.get(field, {}) if isinstance(obj, dict) else {}
    items = value.get("items", []) if isinstance(value, dict) else []
    if not isinstance(items, list):
        return {}
    result = {}
    for item in items:
        if (isinstance(item, dict) and isinstance(item.get("key"), str)
                and isinstance(item.get("value"), str)):
            result[item["key"].lower()] = item["value"]
    return result


def key_parts(raw):
    if not isinstance(raw, str) or len(raw) > 8192:
        return None
    parts = raw.strip().split()
    if len(parts) < 2 or parts[0] not in SSH_TYPES:
        return None
    if len(parts[1]) > 4096 or not SIMPLE_KEY.fullmatch(parts[1]):
        return None
    return (parts[0], parts[1])


def local_public_key():
    path = Path.home() / ".ssh/google_compute_engine.pub"
    try:
        st = path.lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid()
                or st.st_mode & 0o022 or st.st_size > 8192):
            return None
        return key_parts(path.read_text(encoding="ascii"))
    except (OSError, UnicodeError):
        return None


def metadata_match(key, text):
    if key is None or not isinstance(text, str):
        return False
    for line in text.splitlines()[:500]:
        if len(line) > 8192:
            continue
        # Metadata SSH lines are USERNAME:keytype base64 [options].
        parts = line.split()
        if not parts or ":" not in parts[0]:
            continue
        _, keytype = parts[0].split(":", 1)
        if len(parts) >= 2 and (keytype, parts[1]) == key:
            return True
    return False


def oslogin_match(key, profile):
    if key is None or not isinstance(profile, dict):
        return None
    keys = profile.get("sshPublicKeys", {})
    if not isinstance(keys, dict):
        return None
    for obj in keys.values():
        if isinstance(obj, dict) and key_parts(obj.get("key")) == key:
            return True
    return False


def inspect():
    node = gcloud("instances", "describe", RELAY, "--zone=" + ZONE)
    if (not isinstance(node, dict) or node.get("name") != RELAY
            or node.get("status") != "RUNNING"
            or link_path(node.get("selfLink"))
            != "zones/" + ZONE + "/instances/" + RELAY):
        raise Blocked("RELAY_GCE_IDENTITY_OR_STATUS_CHANGED")
    nics = node.get("networkInterfaces", [])
    if (not isinstance(nics, list) or len(nics) != 1
            or not isinstance(nics[0], dict)
            or nics[0].get("networkIP") != IP
            or link_path(nics[0].get("network")) != "global/networks/default"
            or link_path(nics[0].get("subnetwork"))
            != "regions/us-central1/subnetworks/default"):
        raise Blocked("RELAY_NIC_IDENTITY_CHANGED")
    n2 = gcloud("instances", "describe", N2, "--zone=" + ZONE)
    if (not isinstance(n2, dict) or n2.get("name") != N2
            or n2.get("status") != "TERMINATED"
            or n2.get("deletionProtection") is not True
            or not isinstance(n2.get("disks"), list)
            or len(n2["disks"]) != 1
            or n2["disks"][0].get("autoDelete") is not False):
        raise Blocked("N2_PROTECTED_TERMINATED_GUARD_FAILED")
    print("RELAY_EXACT_GCE_IDENTITY=RUNNING_VERIFIED")
    print("N2_PROTECTED_TERMINATED=VERIFIED")

    project = gcloud("project-info", "describe", required=False)
    local_meta = metadata_items(node, "metadata")
    project_meta = metadata_items(project, "commonInstanceMetadata")
    enable = local_meta.get("enable-oslogin",
                            project_meta.get("enable-oslogin", "UNSET"))
    if enable.strip().lower() in ("true", "false"):
        mode = "OS_LOGIN" if enable.strip().lower() == "true" else "METADATA"
    elif enable == "UNSET":
        mode = "METADATA_DEFAULT_CANDIDATE"
    else:
        mode = "UNKNOWN"
    print("RELAY_EFFECTIVE_SSH_AUTH_MODE=" + mode)
    block_keys = local_meta.get("block-project-ssh-keys", "false")
    print("RELAY_PROJECT_METADATA_KEYS_BLOCKED=" +
          ("YES" if block_keys.strip().lower() == "true" else
           "NO" if block_keys.strip().lower() == "false" else "UNKNOWN"))

    key = local_public_key()
    print("CLOUD_SHELL_EXISTING_PUBLIC_KEY=" +
          ("PRESENT_LOCAL_PUBLIC_KEY_ONLY" if key else "NOT_VERIFIED"))
    print("CLOUD_SHELL_PRIVATE_KEY=NOT_OPENED_OR_TESTED")
    im = metadata_match(key, local_meta.get("ssh-keys", ""))
    pm = metadata_match(key, project_meta.get("ssh-keys", ""))
    print("RELAY_EXISTING_INSTANCE_METADATA_KEY_MATCH=" +
          ("MATCH" if im else "NO_MATCH_OR_UNVERIFIED"))
    if not isinstance(project, dict):
        print("RELAY_EXISTING_PROJECT_METADATA_KEY_MATCH=READ_UNVERIFIED")
    else:
        print("RELAY_EXISTING_PROJECT_METADATA_KEY_MATCH=" +
              ("MATCH" if pm else "NO_MATCH"))
    if mode == "OS_LOGIN":
        profile = gcloud("os-login", "describe-profile", required=False)
        match = oslogin_match(key, profile)
        print("CLOUD_SHELL_EXISTING_OS_LOGIN_KEY_MATCH=" +
              ("MATCH" if match is True else
               "NO_MATCH" if match is False else "READ_UNVERIFIED"))
    else:
        print("CLOUD_SHELL_EXISTING_OS_LOGIN_KEY_MATCH=NOT_APPLICABLE_OR_UNVERIFIED")

    print("EXISTING_SSH_LOGIN_AND_HOST_KEY_TRUST=NOT_TESTED")
    print("GCLOUD_COMPUTE_SSH_OR_KEY_GENERATION=NOT_ATTEMPTED")
    print("RELAY_TO_ELITE_PINNED_EGRESS=NOT_TESTED")
    print("BACKUP_AND_RESTORE=NOT_VERIFIED")
    print("N2_AND_RELAY_RESOURCE_MUTATIONS=NONE")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def self_test():
    key = ("ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAIGdldW5l")
    assert key_parts(" ".join(key) + " user") == key
    assert metadata_match(key, "username:" + " ".join(key) + " test")
    assert not metadata_match(key, "username:ssh-ed25519 AAAAbad")
    assert oslogin_match(key, {"sshPublicKeys": {"123":{"key":" ".join(key)}}})
    assert oslogin_match(key, {"sshPublicKeys": {}}) is False
    assert key_parts("ssh-rsa !!!") is None
    assert link_path("https://evil.example/compute/v1/projects/" + PROJECT +
                     "/global/networks/default") is None
    print("RELAY_EXISTING_SSH_AUTH_OFFLINE_TESTS=PASS")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif sys.argv[1:] == ["--inspect", PROJECT, ZONE, RELAY]:
        try:
            inspect()
        except (Blocked, OSError, TypeError, ValueError):
            print("RELAY_PREEXISTING_SSH_AUTH_AUDIT=BLOCKED_READ_OR_IDENTITY")
            print("N2_AND_RELAY_RESOURCE_MUTATIONS=NONE")
            print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
            raise SystemExit(2)
    else:
        print("USAGE: script.py --inspect kmj-techno us-central1-a instance-20260912-094732")
        raise SystemExit(64)
