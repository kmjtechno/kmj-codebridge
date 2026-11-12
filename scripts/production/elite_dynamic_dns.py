#!/usr/bin/env python3
"""KMJ-elite dynamic DNS: keep the few non-tunnel records on the current IPv4.

The website hostnames (kmjtechno.com, www, staging, cloudos) go through the
Cloudflare Tunnel and never need DNS changes. Only these stay IP-bound:

* A    elite-ssh.kmjtechno.com  (DNS only, SSH; host key stays pinned)
* A    mail.kmjtechno.com       (DNS only)
* TXT  kmjtechno.com SPF        (only the "ip4:<old>" token is replaced)

Safety:
* Dry run by default; --apply is required to PATCH anything.
* Never creates or deletes records, never touches proxied/tunnel records,
  never changes any other field than content.
* A record is updated only when it currently holds the IPv4 recorded in the
  state file (or, on first run, the --expect-old value), so an unexpected
  manual change is never overwritten.
* The current public IPv4 is read from Cloudflare's own trace endpoint and
  must be a global IPv4.
* The API token is read from a root-only file and is never printed. Use a
  token restricted to Zone.DNS:Edit on kmjtechno.com only.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ZONE = "kmjtechno.com"
A_RECORDS = ("elite-ssh.kmjtechno.com", "mail.kmjtechno.com")
TRACE_URL = "https://1.1.1.1/cdn-cgi/trace"
API = "https://api.cloudflare.com/client/v4"
TOKEN_FILE = Path("/etc/kmj-elite-ddns/cloudflare.token")
STATE_FILE = Path("/var/lib/kmj-elite-ddns/last-ipv4")
DOTTED = re.compile(r"\A(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\Z")


class Blocked(Exception):
    pass


def require_public_ipv4(value: str) -> str:
    if not isinstance(value, str) or not DOTTED.match(value):
        raise Blocked("INVALID_IPV4")
    if not ipaddress.IPv4Address(value).is_global:
        raise Blocked("NOT_PUBLIC_IPV4")
    return value


def http(method: str, url: str, token: str | None = None, body: dict | None = None) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", "kmj-elite-ddns/1")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=15) as response:
        return response.read(1_000_000)


def current_ipv4(fetch=http) -> str:
    text = fetch("GET", TRACE_URL).decode("utf-8", "replace")
    for line in text.splitlines():
        if line.startswith("ip="):
            return require_public_ipv4(line[3:].strip())
    raise Blocked("TRACE_WITHOUT_IP")


def api(fetch, token: str, method: str, path: str, body: dict | None = None) -> dict:
    payload = json.loads(fetch(method, API + path, token, body).decode("utf-8"))
    if not payload.get("success"):
        raise Blocked("CLOUDFLARE_API_ERROR")
    return payload


def read_token(path: Path) -> str:
    info = path.stat()
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise Blocked("TOKEN_FILE_TOO_OPEN")
    token = path.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", token):
        raise Blocked("TOKEN_FILE_INVALID")
    return token


def plan_updates(fetch, token: str, old_ip: str, new_ip: str) -> list[dict]:
    zones = api(fetch, token, "GET", "/zones?" + urllib.parse.urlencode({"name": ZONE}))["result"]
    if len(zones) != 1:
        raise Blocked("ZONE_NOT_UNIQUE")
    zone = zones[0]["id"]
    updates = []
    for name in A_RECORDS:
        query = urllib.parse.urlencode({"type": "A", "name": name})
        records = api(fetch, token, "GET", f"/zones/{zone}/dns_records?{query}")["result"]
        if len(records) != 1:
            raise Blocked("A_RECORD_NOT_UNIQUE:" + name)
        record = records[0]
        if record.get("proxied"):
            raise Blocked("A_RECORD_PROXIED:" + name)
        if record["content"] == new_ip:
            continue
        if record["content"] != old_ip:
            raise Blocked("A_RECORD_UNEXPECTED_CONTENT:" + name)
        updates.append({"zone": zone, "id": record["id"], "name": name, "type": "A", "content": new_ip})
    query = urllib.parse.urlencode({"type": "TXT", "name": ZONE})
    spf = [r for r in api(fetch, token, "GET", f"/zones/{zone}/dns_records?{query}")["result"]
           if r["content"].strip('"').startswith("v=spf1")]
    if len(spf) != 1:
        raise Blocked("SPF_NOT_UNIQUE")
    content = spf[0]["content"]
    token_old = re.compile(r"(?<![\w.:])ip4:" + re.escape(old_ip) + r"(?![\d./])")
    if ("ip4:" + new_ip) not in content:
        if not token_old.search(content):
            raise Blocked("SPF_WITHOUT_EXPECTED_IP4")
        updates.append({"zone": zone, "id": spf[0]["id"], "name": ZONE, "type": "TXT",
                        "content": token_old.sub("ip4:" + new_ip, content, count=1)})
    return updates


def run(args, fetch=http) -> int:
    new_ip = require_public_ipv4(args.ip) if args.ip else current_ipv4(fetch)
    state = Path(args.state)
    if state.exists():
        old_ip = require_public_ipv4(state.read_text(encoding="utf-8").strip())
    elif args.expect_old:
        old_ip = require_public_ipv4(args.expect_old)
    else:
        raise Blocked("NO_PREVIOUS_IPV4 (pass --expect-old on first run)")
    print("ELITE_DDNS_PREVIOUS=" + old_ip)
    print("ELITE_DDNS_CURRENT=" + new_ip)
    token = read_token(Path(args.token_file))
    updates = [] if old_ip == new_ip else plan_updates(fetch, token, old_ip, new_ip)
    if old_ip == new_ip:
        # Still verify nothing drifted away from the recorded IP.
        plan_updates(fetch, token, old_ip, new_ip)
    for item in updates:
        print("ELITE_DDNS_PLAN=" + item["type"] + " " + item["name"])
    if not updates:
        print("ELITE_DDNS=UNCHANGED")
    elif not args.apply:
        print("ELITE_DDNS=DRY_RUN (add --apply to update)")
        return 0
    else:
        for item in updates:
            api(fetch, token, "PATCH", f"/zones/{item['zone']}/dns_records/{item['id']}",
                {"content": item["content"]})
            print("ELITE_DDNS_UPDATED=" + item["type"] + " " + item["name"])
    if args.apply:
        state.parent.mkdir(parents=True, exist_ok=True)
        tmp = state.with_suffix(".tmp")
        tmp.write_text(new_ip + "\n", encoding="utf-8")
        os.replace(tmp, state)
        print("ELITE_DDNS=APPLIED")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--ip", help="override detected IPv4 (testing)")
    parser.add_argument("--expect-old", help="previous IPv4 on first run")
    parser.add_argument("--token-file", default=str(TOKEN_FILE))
    parser.add_argument("--state", default=str(STATE_FILE))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        print("ELITE_DDNS_SELF_TEST=PASS")
        return 0
    try:
        return run(args)
    except Blocked as error:
        print("ELITE_DDNS=BLOCKED REASON=" + str(error))
        return 2


class FakeCloudflare:
    def __init__(self, ip, records):
        self.ip, self.records, self.calls = ip, records, []

    def __call__(self, method, url, token=None, body=None):
        self.calls.append((method, url, body))
        if url == TRACE_URL:
            return ("fl=1\nip=" + self.ip + "\nts=1\n").encode()
        assert token == "t" * 40, "token not passed"
        path = url[len(API):]
        if path.startswith("/zones?"):
            return json.dumps({"success": True, "result": [{"id": "z"}]}).encode()
        if method == "GET":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
            hits = [r for r in self.records if r["type"] == q["type"][0] and r["name"] == q["name"][0]]
            return json.dumps({"success": True, "result": hits}).encode()
        if method == "PATCH":
            rid = path.rsplit("/", 1)[1]
            assert set(body) == {"content"}, body
            next(r for r in self.records if r["id"] == rid)["content"] = body["content"]
            return json.dumps({"success": True, "result": {}}).encode()
        raise AssertionError("unexpected " + method)


def self_test() -> None:
    import tempfile

    def records():
        return [
            {"id": "1", "type": "A", "name": "elite-ssh.kmjtechno.com", "content": "150.242.200.81", "proxied": False},
            {"id": "2", "type": "A", "name": "mail.kmjtechno.com", "content": "150.242.200.81", "proxied": False},
            {"id": "3", "type": "TXT", "name": ZONE, "content": "v=spf1 ip4:150.242.200.81 include:_spf.mx.cloudflare.net ~all"},
            {"id": "4", "type": "TXT", "name": ZONE, "content": "brevo-code:x"},
        ]

    for bad in ("10.0.0.1", "127.0.0.1", "1.2.3.04", "1.2.3.4;id", ""):
        try:
            require_public_ipv4(bad)
        except Blocked:
            continue
        raise AssertionError(bad)
    with tempfile.TemporaryDirectory() as tmp:
        tok = Path(tmp) / "token"
        tok.write_text("t" * 40)
        os.chmod(tok, 0o644)
        try:
            read_token(tok)
        except Blocked as error:
            assert str(error) == "TOKEN_FILE_TOO_OPEN"
        else:
            raise AssertionError("open token accepted")
        os.chmod(tok, 0o600)
        state = Path(tmp) / "state"
        args = argparse.Namespace(apply=False, ip=None, expect_old="150.242.200.81",
                                  token_file=str(tok), state=str(state))
        fake = FakeCloudflare("8.8.4.4", records())
        assert run(args, fake) == 0 and not any(c[0] == "PATCH" for c in fake.calls)
        assert not state.exists()
        args.apply = True
        assert run(args, fake) == 0
        assert [r["content"] for r in fake.records][:3] == [
            "8.8.4.4", "8.8.4.4", "v=spf1 ip4:8.8.4.4 include:_spf.mx.cloudflare.net ~all"]
        assert fake.records[3]["content"] == "brevo-code:x"
        assert state.read_text().strip() == "8.8.4.4"
        # Idempotent: same IP means no PATCH.
        fake.calls.clear()
        assert run(args, fake) == 0 and not any(c[0] == "PATCH" for c in fake.calls)
        # A manually changed record is never overwritten.
        recs = records()
        recs[1]["content"] = "9.9.9.9"
        state.write_text("150.242.200.81\n")
        fake = FakeCloudflare("8.8.4.4", recs)
        try:
            run(args, fake)
        except Blocked as error:
            assert str(error).startswith("A_RECORD_UNEXPECTED_CONTENT"), error
        else:
            raise AssertionError("overwrote unexpected record")
        assert not any(c[0] == "PATCH" for c in fake.calls)
        # Proxied records are refused.
        recs = records()
        recs[0]["proxied"] = True
        try:
            run(args, FakeCloudflare("8.8.4.4", recs))
        except Blocked as error:
            assert str(error).startswith("A_RECORD_PROXIED"), error
        else:
            raise AssertionError("touched proxied record")
        # Private trace IP is refused.
        try:
            run(args, FakeCloudflare("10.1.2.3", records()))
        except Blocked as error:
            assert str(error) == "NOT_PUBLIC_IPV4"
        else:
            raise AssertionError("accepted private IP")


if __name__ == "__main__":
    sys.exit(main())
