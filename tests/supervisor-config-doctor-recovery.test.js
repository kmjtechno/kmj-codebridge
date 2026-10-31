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
  // Hermetic standard-unit fixture: never read host systemd state on VPS.
  const standardGatewayState = (_bin, args) =>
    args[1] === "kmj-codebridge-gateway.service"
      ? "LoadState=loaded\nActiveState=active\n"
      : "LoadState=not-found\nActiveState=inactive\n";
  const seen = [];
  const handler = createSupervisorHandler({
    run: standardGatewayState,
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

const validGateway = JSON.stringify({
  users: [
    {
      id: "owner",
      tenant: "t1",
      tokenHash: "a".repeat(64),
      permissions: ["read"],
      devices: {},
    },
  ],
  agents: [{ id: "agent", tenant: "t1", tokenHash: "b".repeat(64) }],
});

const stageGatewayState = (_bin, args) =>
  args[1] === "kmj-codebridge-gateway-stage.service"
    ? "LoadState=loaded\nActiveState=active\n"
    : "LoadState=not-found\nActiveState=inactive\n";

test("stage gateway validates ONLY fixed trusted stage file and does not attest live runtime", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    run: stageGatewayState,
    readFile: (path) => {
      seen.push(path);
      throw new Error("stale canonical gateway must never be read");
    },
    readStageGatewayConfig: () => {
      seen.push("fixed-stage-reader");
      return validGateway;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.deepEqual(result.response, {
    service: "gateway",
    valid: true,
    scope: "FIXED_STAGE_FILE_SCHEMA_ONLY",
    runtimeConfigAttested: false,
    signedRuntimeAttested: false,
  });
  assert.deepEqual(seen, ["fixed-stage-reader"]);
  assert.doesNotMatch(JSON.stringify(result), /a{64}|b{64}|\/etc\//);
});

test("stage missing, malformed, and untrusted configs fail closed without canonical fallback", async () => {
  const scenarios = [
    ["missing", "ENOENT", "STAGE_GATEWAY_CONFIG_NOT_VERIFIED"],
    ["denied", "EACCES", "CONFIG_FILE_UNREADABLE"],
    ["untrusted", "CONFIG_TRUST_INVALID", "CONFIG_TRUST_INVALID"],
  ];
  for (const [, code, expected] of scenarios) {
    const handler = createSupervisorHandler({
      run: stageGatewayState,
      readFile: () => {
        throw new Error("canonical path must not be read");
      },
      readStageGatewayConfig: () => {
        const error = new Error("PRIVATE_STAGE_SECRET");
        error.code = code;
        throw error;
      },
    });
    const result = await handler({ op: "config_validate", service: "gateway" });
    assert.deepEqual(result.response, {
      service: "gateway",
      valid: false,
      reason: expected,
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STAGE_SECRET|\/etc\//);
  }
  const invalid = createSupervisorHandler({
    run: stageGatewayState,
    readStageGatewayConfig: () => "{secret",
  });
  assert.deepEqual(
    (await invalid({ op: "config_validate", service: "gateway" })).response,
    { service: "gateway", valid: false, reason: "CONFIG_JSON_INVALID" },
  );
});

test("ambiguous running gateway units never authorize either config read", async () => {
  let reads = 0;
  const handler = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=active\n",
    readFile: () => {
      reads++;
      return validGateway;
    },
    readStageGatewayConfig: () => {
      reads++;
      return validGateway;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.equal(result.response.valid, false);
  assert.equal(reads, 0);
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
