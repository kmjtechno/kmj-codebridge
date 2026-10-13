import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const standard = "/etc/kmj-codebridge/agent.json";
const dedicated = "/etc/kmj-codebridge-main-platform/agent.json";
const gateway = "/etc/kmj-codebridge/gateway.json";

const validAgent = JSON.stringify({
  gateway: "https://kmjtechno.com",
  token: "x".repeat(48),
  id: "kmj-elite-main-platform",
  tenant: "t1",
  stateDir: "/var/lib/kmj-codebridge",
  supervisorSocket: "/run/kmj-codebridge/supervisor.sock",
  license: { mode: "free" },
  projects: [
    {
      id: "kmj-main-platform",
      root: "/srv/kmj-codebridge-projects/kmj-main-platform",
      writable: true,
    },
  ],
});

test("agent doctor uses fixed dedicated config only when standard one is absent", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (file) => {
      seen.push(file);
      if (file === standard) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      assert.equal(file, dedicated);
      return validAgent;
    },
  });
  const result = await handler({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: true });
  assert.deepEqual(seen, [standard, dedicated]);
  assert.doesNotMatch(JSON.stringify(result), /x{32}/);
});

test("malformed or permission-denied standard config never triggers fallback", async () => {
  for (const scenario of ["malformed", "denied"]) {
    const seen = [];
    const handler = createSupervisorHandler({
      readFile: (file) => {
        seen.push(file);
        assert.equal(file, standard);
        if (scenario === "malformed") return "token=do-not-leak";
        const error = new Error("PRIVATE_SECRET");
        error.code = "EACCES";
        throw error;
      },
    });
    const result = await handler({ op: "config_validate", service: "agent" });
    assert.deepEqual(result.response, { service: "agent", valid: false });
    assert.deepEqual(seen, [standard]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|do-not-leak/);
  }
});

test("present standard agent config remains authoritative", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (file) => {
      seen.push(file);
      assert.equal(file, standard);
      return validAgent;
    },
  });
  const result = await handler({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: true });
  assert.deepEqual(seen, [standard]);
});

test("gateway config cannot fall back to privileged agent config", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (file) => {
      seen.push(file);
      assert.equal(file, gateway);
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.deepEqual(result.response, { service: "gateway", valid: false });
  assert.deepEqual(seen, [gateway]);
});
