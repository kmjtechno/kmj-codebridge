import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = "scripts/production/owner_diagnose_zero_cost_20261117.py";
const source = readFileSync(SCRIPT, "utf8");
const match = source.match(/STAGE_JS = r'''([\s\S]*?)'''/);

test("owner zero-cost diagnostic embeds a bounded Node stage program", () => {
  assert.ok(match, "production script must define STAGE_JS");
  assert.match(source, /if result\.returncode:\s*\n\s*print\("NODE_EXIT="/);
  assert.match(source, /if result\.returncode:[\s\S]*?sys\.exit\(2\)/);
});

function fixture(
  t,
  { broken = "", missingPin = false, missingSnapshot = false } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kmj-free-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, "src");
  const pins = path.join(root, "pins");
  const snaps = path.join(root, "snaps");
  for (const dir of [src, pins, snaps]) mkdirSync(dir);
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const modules = {
    "openrouter-evidence-fetcher.js": [
      "export function createOpenRouterEvidenceFetcher() {",
      "  return {",
      "    async fetchOpenRouterModels() { return {data:[{id:'example/model:free'}]}; },",
      "    async fetchOpenRouterKey() { return {data:{free_model_daily_requests:{used:0,limit:2,remaining:2}}}; }",
      "  };",
      "}",
    ].join("\n"),
    "openrouter-free-evidence.js": [
      "export const isVerifiedFreeModel = () => true;",
      "export const evaluateAccountEvidence = () => ({",
      "  ok:" + (broken === "account" ? "false" : "true") + ",",
      "  reasons:" + (broken === "account" ? '["ACCOUNT_NOT_VERIFIED"]' : "[]"),
      "});",
    ].join("\n"),
    "freellmapi-zero-cost-verifier.js": [
      "export const createZeroCostVerifier = () => async () => {",
      broken === "verifier"
        ? '  throw new Error("NOT_ATTESTED");'
        : "  return {requestsRemaining:2};",
      "};",
    ].join("\n"),
    "freellmapi-chain-snapshot.js":
      'export const createChainSnapshotReader = () => async () => ["example/model:free"];',
  };
  for (const [name, code] of Object.entries(modules)) {
    if (broken === "modules" && name === "openrouter-free-evidence.js")
      continue;
    writeFileSync(path.join(src, name), code);
  }
  if (!missingPin)
    writeFileSync(
      path.join(pins, "route-binding-or-free.json"),
      '{"models":["example/model:free"]}',
    );
  if (!missingSnapshot)
    writeFileSync(
      path.join(snaps, "or-free.json"),
      JSON.stringify({ observedAtEpochMs: Date.now() }),
    );
  return { root, pins, snaps };
}

function run(t, args) {
  const f = fixture(t, args);
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", match[1]],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH ?? "",
        DIAG_DIR: f.root,
        DIAG_CHAIN: "auto:or-free",
        CODEBRIDGE_FREELLMAPI_PINS_DIR: f.pins,
        CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR: f.snaps,
        CODEBRIDGE_OPENROUTER_KEY: "synthetic-test-key",
      },
    },
  );
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

const linux = process.platform === "linux";
test(
  "fully synthetic verified diagnostic exits zero, no outbound network",
  { skip: !linux },
  (t) => {
    const p = run(t, {});
    assert.equal(p.status, 0, p.stderr + p.stdout);
    assert.match(p.stdout, /VERIFIER=OK/);
  },
);

for (const [label, args, expected] of [
  ["missing pin", { missingPin: true }, /PIN_READ=FAIL/],
  ["missing snapshot", { missingSnapshot: true }, /SNAPSHOT_READ=FAIL/],
  [
    "failed account evidence",
    { broken: "account" },
    /OPENROUTER_KEY_EVIDENCE=FAIL/,
  ],
  ["failed independent verifier", { broken: "verifier" }, /VERIFIER=FAIL/],
  ["missing verifier module", { broken: "modules" }, /MODULES=FAIL/],
]) {
  test(
    "diagnostic rejects " + label + " despite other passing stages",
    { skip: !linux },
    (t) => {
      const p = run(t, args);
      assert.equal(p.status, 2, p.stderr + p.stdout);
      assert.match(p.stdout, expected);
    },
  );
}
