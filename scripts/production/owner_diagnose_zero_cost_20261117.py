#!/usr/bin/env python3
"""Owner-root READ-ONLY stage diagnostic for the FreeLLMAPI zero-cost verifier.

Runs the verifier's stages one by one as the agent's own service user, with the
agent's verifier env, and prints only stage names, OK/FAIL and short error
codes (plus non-secret account counters). It never prints the OpenRouter key,
writes nothing, restarts nothing and sends no prompt: only two authenticated
GETs to openrouter.ai (/api/v1/key and /api/v1/models), like the verifier.

Usage: python3 -I owner_diagnose_zero_cost_20261117.py auto:or-free
"""
import json
import os
import pathlib
import re
import subprocess
import sys

UNIT = "kmj-codebridge-kmj-main-platform.service"
ENV_FILE = pathlib.Path("/etc/kmj-freellmapi/codebridge.env")
NODE = "/opt/kmj-codebridge-node/bin/node"
CHAIN_RE = re.compile(r"^auto:[A-Za-z0-9._-]{1,48}$")
WANTED = (
    "CODEBRIDGE_OPENROUTER_KEY",
    "CODEBRIDGE_FREELLMAPI_PINS_DIR",
    "CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR",
)

STAGE_JS = r'''
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
const dir = process.env.DIAG_DIR;
const chain = process.env.DIAG_CHAIN;
const name = chain.slice(5);
const imp = (f) => import(pathToFileURL(path.join(dir, "src", f)).href);
const code = (e) =>
  String(e?.code ?? e?.message ?? "ERR").replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 60);
let stageFailed = false;
const out = (stage, ok, detail = "") => {
  if (!ok) stageFailed = true;
  console.log(stage + "=" + (ok ? "OK" : "FAIL") + (detail ? " " + detail : ""));
};
out("PROCESS_UID", true, String(process.getuid()));
let pinned = null;
try {
  const pin = JSON.parse(
    await readFile(path.join(process.env.CODEBRIDGE_FREELLMAPI_PINS_DIR, "route-binding-" + name + ".json"), "utf8"));
  pinned = pin.models;
  out("PIN_READ", Array.isArray(pinned), "models=" + (pinned?.length ?? "none"));
} catch (e) { out("PIN_READ", false, code(e)); }
try {
  const snap = JSON.parse(
    await readFile(path.join(process.env.CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR, name + ".json"), "utf8"));
  out("SNAPSHOT_READ", true, "ageMs=" + (Date.now() - snap.observedAtEpochMs));
} catch (e) { out("SNAPSHOT_READ", false, code(e)); }
let fetcher, evidence, verifierMod, snapMod;
try {
  const f = await imp("openrouter-evidence-fetcher.js");
  evidence = await imp("openrouter-free-evidence.js");
  verifierMod = await imp("freellmapi-zero-cost-verifier.js");
  snapMod = await imp("freellmapi-chain-snapshot.js");
  fetcher = f.createOpenRouterEvidenceFetcher({ apiKey: process.env.CODEBRIDGE_OPENROUTER_KEY });
  out("MODULES", true);
} catch (e) { out("MODULES", false, code(e)); process.exit(2); }
try {
  const cat = await fetcher.fetchOpenRouterModels();
  const rows = Array.isArray(cat?.data) ? cat.data : [];
  out("OPENROUTER_MODELS", true, "rows=" + rows.length);
  for (const id of pinned ?? []) {
    const row = rows.find((r) => r?.id === id);
    out("MODEL " + id, Boolean(row && evidence.isVerifiedFreeModel(row)), row ? "listed" : "not_listed");
  }
} catch (e) { out("OPENROUTER_MODELS", false, code(e)); }
try {
  const res = await fetcher.fetchOpenRouterKey();
  const ev = evidence.evaluateAccountEvidence(res);
  out("OPENROUTER_KEY_EVIDENCE", ev.ok, "reasons=" + (ev.reasons.join(",") || "none"));
  const d = res?.data ?? {};
  const num = (v) => (typeof v === "number" ? String(v) : typeof v);
  console.log("KEY_COUNTERS usage=" + num(d.usage) + " daily=" + num(d.usage_daily) +
    " byok=" + num(d.byok_usage) + " is_free_tier=" + String(d.is_free_tier) +
    " limit_remaining=" + num(d.limit_remaining));
  const q = d.free_model_daily_requests;
  console.log("FREE_DAILY " + (q && typeof q === "object"
    ? "used=" + num(q.used) + " limit=" + num(q.limit) + " remaining=" + num(q.remaining)
    : "missing"));
} catch (e) { out("OPENROUTER_KEY_EVIDENCE", false, code(e)); }
try {
  const read = (p) => readFile(p, "utf8");
  const verify = verifierMod.createZeroCostVerifier({
    readManifest: async (c) => JSON.parse(await read(path.join(process.env.CODEBRIDGE_FREELLMAPI_PINS_DIR, "route-binding-" + c.slice(5) + ".json"))),
    readLiveChainMembers: snapMod.createChainSnapshotReader({
      readSnapshot: (c) => read(path.join(process.env.CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR, c.slice(5) + ".json")) }),
    ...fetcher,
  });
  const proof = await verify({ chain, observedAtEpochMs: Date.now() });
  out("VERIFIER", true, "requestsRemaining=" + proof.requestsRemaining);
} catch (e) { out("VERIFIER", false, code(e)); }
if (stageFailed) process.exitCode = 2;
'''


def guard(ok, code):
    if not ok:
        raise ValueError(code)


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=30,
                          check=False).stdout.strip()


def agent_code_dir():
    candidates = []
    working = sh("systemctl", "show", "-p", "WorkingDirectory", "--value", UNIT)
    if working:
        candidates.append(working)
    candidates.append(os.path.realpath("/opt/kmj-codebridge-stable/current"))
    for path in candidates:
        if os.path.isfile(os.path.join(path, "src", "freellmapi-runtime.js")):
            return path
    raise ValueError("AGENT_CODE_DIR_NOT_FOUND")


def verifier_env():
    values = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        if key in WANTED:
            values[key] = value
    guard(set(values) == set(WANTED), "VERIFIER_ENV_INCOMPLETE")
    return values


def runuser_path():
    # Absolute path: the child env deliberately has a minimal PATH, and
    # runuser lives in /usr/sbin on Debian/Ubuntu.
    for candidate in ("/usr/sbin/runuser", "/sbin/runuser", "/usr/bin/runuser"):
        if os.path.isfile(candidate):
            return candidate
    raise ValueError("RUNUSER_NOT_FOUND")


def main():
    guard(os.geteuid() == 0, "ROOT_REQUIRED")
    guard(len(sys.argv) == 2 and CHAIN_RE.match(sys.argv[1]), "USAGE_<chain>")
    chain = sys.argv[1]
    user = sh("systemctl", "show", "-p", "User", "--value", UNIT)
    guard(re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user or ""), "AGENT_USER_UNKNOWN")
    code_dir = agent_code_dir()
    env = {"PATH": "/usr/bin:/bin", "DIAG_DIR": code_dir, "DIAG_CHAIN": chain,
           **verifier_env()}
    print(f"AGENT_USER={user}")
    result = subprocess.run(
        [runuser_path(), "-u", user, "--", NODE, "--input-type=module", "-e", STAGE_JS],
        env=env, capture_output=True, text=True, timeout=90, check=False)
    print(result.stdout.rstrip())
    if result.returncode:
        print("NODE_EXIT=" + str(result.returncode))
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        print(f"BLOCKED={exc}")
        sys.exit(2)
