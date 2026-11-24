import test from "node:test";
import assert from "node:assert/strict";
import { definitions } from "../src/tools.js";
import {
  APPROVED_ICON_URL,
  KMJ_STATUS_RESOURCE_URI,
  KMJ_STATUS_HTML,
  compactWorkBrief,
  compactStatusText,
} from "../src/branded-status.js";
const state = () =>
  compactWorkBrief({
    device: "device1",
    project: "project1",
    git: {
      ok: true,
      value: { status: "## feat/branch...origin/feat/branch\n M README.md\n" },
    },
    autopilot: {
      ok: true,
      value: {
        counts: { queued: 2, waiting: 1 },
        next: { id: "task-1", objective: "SECRET_DONT_OUTPUT" },
      },
    },
    capacity: {
      ok: true,
      value: { blocked: false, effectiveMaxConcurrent: 1, activeJobs: 0 },
    },
  });
test("minimal reusable work brief excludes objectives and large Git output", () => {
  const x = state();
  assert.equal(x.product, "KMJ CodeBridge");
  assert.equal(x.git.branch, "feat/branch...origin/feat/branch");
  assert.equal(x.git.dirty, true);
  assert.equal(x.nextReadyTaskId, "task-1");
  assert.equal(x.availableAuthorizedSlots, 1);
  assert.equal(x.action, "NEXT_READY_TASK");
  assert.equal(x.wholeProjectCompletionPercent, null);
  assert.equal(x.paidModelUsageEstimate, "NOT_MEASURED");
  assert.ok(JSON.stringify(x).length < 1000);
  assert.doesNotMatch(JSON.stringify(x), /SECRET_DONT_OUTPUT|README\.md/);
});
test("failed capability reports do not fabricate readiness", () => {
  const x = compactWorkBrief({
    device: "d",
    project: "p",
    git: { ok: false },
    autopilot: { ok: false },
    capacity: { ok: false },
  });
  assert.equal(x.action, "CHECK_PROJECT_READ_ACCESS");
  assert.equal(x.availableAuthorizedSlots, null);
  assert.equal(x.tasks, null);
  assert.match(compactStatusText(x), /NOT_EVALUATED/);
});
test("status UI is explicitly opt-in, uses pinned approved logo and no third-party scripts", () => {
  assert.equal(definitions.render_codebridge_status.access, "read");
  assert.equal(definitions.compact_work_brief.access, "read");
  assert.equal(KMJ_STATUS_RESOURCE_URI, "ui://kmj-codebridge/status-v1.html");
  assert.match(APPROVED_ICON_URL, /6ec9f2d352115beb37d68408c45dc750a5088787/);
  assert.match(KMJ_STATUS_HTML, /<img alt="Approved KMJ TECHNO icon"/);
  assert.match(KMJ_STATUS_HTML, /ui\/notifications\/tool-result/);
  assert.doesNotMatch(KMJ_STATUS_HTML, /<script src=|http:\/\//);
  assert.doesNotMatch(KMJ_STATUS_HTML, /SECRET_DONT_OUTPUT/);
});

test("native chat fallback shows bounded verified project receipts, not raw output", () => {
  const x = state();
  x.activity = {
    source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
    status: "AVAILABLE",
    items: [
      { state: "running", gate: "build", output: "DO_NOT_RENDER" },
      { state: "failed", gate: "lint", exitCode: 1 },
      { state: "succeeded", gate: "unit", exitCode: 0 },
      { state: "queued", gate: "integration" },
    ],
    hasMore: false,
  };
  const text = compactStatusText(x);
  assert.match(text, /Device: device1/);
  assert.match(text, /\[RUNNING\] build/);
  assert.match(text, /\[FAILED\] lint · exit 1/);
  assert.match(text, /\[SUCCEEDED\] unit · exit 0/);
  assert.match(text, /More receipts available/);
  assert.doesNotMatch(text, /DO_NOT_RENDER|integration/);
  assert.match(text, /Whole-product release: NOT_EVALUATED/);
});

test("unavailable receipt evidence cannot masquerade as success", () => {
  const x = state();
  x.activity = {
    status: "AVAILABLE",
    source: "UNVERIFIED",
    items: [{ state: "succeeded", gate: "build" }],
  };
  const text = compactStatusText(x);
  assert.match(text, /Recent jobs: NOT VERIFIED/);
  assert.doesNotMatch(text, /SUCCEEDED/);
});
