import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const standard = "/etc/kmj-codebridge/agent.json";
const dedicated = "/etc/kmj-codebridge-main-platform/agent.json";
const gateway = "/etc/kmj-codebridge/gateway.json";
const validStageGateway = JSON.stringify({
  oauth: {
    issuer: "https://kmjtechno.com",
    resource: "https://kmjtechno.com/mcp",
    jwksUri: "https://kmjtechno.com/jwks",
  },
});
const stageGatewayState = (_bin, args) =>
  args[1] === "kmj-codebridge-gateway-stage.service"
    ? "LoadState=loaded\nActiveState=active\n"
    : "LoadState=not-found\nActiveState=inactive\n";

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

test("active stage gateway refuses a missing protected stage config", async () => {
  const reads = [];
  const handler = createSupervisorHandler({
    run: stageGatewayState,
    readFile: (file) => {
      reads.push(file);
      throw new Error("stale canonical gateway must never be read");
    },
    readStageGatewayConfig: () => {
      reads.push("fixed-stage-reader");
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
  assert.deepEqual(reads, ["fixed-stage-reader"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_GATEWAY_CREDENTIAL|\/etc\//,
  );
});

test("active stage gateway validates only protected config, not runtime identity", async () => {
  const reads = [];
  const handler = createSupervisorHandler({
    run: stageGatewayState,
    readFile: (file) => {
      reads.push(file);
      throw new Error("must not read stale gateway config");
    },
    readStageGatewayConfig: () => {
      reads.push("fixed-stage-reader");
      return validStageGateway;
    },
  });
  const result = await handler({ op: "config_validate", service: "gateway" });
  assert.deepEqual(result.response, {
    service: "gateway",
    valid: true,
    runtimeBindingVerified: false,
    scope: "FIXED_STAGE_FILE_SCHEMA_ONLY",
    runtimeConfigAttested: false,
    signedRuntimeAttested: false,
  });
  assert.deepEqual(reads, ["fixed-stage-reader"]);
  assert.doesNotMatch(JSON.stringify(result), /jwks|token|\/etc\//i);
});

test("stage syntax, schema, trust and permission errors fail without fallback", async () => {
  const cases = [
    { body: "PRIVATE_JWKS_SECRET", reason: "CONFIG_JSON_INVALID" },
    {
      body: JSON.stringify({ github: { publicReadOnly: true } }),
      reason: "CONFIG_SCHEMA_INVALID",
    },
    { errno: "EACCES", reason: "CONFIG_FILE_UNREADABLE" },
    { errno: "CONFIG_TRUST_INVALID", reason: "CONFIG_TRUST_INVALID" },
  ];
  for (const c of cases) {
    const reads = [];
    const handler = createSupervisorHandler({
      run: stageGatewayState,
      readFile: () => {
        throw new Error("canonical config must not be read");
      },
      readStageGatewayConfig: () => {
        reads.push("fixed-stage-reader");
        if (c.errno) {
          const e = new Error("SECRET_STAGE_PATH");
          e.code = c.errno;
          throw e;
        }
        return c.body;
      },
    });
    const result = await handler({ op: "config_validate", service: "gateway" });
    assert.deepEqual(result.response, {
      service: "gateway",
      valid: false,
      reason: c.reason,
    });
    assert.deepEqual(reads, ["fixed-stage-reader"]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE_JWKS_SECRET|SECRET_STAGE_PATH|\/etc\//,
    );
  }
});

test("ambiguous or missing gateway unit never reads either credential path", async () => {
  for (const loaded of [0, 2]) {
    const reads = [];
    const handler = createSupervisorHandler({
      run: () =>
        loaded === 0
          ? "LoadState=not-found\nActiveState=inactive\n"
          : "LoadState=loaded\nActiveState=active\n",
      readFile: () => {
        reads.push("standard");
        throw new Error("must never read unselected config");
      },
      readStageGatewayConfig: () => {
        reads.push("stage");
        throw new Error("must never read unselected config");
      },
    });
    const result = await handler({ op: "config_validate", service: "gateway" });
    assert.deepEqual(result.response, {
      service: "gateway",
      valid: false,
      reason: "CONFIG_VALIDATION_FAILED",
    });
    assert.deepEqual(reads, []);
  }
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
