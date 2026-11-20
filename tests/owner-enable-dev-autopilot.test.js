import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { agentSchema } from "../src/config.js";

const SCRIPT = "scripts/production/owner_enable_dev_autopilot.py";
const script = fs.readFileSync(SCRIPT, "utf8");

function py(body) {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", code], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

const BASE = {
  gateway: "https://kmjtechno.com",
  token: "t".repeat(48),
  id: "kmj-codebridge-elite",
  tenant: "t1",
  stateDir: "/var/lib/kmj-codebridge-dev",
  pollMs: 100,
  projects: [
    {
      id: "kmj-codebridge",
      root: "/srv/kmj-codebridge-dev/kmj-codebridge",
      writable: true,
      gates: {},
      commandPresets: ["node-standard"],
    },
  ],
  license: { mode: "free" },
};

function enable(cfg) {
  return py(`
try:
    n, c = m.enable(json.loads(${JSON.stringify(JSON.stringify(cfg))}))
    print(json.dumps({"cfg": n, "changed": c}))
except ValueError as e:
    print(json.dumps({"err": e.args[0]}))`);
}

test("enabled config parses against the real agent schema and adds only the bounded loops", () => {
  const r = enable(BASE);
  assert.equal(r.changed, true);
  assert.ok(agentSchema.safeParse(r.cfg).success);
  const p = r.cfg.projects[0];
  assert.deepEqual(Object.keys(p.gates).sort(), ["fast_check", "format_src"]);
  assert.equal(p.autopilotCiWatch.publicReadOnly, true);
  assert.equal(p.autopilotCiWatch.intervalSeconds, 900);
  assert.equal(p.autopilotRepairWorker.recipes.format.fixGate, "format_src");
  assert.deepEqual(p.autopilotRepairWorker.recipes.format.paths, [
    "src/",
    "scripts/",
    "tests/",
    "plugin/",
    "docs/",
    "README.md",
  ]);
  for (const k of [
    "autopilotCodingWorker",
    "autopilotLocalWorker",
    "autopilotGateWorker",
  ])
    assert.equal(p[k], undefined, k);
  assert.equal(r.cfg.token, BASE.token, "credentials untouched");
});

test("is idempotent and refuses conflicting or unsafe existing config", () => {
  const once = enable(BASE).cfg;
  assert.equal(enable(once).changed, false);
  const conflict = structuredClone(BASE);
  conflict.projects[0].gates.fast_check = { command: "rm", args: ["-rf", "/"] };
  assert.match(enable(conflict).err, /^GATE_CONFLICT:fast_check/);
  const ro = structuredClone(BASE);
  ro.projects[0].writable = false;
  assert.equal(enable(ro).err, "PROJECT_NOT_WRITABLE");
  const coding = structuredClone(BASE);
  coding.projects[0].autopilotCodingWorker = { enabled: true };
  assert.match(enable(coding).err, /^CONFLICT|UNEXPECTED_WORKER/);
});

test("the sync timer only fast-forwards a clean main checkout as the unprivileged user", () => {
  const r = py(
    `s,t = m.sync_units("/srv/x/y"); print(json.dumps({"s": s, "t": t}))`,
  );
  assert.match(r.s, /User=kmjdev/);
  assert.match(r.s, /ExecCondition=.*rev-parse --abbrev-ref HEAD.*= main/);
  assert.match(r.s, /status --porcelain/);
  assert.match(r.s, /merge --ff-only/);
  assert.doesNotMatch(r.s, /--force|git -C \S+ (reset|checkout|clean|stash)/);
  assert.match(r.s, /NoNewPrivileges=true/);
  assert.match(r.s, /ReadWritePaths=\/srv\/x\/y/);
  assert.match(r.t, /OnUnitActiveSec=5min/);
});

test("script is dry-run by default, host-pinned and installs no model or network service", () => {
  assert.match(script, /--confirm-restart-dev-agent/);
  assert.match(script, /RESULT=DRY_RUN_UNCHANGED/);
  assert.match(script, /\.lower\(\) != "kmj-elite"/);
  assert.match(script, /geteuid/);
  assert.doesNotMatch(
    script,
    /curl|wget|pip |apt |ollama|localProcessingApproved/,
  );
});
