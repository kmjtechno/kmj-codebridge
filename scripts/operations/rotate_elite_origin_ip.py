#!/usr/bin/env python3
"""Rotate the KMJ-elite public origin IPv4 across the repository in one step.

Source of truth: config/elite-origin.json ("ipv4" + "managedFiles").

* Dry run by default; --apply writes files. Only files listed in
  managedFiles are ever rewritten, and only exact occurrences of the current
  IPv4 are replaced. Every managed file must contain the current IPv4,
  otherwise nothing is written (all-or-nothing).
* The SSH ED25519 host-key pin is never changed. A rotated server with a
  different host key therefore still fails closed in the read-only probes.
* No network, DNS, SSH, GCE or Cloudflare call is made by this program.
* Files outside managedFiles that still mention the old IPv4 are reported as
  MANUAL_REVIEW (for example billable-start, SFTP-auth or known_hosts paths
  that must be re-verified by the owner before retargeting).
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path("config/elite-origin.json")
DOTTED = re.compile(r"\A(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\Z")
TEXT_SUFFIXES = {".py", ".sh", ".yml", ".yaml", ".js", ".mjs", ".json", ".md", ".ps1", ".txt", ".conf"}


class Blocked(Exception):
    pass


def require_public_ipv4(value: str) -> str:
    if not isinstance(value, str) or not DOTTED.match(value):
        raise Blocked("INVALID_IPV4")
    address = ipaddress.IPv4Address(value)
    if not address.is_global or address.is_multicast:
        raise Blocked("NOT_PUBLIC_IPV4")
    return value


def boundary(ip: str) -> re.Pattern:
    # Do not touch 1.2.3.45 when rotating 1.2.3.4.
    return re.compile(r"(?<![\d.])" + re.escape(ip) + r"(?![\d])")


def load_config(root: Path) -> dict:
    data = json.loads((root / CONFIG).read_text(encoding="utf-8"))
    if data.get("schema") != 1:
        raise Blocked("CONFIG_SCHEMA")
    require_public_ipv4(data["ipv4"])
    files = data.get("managedFiles")
    if not isinstance(files, list) or not files:
        raise Blocked("CONFIG_MANAGED_FILES")
    for name in files:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or name == str(CONFIG):
            raise Blocked("CONFIG_UNSAFE_PATH")
    return data


def tracked_text_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(["git", "ls-files"], cwd=root, check=True,
                             capture_output=True, text=True, timeout=30).stdout
        names = out.splitlines()
    except (OSError, subprocess.SubprocessError):
        names = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and ".git" not in p.parts]
    return [n for n in names if Path(n).suffix in TEXT_SUFFIXES]


def plan(root: Path, new_ip: str) -> dict:
    require_public_ipv4(new_ip)
    config = load_config(root)
    old_ip = config["ipv4"]
    if new_ip == old_ip:
        raise Blocked("ALREADY_CURRENT")
    pattern = boundary(old_ip)
    changes = {}
    for name in config["managedFiles"]:
        source = (root / name).read_text(encoding="utf-8")
        count = len(pattern.findall(source))
        if count == 0:
            raise Blocked("MANAGED_FILE_WITHOUT_CURRENT_IP:" + name)
        changes[name] = (pattern.sub(new_ip, source), count)
    config_text = (root / CONFIG).read_text(encoding="utf-8")
    new_config = config_text.replace('"ipv4": "' + old_ip + '"', '"ipv4": "' + new_ip + '"', 1)
    if new_config == config_text:
        raise Blocked("CONFIG_IPV4_NOT_REWRITTEN")
    changes[str(CONFIG)] = (new_config, 1)
    managed = set(changes)
    manual = sorted(n for n in tracked_text_files(root)
                    if n not in managed and (root / n).is_file()
                    and pattern.search((root / n).read_text(encoding="utf-8", errors="ignore")))
    return {"old": old_ip, "new": new_ip, "changes": changes, "manual": manual,
            "pin": config["sshEd25519"]}


def apply(root: Path, result: dict) -> None:
    for name, (text, _) in result["changes"].items():
        (root / name).write_text(text, encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--to", dest="new_ip")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("ELITE_IP_ROTATION_SELF_TEST=PASS")
        return 0
    if not args.new_ip:
        parser.error("--to is required")
    try:
        result = plan(ROOT, args.new_ip.strip())
    except Blocked as error:
        print("ELITE_IP_ROTATION=BLOCKED REASON=" + str(error))
        return 2
    print("ELITE_IP_OLD=" + result["old"])
    print("ELITE_IP_NEW=" + result["new"])
    print("SSH_ED25519_PIN_UNCHANGED=" + result["pin"])
    for name, (_, count) in result["changes"].items():
        print("MANAGED_FILE=" + name + " replacements=" + str(count))
    for name in result["manual"]:
        print("MANUAL_REVIEW=" + name)
    if args.apply:
        apply(ROOT, result)
        print("ELITE_IP_ROTATION=APPLIED files=" + str(len(result["changes"])))
    else:
        print("ELITE_IP_ROTATION=DRY_RUN_UNCHANGED (add --apply to write)")
    return 0


def self_test() -> None:
    import tempfile

    for bad in ("10.0.0.1", "127.0.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0",
                "224.0.0.1", "1.2.3.04", "1.2.3", "1.2.3.4;id", "1.2.3.4\n", " 1.2.3.4", "::1", ""):
        try:
            require_public_ipv4(bad)
        except Blocked:
            continue
        raise AssertionError("accepted unsafe ip " + repr(bad))
    assert require_public_ipv4("8.8.4.4") == "8.8.4.4"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "config").mkdir()
        (root / "a").mkdir()
        cfg = {"schema": 1, "ipv4": "1.2.3.4", "sshEd25519": "SHA256:x", "managedFiles": ["a/x.py", "a/y.yml"]}
        (root / CONFIG).write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        (root / "a/x.py").write_text('IP = "1.2.3.4"\nOTHER = "1.2.3.45"\nPIN = "SHA256:x"\n', encoding="utf-8")
        (root / "a/y.yml").write_text("- 'IP = \"1.2.3.4\"'\n", encoding="utf-8")
        (root / "a/z.sh").write_text("ssh 1.2.3.4\n", encoding="utf-8")
        result = plan(root, "8.8.4.4")
        assert result["manual"] == ["a/z.sh"], result["manual"]
        apply(root, result)
        x = (root / "a/x.py").read_text(encoding="utf-8")
        assert 'IP = "8.8.4.4"' in x and '"1.2.3.45"' in x and "SHA256:x" in x
        assert json.loads((root / CONFIG).read_text(encoding="utf-8"))["ipv4"] == "8.8.4.4"
        assert (root / "a/z.sh").read_text(encoding="utf-8") == "ssh 1.2.3.4\n"
        for bad_target, reason in (("8.8.4.4", "ALREADY_CURRENT"), ("10.1.1.1", "NOT_PUBLIC_IPV4")):
            try:
                plan(root, bad_target)
            except Blocked as error:
                assert str(error) == reason, error
            else:
                raise AssertionError("expected block " + reason)
        # All-or-nothing: a managed file missing the current IP blocks every write.
        (root / "a/y.yml").write_text("nothing\n", encoding="utf-8")
        before = (root / "a/x.py").read_text(encoding="utf-8")
        try:
            plan(root, "9.9.9.9")
        except Blocked as error:
            assert str(error).startswith("MANAGED_FILE_WITHOUT_CURRENT_IP"), error
        else:
            raise AssertionError("expected all-or-nothing block")
        assert (root / "a/x.py").read_text(encoding="utf-8") == before
        cfg["managedFiles"] = ["../etc/passwd"]
        (root / CONFIG).write_text(json.dumps(cfg), encoding="utf-8")
        try:
            load_config(root)
        except Blocked:
            pass
        else:
            raise AssertionError("accepted unsafe managed path")


if __name__ == "__main__":
    sys.exit(main())
