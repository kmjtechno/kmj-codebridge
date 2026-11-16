import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenHandsCanvasHandoff,
  KMJ_CODEBRIDGE_MCP_URL,
} from "../src/openhands-canvas-interop.js";

test("defaults are fail-closed and make no deployment claims", () => {
  const profile = createOpenHandsCanvasHandoff();
  assert.equal(profile.status, "PILOT_BLOCKED");
  assert.equal(profile.sourceOnly, true);
  assert.equal(profile.executionAttempted, false);
  assert.equal(profile.productionMutation, false);
  assert.equal(profile.mcp.url, KMJ_CODEBRIDGE_MCP_URL);
  assert.deepEqual(profile.blockers, [
    "SANDBOX_NOT_VERIFIED",
    "MCP_OAUTH_NOT_VERIFIED",
    "FREE_MODEL_ROUTE_NOT_VERIFIED",
    "OWNER_TASK_APPROVAL_MISSING",
  ]);
});

test("cannot redirect MCP to attacker endpoints or localhost", () => {
  for (const endpoint of [
    "http://127.0.0.1:8080/mcp",
    "https://kmjtechno.com.evil.example/mcp",
    "https://kmjtechno.com/mcp?token=secret",
    "https://kmjtechno.com/mcp/",
    "",
    null,
  ])
    assert.throws(
      () => createOpenHandsCanvasHandoff({ endpoint }),
      /OPENHANDS_UNAPPROVED_MCP_ENDPOINT/,
    );
});

test("refuses host runtime, elevated execution and unknown tasks", () => {
  for (const runtime of ["host", "root", "remote-shell", "docker", null])
    assert.throws(
      () => createOpenHandsCanvasHandoff({ runtime }),
      /OPENHANDS_UNSAFE_RUNTIME/,
    );
  for (const task of ["production-deploy", "delete-all", "", null])
    assert.throws(
      () => createOpenHandsCanvasHandoff({ task }),
      /OPENHANDS_UNAPPROVED_TASK/,
    );
});

test("refuses production writes under any approval combination", () => {
  assert.throws(
    () => createOpenHandsCanvasHandoff({
      sandboxVerified: true,
      oauthVerified: true,
      freeModelRouteVerified: true,
      ownerApproved: true,
      enableProductionWrites: true,
    }),
    /OPENHANDS_PRODUCTION_WRITE_DENIED/,
  );
});

test("rejects untyped approvals rather than truthy strings", () => {
  for (const key of [
    "sandboxVerified",
    "oauthVerified",
    "freeModelRouteVerified",
    "ownerApproved",
    "enableProductionWrites",
  ])
    assert.throws(
      () => createOpenHandsCanvasHandoff({ [key]: "true" }),
      /OPENHANDS_INVALID_APPROVAL_FLAGS/,
    );
});

test("each missing approval keeps pilot blocked", () => {
  const flags = {
    sandboxVerified: true,
    oauthVerified: true,
    freeModelRouteVerified: true,
    ownerApproved: true,
  };
  for (const key of Object.keys(flags)) {
    const result = createOpenHandsCanvasHandoff({
      ...flags,
      [key]: false,
    });
    assert.equal(result.status, "PILOT_BLOCKED");
    assert.equal(result.blockers.length, 1);
  }
});

test("all externally verified flags unlock only a manual isolated pilot", () => {
  const plan = createOpenHandsCanvasHandoff({
    sandboxVerified: true,
    oauthVerified: true,
    freeModelRouteVerified: true,
    ownerApproved: true,
    task: "implementation",
  });
  assert.equal(plan.status, "READY_FOR_MANUAL_PILOT");
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.agentCanvas.runtime, "isolated-docker");
  assert.equal(plan.agentCanvas.approval, "manual per task and privileged operation");
  assert.equal(plan.productionMutation, false);
  assert.equal(plan.executionAttempted, false);
});

test("serialized profile contains no tokens, keys or secret fields", () => {
  const json = JSON.stringify(createOpenHandsCanvasHandoff());
  assert.ok(!/api.key|access.token|password|bearer/i.test(json));
});
