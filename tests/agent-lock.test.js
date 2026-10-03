import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireAgentLock, releaseAgentLock } from "../src/agent-lock.js";

function tempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-agent-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("agent lock replaces a proven-stale legacy PID lock", (t) => {
  const dir = tempState(t);
  const lockPath = path.join(dir, "agent.lock");
  const stalePid = 42424242;
  const originalKill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === stalePid) {
      const error = new Error("missing process");
      error.code = "ESRCH";
      throw error;
    }
    return originalKill(pid, signal);
  });
  fs.writeFileSync(lockPath, String(stalePid), { mode: 0o600 });

  const lock = acquireAgentLock(dir);
  const stored = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(stored.pid, process.pid);
  assert.equal(stored.owner, lock.owner);

  releaseAgentLock(lock);
  assert.equal(fs.existsSync(lockPath), false);
});

test("agent lock refuses to replace a lock owned by a live process", (t) => {
  const dir = tempState(t);
  fs.writeFileSync(path.join(dir, "agent.lock"), String(process.pid), {
    mode: 0o600,
  });

  assert.throws(
    () => acquireAgentLock(dir),
    /AGENT_ALREADY_RUNNING_OR_STALE_LOCK/,
  );
});

test("agent lock release does not remove a replacement owner", (t) => {
  const dir = tempState(t);
  const lock = acquireAgentLock(dir);
  fs.writeFileSync(
    lock.path,
    JSON.stringify({ pid: process.pid, bootId: null, owner: "replacement" }),
    { mode: 0o600 },
  );

  releaseAgentLock(lock);
  assert.equal(fs.existsSync(lock.path), true);
});
