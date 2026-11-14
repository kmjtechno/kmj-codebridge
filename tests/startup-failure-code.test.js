import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { startupFailure, startupFailureCode } from "../src/startup-failure.js";

test("only fixed identifier-shaped codes are reported", () => {
  assert.equal(
    startupFailureCode(startupFailure("CONFIG_MODE_NOT_PRIVATE", "x")),
    "CONFIG_MODE_NOT_PRIVATE",
  );
  assert.equal(
    startupFailureCode(Object.assign(Error("x"), { code: "EADDRINUSE" })),
    "EADDRINUSE",
  );
  assert.equal(
    startupFailureCode(new SyntaxError("bad")),
    "CONFIG_JSON_INVALID",
  );
  assert.equal(
    startupFailureCode(z.object({ a: z.string() }).safeParse({}).error),
    "CONFIG_SCHEMA_INVALID",
  );
  for (const code of [
    "secret value 123",
    "/etc/kmj/gateway.json",
    "lower_case",
    "A",
    "X".repeat(65),
    42,
    undefined,
  ])
    assert.equal(
      startupFailureCode(Object.assign(Error("x"), { code })),
      "UNCLASSIFIED",
    );
  assert.equal(startupFailureCode(undefined), "UNCLASSIFIED");
  assert.equal(startupFailureCode(Error("token=abc")), "UNCLASSIFIED");
});

const run = (file) =>
  spawnSync(process.execPath, ["src/cli.js", "gateway", file], {
    encoding: "utf8",
    timeout: 20000,
  });

test(
  "a group-readable config names CONFIG_MODE_NOT_PRIVATE and leaks nothing",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-startup-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "gateway.json");
    fs.writeFileSync(file, JSON.stringify({ marker: "do-not-print-me" }));
    fs.chmodSync(file, 0o640);
    const result = run(file);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^Startup failed \[CONFIG_MODE_NOT_PRIVATE\]\./,
    );
    assert.doesNotMatch(result.stderr + result.stdout, /do-not-print-me/);
    assert.ok(!(result.stderr + result.stdout).includes(dir));
  },
);

test(
  "invalid JSON and an invalid schema get their own codes",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-startup-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json", { mode: 0o600 });
    assert.match(run(bad).stderr, /^Startup failed \[CONFIG_JSON_INVALID\]\./);
    const schema = path.join(dir, "schema.json");
    fs.writeFileSync(schema, JSON.stringify({ port: "nope" }), { mode: 0o600 });
    const result = run(schema);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Startup failed \[CONFIG_SCHEMA_INVALID\]\./);
  },
);
