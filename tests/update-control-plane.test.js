import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorHandler } from "../src/supervisor.js";

const inactive = "LoadState=loaded\nActiveState=inactive\n";

test("update controls reject caller-selected targets", async () => {
  const started = [];
  const handle = createSupervisorHandler({
    run: () => inactive,
    readFile: () =>
      JSON.stringify({
        current: "0.2.4",
        previous: "0.2.3",
        sequence: 44,
        releases: [],
      }),
    start: (unit) => started.push(unit),
  });

  const history = await handle({ op: "release_history" });
  assert.equal(history.response.current, "0.2.4");

  const check = await handle({ op: "update_check" });
  check.afterSend();
  const rollback = await handle({ op: "update_rollback" });
  rollback.afterSend();

  assert.deepEqual(started, [
    "kmj-codebridge-update-check.service",
    "kmj-codebridge-update-rollback.service",
  ]);

  const bad = [
    { op: "update_check", url: "https://attacker.invalid" },
    { op: "release_history", path: "/tmp/state.json" },
    { op: "update_rollback", version: "0.1.0" },
    { op: "update_rollback", unit: "ssh.service" },
  ];
  for (const request of bad) {
    await assert.rejects(handle(request), /INVALID_SUPERVISOR_REQUEST/);
  }
});

test("rollback fails closed without previous release", async () => {
  const handle = createSupervisorHandler({
    run: () => inactive,
    readFile: () => JSON.stringify({ current: "0.2.4", releases: [] }),
  });
  await assert.rejects(
    handle({ op: "update_rollback" }),
    /SUPERVISOR_ROLLBACK_UNAVAILABLE/,
  );
});
