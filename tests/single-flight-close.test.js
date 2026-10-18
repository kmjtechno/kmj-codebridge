import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { singleFlightClose } from "../src/single-flight-close.js";

test("concurrent graceful shutdown requests share one cleanup and one promise", async () => {
  let calls = 0;
  let finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const close = singleFlightClose(async () => {
    calls++;
    await wait;
    return "DRAINED";
  });
  const first = close();
  const second = close();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  assert.equal(await first, "DRAINED");
  assert.strictEqual(close(), first);
  assert.equal(calls, 1);
});

test("failed cleanup is preserved, never re-run or reported as success", async () => {
  let calls = 0;
  const error = new Error("private fixture failure must not enter CLI output");
  const close = singleFlightClose(async () => {
    calls++;
    throw error;
  });
  const first = close();
  const second = close();
  assert.strictEqual(first, second);
  await assert.rejects(first, (reason) => reason === error);
  await assert.rejects(close(), (reason) => reason === error);
  assert.equal(calls, 1);
});

test("synchronous shutdown exceptions become rejected promises", async () => {
  const close = singleFlightClose(() => {
    throw new Error("fixture");
  });
  await assert.rejects(close(), /fixture/);
  assert.throws(() => singleFlightClose(null), /SHUTDOWN_CLOSE_FUNCTION_REQUIRED/);
});

test("agent and CLI never duplicate or falsely acknowledge lifecycle teardown", () => {
  const agent = fs.readFileSync("src/agent.js", "utf8");
  const cli = fs.readFileSync("src/cli.js", "utf8");
  assert.match(agent, /close: singleFlightClose\(async \(\) =>/);
  assert.match(agent, /await runner\.close\(\);\s+releaseAgentLock\(agentLock\)/);
  assert.match(cli, /if \(closing\) return/);
  assert.match(cli, /Promise\.resolve\(\)/);
  assert.match(cli, /\.then\(\(\) => service\.close\(\)\)/);
  assert.match(cli, /Graceful shutdown failed; cleanup not verified/);
  assert.match(cli, /process\.exitCode = 1/);
  assert.doesNotMatch(cli, /console\.error\([^\n]*error\.message/);
  assert.doesNotMatch(cli, /process\.kill|taskkill|Stop-Process/);
});
