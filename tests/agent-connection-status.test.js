import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentConnectionRecorder,
  gatewayFailureCode,
} from "../src/agent-connection-status.js";

test("gateway status codes map to bounded, non-secret failure classes", () => {
  const expected = new Map([
    [200, "GATEWAY_REQUEST_REJECTED"],
    [401, "GATEWAY_UNAUTHORIZED"],
    [403, "GATEWAY_FORBIDDEN"],
    [409, "GATEWAY_POLL_CONFLICT"],
    [429, "GATEWAY_RATE_LIMITED"],
    [500, "GATEWAY_UNAVAILABLE"],
    [503, "GATEWAY_UNAVAILABLE"],
    [418, "GATEWAY_REQUEST_REJECTED"],
  ]);
  for (const [status, error] of expected)
    assert.equal(gatewayFailureCode(status), error);
});

test("connection recorder stores only bounded status, debounces failures, and clears success", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-connection-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let timestamp = Date.parse("2026-10-06T09:00:00.000Z");
  const recorder = new AgentConnectionRecorder(dir, {
    now: () => timestamp,
  });
  recorder.record("GATEWAY_UNAUTHORIZED");
  const file = path.join(dir, "connection-status.json");
  const first = fs.readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(first), {
    schema: 1,
    status: "error",
    errorCode: "GATEWAY_UNAUTHORIZED",
    observedAt: "2026-10-06T09:00:00.000Z",
  });
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o077, 0);

  timestamp += 1000;
  recorder.record("GATEWAY_UNAUTHORIZED");
  assert.equal(fs.readFileSync(file, "utf8"), first);

  timestamp += 31000;
  recorder.record("CONNECTED");
  const second = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(second.status, "connected");
  assert.equal(second.errorCode, null);
  recorder.record("CONNECTED");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), second);

  timestamp += 1000;
  recorder.record("secret=supersecret");
  const third = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(third).errorCode, "NETWORK_ERROR");
  assert.equal(third.includes("supersecret"), false);
});

test("recorder write failures never interrupt an agent", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cb-connection-unwritable-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, "nonexistent");
  const recorder = new AgentConnectionRecorder(missing);
  assert.doesNotThrow(() => recorder.record("NETWORK_ERROR"));
});
