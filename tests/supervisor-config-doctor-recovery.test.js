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

const agentUnitState = (running) => (_bin, args) =>
  args[1] === "kmj-codebridge-kmj-main-platform.service"
    ? running === "dedicated"
      ? "LoadState=loaded\nActiveState=active\n"
      : "LoadState=not-found\nActiveState=inactive\n"
    : running === "standard"
      ? "LoadState=loaded\nActiveState=active\n"
      : "LoadState=not-found\nActiveState=inactive\n";

test("agent doctor selects dedicated enrollment for the active dedicated unit", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    run: agentUnitState("dedicated"),
    readFile: (file) => {
      seen.push(file);
      assert.equal(file, dedicated);
      return validAgent;
    },
  });
  const result = await handler({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: true });
  assert.deepEqual(seen, [dedicated]);
  assert.doesNotMatch(JSON.stringify(result), /x{32}/);
});

test("malformed or permission-denied standard config never triggers fallback", async () => {
  for (const scenario of ["malformed", "denied"]) {
    const seen = [];
    const handler = createSupervisorHandler({
      run: agentUnitState("standard"),
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
    assert.deepEqual(result.response, {
      service: "agent",
      valid: false,
      reason:
        scenario === "malformed"
          ? "CONFIG_JSON_INVALID"
          : "CONFIG_FILE_UNREADABLE",
    });
    assert.deepEqual(seen, [standard]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|do-not-leak/);
  }
});

test("present standard agent config remains authoritative", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    run: agentUnitState("standard"),
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

test("active standard agent never silently falls back to dedicated secrets", async () => {
  const reads = [];
  const handle = createSupervisorHandler({
    run: agentUnitState("standard"),
    readFile: (file) => {
      reads.push(file);
      const error = new Error("secret enrollment must not be read");
      error.code = "ENOENT";
      throw error;
    },
  });
  const result = await handle({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, {
    service: "agent",
    valid: false,
    reason: "CONFIG_FILE_MISSING",
  });
  assert.deepEqual(reads, [standard]);
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
  assert.deepEqual(result.response, {
    service: "gateway",
    valid: false,
    reason: "CONFIG_FILE_MISSING",
  });
  assert.deepEqual(seen, [gateway]);
});

test("active stage gateway reports unverified config instead of missing canonical config", async () => {
  const readPaths = [];
  const handler = createSupervisorHandler({
    run: (_bin, args) =>
      args[1] === "kmj-codebridge-gateway-stage.service"
        ? "LoadState=loaded\nActiveState=active\n"
        : "LoadState=not-found\nActiveState=inactive\n",
    readFile: (path) => {
      readPaths.push(path);
      const error = new Error("PRIVATE_GATEWAY_CREDENTIAL");
      error.code = "ENOENT";
      throw error;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.deepEqual(result.response, {
    service: "gateway",
    valid: false,
    reason: "STAGE_GATEWAY_CONFIG_NOT_VERIFIED",
  });
  assert.deepEqual(readPaths, [gateway]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_GATEWAY_CREDENTIAL|\/etc\//,
  );
});

test("standard gateway with missing config still reports canonical missing file", async () => {
  const handler = createSupervisorHandler({
    run: (_bin, args) =>
      args[1] === "kmj-codebridge-gateway.service"
        ? "LoadState=loaded\nActiveState=active\n"
        : "LoadState=not-found\nActiveState=inactive\n",
    readFile: () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.deepEqual(result.response, {
    service: "gateway",
    valid: false,
    reason: "CONFIG_FILE_MISSING",
  });
});
