import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

for (const [service, standard, alternate] of [
  [
    "agent",
    "kmj-codebridge-agent.service",
    "kmj-codebridge-kmj-main-platform.service",
  ],
  [
    "gateway",
    "kmj-codebridge-gateway.service",
    "kmj-codebridge-gateway-stage.service",
  ],
]) {
  test(`${service} status, logs and restart select the installed fixed alternate`, async () => {
    const calls = [],
      restarted = [];
    const handle = createSupervisorHandler({
      run: (bin, args) => {
        calls.push([bin, args]);
        if (bin.endsWith("journalctl")) return "connected\n";
        if (args.includes("--property=LoadState"))
          return `LoadState=${args[1] === standard ? "not-found" : "loaded"}\n`;
        return "ActiveState=active\nSubState=running\nMainPID=123\n";
      },
      restart: (unit) => restarted.push(unit),
    });
    assert.equal(
      (await handle({ op: "status", service })).response.activeState,
      "active",
    );
    assert.equal(calls.at(-1)[1][1], alternate);
    assert.equal(
      (await handle({ op: "logs", service })).response.output,
      "connected\n",
    );
    assert.equal(calls.at(-1)[1][1], alternate);
    const result = await handle({ op: "restart", service });
    assert.deepEqual(restarted, []);
    result.afterSend();
    assert.deepEqual(restarted, [alternate]);
    assert.ok(
      calls.every(([, args]) => [standard, alternate].includes(args[1])),
    );
  });

  test(`${service} preserves the installed default and never falls back on masked or unknown units`, async () => {
    for (const state of ["loaded", "masked", "error", ""]) {
      const calls = [],
        restarted = [];
      const handle = createSupervisorHandler({
        run: (bin, args) => {
          calls.push(args);
          return `LoadState=${state}\n`;
        },
        restart: (unit) => restarted.push(unit),
      });
      if (state === "loaded") {
        const result = await handle({ op: "restart", service });
        result.afterSend();
        assert.deepEqual(restarted, [standard]);
      } else {
        await assert.rejects(
          handle({ op: "restart", service }),
          /SUPERVISOR_SERVICE_UNAVAILABLE/,
        );
        assert.deepEqual(restarted, []);
      }
      assert.ok(calls.every((args) => args[1] === standard));
    }
  });

  test(`${service} refuses restart if neither fixed unit is installed`, async () => {
    const handle = createSupervisorHandler({
      run: () => "LoadState=not-found\n",
    });
    await assert.rejects(
      handle({ op: "restart", service }),
      /SUPERVISOR_SERVICE_UNAVAILABLE/,
    );
  });
}
