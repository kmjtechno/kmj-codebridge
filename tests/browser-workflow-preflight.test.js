import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { browserWorkflowPreflight } from "../src/browser-workflow-preflight.js";

test("Brevo Work-like preflight is explicitly a non-executing plan", () => {
  const p = browserWorkflowPreflight("brevo_domain_auth");
  assert.equal(p.schema, "kmj-browser-workflow-preflight-v1");
  assert.equal(p.mode, "PLAN_ONLY");
  assert.equal(p.authenticatedSession, "NOT_ATTACHED");
  assert.equal(p.readyToExecute, false);
  assert.equal(p.execution, "NOT_STARTED");
  assert.equal(p.site.origin, "https://app.brevo.com");
  assert.equal(p.site.senderDomain, "kmjtechno.com");
  assert.ok(p.ownerApprovalRequired);
  assert.equal(p.stages.length, 9);
  assert.ok(p.stages.every((s) => s.status === "NOT_STARTED"));
  assert.ok(p.stages.filter((s) => s.mode === "approval").length >= 4);
});

test("workflows cannot redirect onto unapproved URLs or pass secrets", () => {
  for (const value of [
    undefined,
    null,
    "",
    "http://127.0.0.1",
    "https://evil.example",
    "billing_upgrade",
    "brevo_domain_auth?token=ABC",
    "brevo_domain_auth\nhttps://localhost",
    { workflow: "brevo_domain_auth" },
  ]) {
    assert.throws(
      () => browserWorkflowPreflight(value),
      /BROWSER_WORKFLOW_NOT_ALLOWLISTED/,
    );
  }
  const p = browserWorkflowPreflight("brevo_domain_auth");
  const serialized = JSON.stringify(p);
  assert.doesNotMatch(serialized, /passwordValue|cookieValue|apiKeyValue/);
  assert.ok(p.forbidden.includes("paid_plan_or_subscription"));
  assert.ok(p.forbidden.includes("unapproved_dns_changes"));
});

test("no mutable global plan state survives caller edits", () => {
  const a = browserWorkflowPreflight("brevo_domain_auth");
  a.stages[0].status = "COMPLETE";
  a.forbidden.length = 0;
  const b = browserWorkflowPreflight("brevo_domain_auth");
  assert.equal(b.stages[0].status, "NOT_STARTED");
  assert.ok(b.forbidden.length > 0);
});

test("MCP preflight registration is read-only and separated from execution", () => {
  const tools = fs.readFileSync(
    new URL("../src/tools.js", import.meta.url),
    "utf8",
  );
  assert.match(tools, /browser_workflow_preflight:/);
  assert.match(tools, /if \(name === "browser_workflow_preflight"\)/);
  assert.match(tools, /browserWorkflowPreflight\(a\.workflow\)/);
  assert.match(tools, /BROWSER_WORKFLOW_PROJECT_NOT_ALLOWED/);
});
