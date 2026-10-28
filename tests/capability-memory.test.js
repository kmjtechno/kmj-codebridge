import test from "node:test";
import assert from "node:assert/strict";

import { buildCapabilityMemory } from "../src/capability-memory.js";
import { buildChatWorkspaceOpen } from "../src/chat-workspace-open.js";

const item = (tool, risk = "READ", approvalRequired = false) => ({
  tool,
  risk,
  approvalRequired,
  access: "read",
});
const catalog = {
  tools: [
    item("chat_continuity_read"),
    item("chat_continuity_save", "EDIT"),
    item("policy_catalog"),
    item("github_pull_request_ci"),
    item("supervisor_main_platform_production_activate", "DEPLOY", true),
    item("local_model_status"),
    item("autopilot_worker_runtime_status"),
    item("browser_fast_probe", "SERVICE"),
  ],
};

test("saved feature knowledge is built from live scoped policy, not stale guesses", () => {
  const result = buildCapabilityMemory({
    catalog,
    inspected: {
      connection: "connected",
      version: "0.3.2",
      runtimeRevision: { commit: "a".repeat(40) },
    },
    model: { readyForOnDemandUse: false },
    worker: { workers: { gate: { loopStarted: true }, localDraft: { loopStarted: false } } },
    updater: { service: { installed: false } },
  });
  assert.equal(result.status, "CATALOG_REPORTED");
  assert.equal(result.advertisedToolCount, catalog.tools.length);
  assert.ok(result.advertisedToolsByCategory.continuity.includes("chat_continuity_read"));
  assert.ok(result.advertisedToolsByCategory.github.includes("github_pull_request_ci"));
  assert.ok(result.approvalRequiredRisks.includes("DEPLOY"));
  assert.equal(result.runtime.localDraftLoopStarted, false);
  assert.equal(result.runtime.localModelReady, false);
  assert.equal(result.runtime.updaterInstalled, false);
  assert.equal(result.runtime.autonomousCodingLiveVerified, false);
  assert.equal(result.runtime.rootShellGrantedVerified, false);
  assert.equal(result.callableVerified, false);
  assert.equal(result.permissionGrant, false);
  assert.equal(result.persistedModelMemory, false);
});

test("missing, malformed and untrusted catalog never manufacture enabled capabilities", () => {
  const bad = buildCapabilityMemory({
    catalog: {
      tools: [
        item("chat_continuity_read"),
        item("chat_continuity_read"),
        item("supervisor_restart", "PRIVILEGED", true),
        item("../../etc/shadow"),
        item("cat_new", "UNKNOWN", false),
        { tool: "github_pr_create", risk: "EDIT", access: "read", approvalRequired: "false" },
      ],
    },
    inspected: {
      connection: "offline",
      runtimeRevision: { commit: "/root/secret" },
    },
    model: { readyForOnDemandUse: "true" },
  });
  assert.equal(bad.advertisedToolCount, 2);
  assert.equal(bad.runtime.revision, null);
  assert.equal(bad.runtime.connected, false);
  assert.equal(bad.runtime.localModelReady, null);
  assert.equal(JSON.stringify(bad).includes("/root/secret"), false);
  assert.equal(JSON.stringify(bad).includes("../../etc"), false);

  const unavailable = buildCapabilityMemory({ catalog: null });
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.advertisedToolCount, 0);
  assert.equal(unavailable.runtime.localDraftLoopStarted, null);
  assert.equal(unavailable.runtime.rootShellGrantedVerified, false);
});

test("one-call chat workspace resume carries current capabilities and durable checkpoint", () => {
  const liveCatalog = buildCapabilityMemory({ catalog });
  const first = buildChatWorkspaceOpen({
    device: "d1",
    project: "p1",
    lane: "codebridge-24x7",
    checkpoint: {
      exists: true,
      revision: "a".repeat(64),
      summary: "Continue safe CodeBridge work",
      blockers: ["Nonroot source object access"],
      nextSteps: ["Review isolated source provisioner"],
    },
    capabilityMemory: liveCatalog,
  });
  assert.equal(first.checkpoint.status, "SAVED");
  assert.deepEqual(first.capabilities.liveCatalog, liveCatalog);
  assert.equal(first.hostLimitations.inactiveChatWakeSupported, false);
  assert.equal(first.hostLimitations.chatTranscriptCaptured, false);
  const unchanged = buildChatWorkspaceOpen({
    device: "d1",
    project: "p1",
    lane: "codebridge-24x7",
    checkpoint: {
      exists: true,
      revision: "a".repeat(64),
      summary: "Continue safe CodeBridge work",
      blockers: ["Nonroot source object access"],
      nextSteps: ["Review isolated source provisioner"],
    },
    capabilityMemory: liveCatalog,
    ifNoneMatch: first.revision,
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.revision, first.revision);
});
