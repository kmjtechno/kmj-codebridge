import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { configModeAcceptable } from "../src/config-file-mode.js";

const file = (mode, uid) => ({ mode: 0o100000 | mode, uid });

test("a private config is accepted for every service mode and owner", () => {
  for (const service of ["gateway", "agent", "stable-update"])
    for (const uid of [0, 997])
      for (const mode of [0o600, 0o400])
        assert.equal(configModeAcceptable(service, file(mode, uid)), true);
});

test("only the gateway accepts group-readable, and only when root-owned", () => {
  assert.equal(configModeAcceptable("gateway", file(0o640, 0)), true);
  assert.equal(configModeAcceptable("gateway", file(0o440, 0)), true);
  // The 2026-11-14 layout must start; the same bits owned by the service
  // user (which could then rewrite a group-shared secret) must not.
  assert.equal(configModeAcceptable("gateway", file(0o640, 997)), false);
  for (const service of [
    "agent",
    "stable-update",
    "stable-rollback",
    undefined,
  ])
    assert.equal(configModeAcceptable(service, file(0o640, 0)), false);
});

test("group-writable, executable or world-accessible configs are always refused", () => {
  for (const mode of [
    0o660, 0o650, 0o644, 0o641, 0o642, 0o740, 0o604, 0o666, 0o777,
  ])
    for (const uid of [0, 997])
      assert.equal(
        configModeAcceptable("gateway", file(mode, uid)),
        false,
        mode.toString(8),
      );
  for (const bad of [undefined, null, {}, { mode: "0600", uid: 0 }])
    assert.equal(configModeAcceptable("gateway", bad), false);
});

test("the gateway rule is the Supervisor's existing root-file mask, not a new one", () => {
  const supervisor = fs.readFileSync("src/stage-gateway-config.js", "utf8");
  assert.match(supervisor, /info\.uid === 0 &&/);
  assert.match(supervisor, /\(info\.mode & 0o137\) === 0/);
  const rule = fs.readFileSync("src/config-file-mode.js", "utf8");
  assert.match(rule, /stat\.uid === 0 && \(stat\.mode & 0o137\) === 0/);
});
