import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDispatcher } from "../src/tools.js";

const make = (t, projectId, writable = true) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-compat-"));
  const root = path.join(home, "root");
  const stateDir = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const runner = {
    maxConcurrent: 1,
    run: (args) => {
      calls.push(args);
      return { id: "browser-compat-fixture", state: "queued", gate: args.gate };
    },
  };
  const config = {
    id: "d1",
    stateDir,
    projects: [{ id: projectId, root, writable, gates: {}, commands: {} }],
  };
  const dispatcher = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  return { dispatch: dispatcher, calls, root, stateDir };
};
const input = (project, extra = {}) => ({
  device: "d1",
  project,
  command: "browser_public_qa",
  variant: "start",
  requestKey: "browser-qa-capture-compat-test",
  ...extra,
});

test("captured command browser QA is an exact fixed-origin job", async (t) => {
  const { dispatch, calls, root, stateDir } = make(t, "kmj-main-platform");
  const listing = await dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-main-platform" },
    ["read"],
  );
  assert.deepEqual(
    listing.commands.map((command) => command.id),
    ["browser_public_qa"],
  );
  assert.deepEqual(listing.commands[0].variants, ["start"]);
  assert.equal(listing.commands[0].risk, "TEST");

  const started = await dispatch(
    "run_project_command",
    input("kmj-main-platform"),
    ["execute"],
  );
  assert.equal(started.gate, "browser-qa:kmj-public");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.project, "kmj-main-platform");
  assert.equal(call.gate, "browser-qa:kmj-public");
  assert.equal(call.cwd, root);
  assert.equal(call.command, process.execPath);
  assert.equal(call.timeoutMs, 120000);
  assert.equal(call.key, "browser-qa-capture-compat-test");
  assert.equal(call.args[1], "kmj_public");
  assert.equal(path.basename(call.args[0]), "browser-public-qa.mjs");
  assert.ok(path.isAbsolute(call.args[0]));
  assert.equal(
    call.args[2],
    path.join(
      stateDir,
      "browser-qa",
      createHash("sha256")
        .update("kmj-main-platform:browser-qa-capture-compat-test")
        .digest("hex"),
    ),
  );
  assert.equal(fs.existsSync(call.args[2]), false);
});

test("captured command browser QA denies unapproved projects or overrides", async (t) => {
  const other = make(t, "unrelated");
  const unrelated = await other.dispatch(
    "list_project_commands",
    { device: "d1", project: "unrelated" },
    ["read"],
  );
  assert.equal(
    unrelated.commands.some((c) => c.id === "browser_public_qa"),
    false,
  );
  await assert.rejects(
    other.dispatch("run_project_command", input("unrelated"), ["execute"]),
    /BROWSER_QA_PROJECT_NOT_ALLOWED/,
  );
  assert.equal(other.calls.length, 0);

  const readOnly = make(t, "kmj-main-platform", false);
  await assert.rejects(
    readOnly.dispatch("run_project_command", input("kmj-main-platform"), [
      "execute",
    ]),
    /BROWSER_QA_PROJECT_NOT_ALLOWED/,
  );
  assert.equal(readOnly.calls.length, 0);

  const approved = make(t, "kmj-main-platform");
  for (const override of [
    { variant: "arbitrary" },
    { laneId: "elsewhere" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      approved.dispatch(
        "run_project_command",
        input("kmj-main-platform", override),
        ["execute"],
      ),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    approved.dispatch("run_project_command", input("kmj-main-platform"), [
      "read",
    ]),
    /ACCESS_DENIED/,
  );
  assert.equal(approved.calls.length, 0);
});
