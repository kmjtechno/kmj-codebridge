import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const DIR = "scripts/production/";
const AUTO = DIR + "owner_elite_auto_release.py";
const INSTALL = DIR + "owner_install_elite_auto_release.py";
const auto = fs.readFileSync(AUTO, "utf8");
const install = fs.readFileSync(INSTALL, "utf8");
const sha = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function py(file, body) {
  const code = `
import importlib.util, json, sys, types, pathlib, tempfile, os
spec = importlib.util.spec_from_file_location("a", ${JSON.stringify(file)})
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
def out(fn):
    try: print(json.dumps({"ok": fn()}, default=str))
    except a.Blocked as e: print(json.dumps({"blocked": e.args[0]}))
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", code], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("both scripts compile; nothing release-specific is pinned", () => {
  for (const file of [AUTO, INSTALL]) {
    const r = spawnSync("python3", [
      "-I",
      "-B",
      "-c",
      "import ast,sys;ast.parse(open(sys.argv[1]).read())",
      file,
    ]);
    assert.equal(r.status, 0, file);
    assert.equal(
      fs.readFileSync(file, "utf8").match(/\b[0-9a-f]{40}\b/g),
      null,
      file,
    );
  }
});

test("every pinned hash equals the file it names", () => {
  const pins = [
    ...install.matchAll(/^\s+"([\w.]+\.py)":\s*(?:\n\s*)?"([0-9a-f]{64})"/gm),
  ];
  assert.equal(pins.length, 3);
  for (const [, name, digest] of pins) {
    assert.equal(sha(DIR + name), digest, name);
  }
  const release = auto.match(/RELEASE_FILE = "([^"]+)"/)[1];
  assert.equal(
    sha(DIR + release),
    auto.match(/RELEASE_SHA256 = "([0-9a-f]{64})"/)[1],
  );
});

test("lowest sequence above live is chosen; attempted and old releases are skipped", () => {
  const pick = (known, live, state) =>
    py(
      AUTO,
      `out(lambda: a.pick_next(${JSON.stringify(known)}, ${live}, ${JSON.stringify(state)}))`,
    ).ok;
  const k = { a: 33, b: 34, c: 32, d: 31 };
  assert.equal(pick(k, 32, {}), "a");
  assert.equal(pick(k, 33, {}), "b");
  assert.equal(pick(k, 32, { attempted: { a: 1 } }), "b");
  assert.equal(pick(k, 34, {}), null);
  assert.equal(pick({}, 1, {}), null);
});

test("cooldown, kill switch and listing parsing", () => {
  const ok = (body) => py(AUTO, `out(lambda: ${body})`);
  assert.equal(ok(`a.cooldown_ok({"lastCutoverAt": 1000}, 1500)`).ok, false);
  assert.equal(ok(`a.cooldown_ok({"lastCutoverAt": 1000}, 2800)`).ok, true);
  assert.equal(ok(`a.cooldown_ok({}, 5)`).ok, true);
  const tmp = fs.mkdtempSync("/tmp/ks-");
  fs.writeFileSync(`${tmp}/off`, "");
  assert.equal(
    ok(`a.kill_switch_active(${JSON.stringify(tmp + "/off")})`).ok,
    true,
  );
  assert.equal(
    ok(`a.kill_switch_active(${JSON.stringify(tmp + "/none")})`).ok,
    false,
  );
  fs.rmSync(tmp, { recursive: true });
  const rev = "a".repeat(40);
  const listing = JSON.stringify([
    { name: rev, type: "dir" },
    { name: "b".repeat(40), type: "file" },
    { name: "A".repeat(40), type: "dir" },
    { name: "latest", type: "dir" },
    { name: "c".repeat(39), type: "dir" },
    "junk",
  ]);
  const names = ok(
    `a.parse_listing(${JSON.stringify(listing)}, __import__("re").compile(r"^[0-9a-f]{40}$"))`,
  );
  assert.deepEqual(names.ok, [rev]);
  assert.equal(
    ok(`a.parse_listing("not json", __import__("re").compile("x"))`).blocked,
    "LISTING_NOT_JSON",
  );
});

test("state files are validated and written privately", () => {
  const tmp = fs.mkdtempSync("/tmp/st-");
  const file = `${tmp}/state.json`;
  const rev = "d".repeat(40);
  const body = (obj) =>
    py(
      AUTO,
      `
p = pathlib.Path(${JSON.stringify(file)})
a.save_state(${JSON.stringify(obj)}, p)
out(lambda: [a.load_state(False, p), oct(p.stat().st_mode & 0o777)])`,
    );
  const good = body({
    seen: { [rev]: 33 },
    attempted: { [rev]: 5 },
    lastCutoverAt: 9,
  });
  assert.equal(good.ok[0].seen[rev], 33);
  assert.equal(good.ok[1], "0o600");
  // Forged shapes are rejected.
  for (const bad of [
    { seen: { short: 1 }, attempted: {}, lastCutoverAt: 0 },
    { seen: { [rev]: "33" }, attempted: {}, lastCutoverAt: 0 },
    { seen: {}, attempted: { [rev]: "x" }, lastCutoverAt: 0 },
    { seen: {}, attempted: {}, lastCutoverAt: "now" },
  ]) {
    const r = py(AUTO, `out(lambda: a.clean_state(${JSON.stringify(bad)}))`);
    assert.equal(r.blocked, "STATE_INVALID", JSON.stringify(bad));
  }
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);
  assert.equal(
    py(
      AUTO,
      `out(lambda: a.load_state(False, pathlib.Path(${JSON.stringify(file)})))`,
    ).blocked,
    "STATE_UNTRUSTED",
  );
  fs.rmSync(tmp, { recursive: true });
});

// A stand-in for owner_elite_release.py so the orchestration can be exercised.
const FAKE = (mode) => `
class B(Exception): pass
calls = []
live = {"seq": 32}
def newest_conf(names): return (live["seq"], 15, "x")
def fetch(url, path):
    import json
    rev = url.split("/")[-2]
    return json.dumps({"seq": {"${"a".repeat(40)}": 33, "${"b".repeat(40)}": 34}[rev]}).encode()
def parse_manifest(raw, rev):
    import json
    return {"sequence": json.loads(raw)["seq"]}
def step_publish(args, key, tmp):
    calls.append("publish")
    if "${mode}" == "noarchive": raise B("HTTPS_DOWNLOAD_FAILED")
    return {"sequence": {"${"a".repeat(40)}": 33, "${"b".repeat(40)}": 34}[args["rev"]]}
def step_feed(args): calls.append("feed")
def step_cutover(args, tmp):
    calls.append("cutover")
    if "${mode}" == "fail": raise B("CUTOVER_FAILED")
    if "${mode}" == "ok": live["seq"] = 33
r = types.SimpleNamespace(DIR="/", RAW="https://x", Blocked=B, newest_conf=newest_conf,
    fetch=fetch, parse_manifest=parse_manifest, step_publish=step_publish,
    step_feed=step_feed, step_cutover=step_cutover, UPDATER_WAIT_SECONDS=900)
import os
os.listdir = lambda p: []
tmp = pathlib.Path("/tmp")
persisted = []
state = {"seen": {}, "attempted": {}, "lastCutoverAt": 0}
names = ["${"a".repeat(40)}", "${"b".repeat(40)}"]
`;

test("orchestration: success applies exactly one release, in order, and records it", () => {
  const r = py(
    AUTO,
    FAKE("ok") +
      `
res = a.process(r, "k", names, 5000, state, tmp, lambda s: persisted.append(json.loads(json.dumps(s))))
out(lambda: [res[0], res[1]["lastCutoverAt"], calls, r.UPDATER_WAIT_SECONDS, len(persisted), list(persisted[0]["attempted"])])`,
  );
  assert.equal(r.ok[0], "CUTOVER_DONE");
  assert.equal(r.ok[1], 5000);
  assert.deepEqual(r.ok[2], ["publish", "feed", "cutover"]);
  assert.equal(r.ok[3], 0, "never waits inside a tick");
  assert.equal(r.ok[4], 1);
  assert.deepEqual(r.ok[5], ["a".repeat(40)], "lowest sequence (33) first");
});

test("orchestration: runtime not installed yet retries next tick; archive missing is not an error", () => {
  const waiting = py(
    AUTO,
    FAKE("waiting") +
      `
res = a.process(r, "k", names, 5000, state, tmp, lambda s: None)
out(lambda: [res[0], res[1]["attempted"]])`,
  );
  assert.equal(waiting.ok[0], "WAITING_FOR_UPDATER");
  assert.deepEqual(
    waiting.ok[1],
    {},
    "no attempt recorded so the next tick retries",
  );
  const missing = py(
    AUTO,
    FAKE("noarchive") +
      `
res = a.process(r, "k", names, 5000, state, tmp, lambda s: None)
out(lambda: [res[0], calls])`,
  );
  assert.equal(missing.ok[0], "NOT_READY_ARCHIVE_MISSING");
  assert.deepEqual(missing.ok[1], ["publish"]);
});

test("orchestration: a failed cutover is persisted as attempted BEFORE the restart and never retried", () => {
  const r = py(
    AUTO,
    FAKE("fail") +
      `
try:
    a.process(r, "k", names, 5000, state, tmp, lambda s: persisted.append(json.loads(json.dumps(s))))
    res = "no-raise"
except B as e:
    res = e.args[0]
nxt = a.pick_next({"${"a".repeat(40)}": 33}, 32, persisted[-1])
out(lambda: [res, list(persisted[-1]["attempted"]), nxt])`,
  );
  assert.equal(r.ok[0], "CUTOVER_FAILED");
  assert.deepEqual(r.ok[1], ["a".repeat(40)]);
  assert.equal(r.ok[2], null, "the failed release is not picked again");
});

test("orchestration: cooldown defers only the cutover; publish and feed are idempotent", () => {
  const r = py(
    AUTO,
    FAKE("ok") +
      `
state["lastCutoverAt"] = 4000
res = a.process(r, "k", names, 5000, state, tmp, lambda s: None)
out(lambda: [res[0], calls])`,
  );
  assert.equal(r.ok[0], "COOLDOWN_CUTOVER_DEFERRED");
  assert.deepEqual(r.ok[1], ["publish", "feed"]);
});

test("installer units are root-oneshot with a fixed ExecStart, no arguments and a kill switch", () => {
  const svc = py(INSTALL, `out(lambda: [a.SERVICE_UNIT, a.TIMER_UNIT])`).ok;
  const [service, timer] = svc;
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(
    service,
    /^ConditionPathExists=!\/etc\/kmj-codebridge-release\/auto-release\.disabled$/m,
  );
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/python3 -I \/usr\/local\/lib\/kmj-codebridge-release\/owner_elite_auto_release\.py$/m,
  );
  assert.equal((service.match(/^ExecStart=/gm) || []).length, 1);
  assert.doesNotMatch(service, /ExecStartPre|Environment|sh -c/);
  assert.match(timer, /^OnUnitActiveSec=10min$/m);
  assert.match(timer, /^Unit=kmj-codebridge-auto-release\.service$/m);
});

test("installer grammar: dry-run default, apply needs the owner confirmation", () => {
  for (const [args, ok] of [
    [[], true],
    [["--apply", "--confirm-unattended-release-owner-go"], true],
    [["--apply"], false],
    [["--confirm-unattended-release-owner-go"], false],
    [["--apply", "--confirm-no-active-jobs"], false],
  ]) {
    const r = spawnSync("python3", ["-I", "-B", INSTALL, ...args], {
      encoding: "utf8",
    });
    // Non-root/non-Linux hosts are refused either way; the grammar check comes first.
    assert.match(r.stdout, /AUTO_RELEASE_INSTALL=BLOCKED/);
    assert.match(
      r.stdout,
      ok ? /REASON=WRONG_ROOT_OR_HOST/ : /REASON=INVALID_ARGS/,
      args.join(" "),
    );
  }
});

test("the timer script itself refuses a non-root run", () => {
  if (process.getuid && process.getuid() === 0) return;
  const r = spawnSync("python3", ["-I", "-B", AUTO], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /REASON=WRONG_ROOT_OR_HOST/);
});
