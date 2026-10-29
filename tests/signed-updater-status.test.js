import test from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityMemory } from "../src/capability-memory.js";
import { createSupervisorHandler } from "../src/supervisor.js";

test("signed-only installation is reported even when development updater is absent", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      if (
        args[0] === "show" &&
        args[1] === "kmj-codebridge-stable-update.timer"
      )
        return "LoadState=loaded\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\n";
      if (
        args[0] === "show" &&
        args[1] === "kmj-codebridge-stable-update.service"
      )
        return "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n";
      return "LoadState=not-found\nActiveState=inactive\n";
    },
    lstat: () => {
      throw new Error("absent");
    },
  });
  const { response } = await handle({ op: "update_status" });
  assert.equal(response.service.installed, false);
  assert.equal(response.signed.service.installed, true);
  assert.equal(response.signed.timer.installed, true);
  assert.equal(response.signed.available, true);
  assert.equal(response.signed.checksRunning, true);
  assert.equal(response.signed.checksEnabled, true);
  const memory = buildCapabilityMemory({ updater: response });
  assert.equal(memory.runtime.updaterInstalled, true);
  assert.equal(memory.runtime.signedUpdaterInstalled, true);
  assert.equal(memory.runtime.developmentUpdaterInstalled, false);
  assert.equal(memory.runtime.rootShellGrantedVerified, false);
  assert.equal(
    calls.some(([, args]) => args[0] === "start" || args[0] === "enable"),
    false,
  );
});

test("legacy development-only absence is unknown for the signed updater", () => {
  const runtime = buildCapabilityMemory({
    updater: { service: { installed: false } },
  }).runtime;
  assert.equal(runtime.updaterInstalled, null);
  assert.equal(runtime.signedUpdaterInstalled, null);
});

test("only explicit absence of both updaters reports not installed", () => {
  const runtime = buildCapabilityMemory({
    updater: {
      service: { installed: false },
      signed: { service: { installed: false } },
    },
  }).runtime;
  assert.equal(runtime.updaterInstalled, false);
});
