import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT = "scripts/production/follow_stable_release.py";
const decide = (unit, info, target, age, running, busy) =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("f","${SCRIPT}");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
a=json.loads(sys.argv[1]);print(json.dumps(m.plan(*a)))`,
        JSON.stringify([unit, info, target, age, running, busy]),
      ],
      { encoding: "utf8" },
    ),
  );
const ok = {
  LoadState: "loaded",
  ActiveState: "active",
  WorkingDirectory: "/opt/kmj-codebridge-stable/current",
};
const DEV = "kmj-codebridge-dev.service";

test("restarts only an idle, settled, behind agent", () => {
  assert.deepEqual(decide(DEV, ok, "/r/new", 500, "/r/old", false), [
    "RESTART",
    "BEHIND_STABLE",
  ]);
});
test("up to date agent is left alone", () => {
  assert.deepEqual(decide(DEV, ok, "/r/new", 500, "/r/new", false), [
    "SKIP",
    "UP_TO_DATE",
  ]);
});
test("busy agent is deferred, never restarted", () => {
  assert.deepEqual(decide(DEV, ok, "/r/new", 500, "/r/old", true), [
    "DEFER",
    "AGENT_BUSY",
  ]);
});
test("fresh symlink target must settle first", () => {
  assert.deepEqual(decide(DEV, ok, "/r/new", 5, "/r/old", false), [
    "DEFER",
    "TARGET_NOT_SETTLED",
  ]);
});
test("non-allowlisted units are never touched (updater, gateway, main platform)", () => {
  for (const u of [
    "kmj-codebridge-kmj-main-platform.service",
    "kmj-codebridge-stable-update.service",
    "nginx.service",
  ]) {
    assert.deepEqual(decide(u, ok, "/r/new", 500, "/r/old", false), [
      "SKIP",
      "NOT_ALLOWLISTED",
    ]);
  }
});
test("units not on the stable symlink, inactive, or with bad target are skipped", () => {
  assert.equal(
    decide(
      DEV,
      { ...ok, WorkingDirectory: "/home/x" },
      "/r/new",
      500,
      "/r/old",
      false,
    )[1],
    "NOT_ON_STABLE_SYMLINK",
  );
  assert.equal(
    decide(
      DEV,
      { ...ok, ActiveState: "failed" },
      "/r/new",
      500,
      "/r/old",
      false,
    )[1],
    "NOT_ACTIVE",
  );
  assert.equal(
    decide(DEV, ok, null, 500, "/r/old", false)[1],
    "TARGET_INVALID",
  );
  assert.equal(
    decide(DEV, ok, "/r/new", 500, null, false)[1],
    "PROCESS_UNREADABLE",
  );
});
test("script and units never touch config, keys, symlink or production", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(
    src,
    /os\.(unlink|remove|rename|replace|chmod|chown|symlink)|shutil|agent\.json|"activate"|"enable"/,
  );
  assert.equal(
    [...src.matchAll(/"systemctl", "(\w+)"/g)]
      .map((m) => m[1])
      .filter((v) => v !== "restart" && v !== "show").length,
    0,
  );
  const svc = readFileSync(
    "scripts/production/kmj-codebridge-follow-stable.service",
    "utf8",
  );
  assert.match(svc, /NoNewPrivileges=true/);
  assert.match(svc, /ProtectSystem=strict/);
});
