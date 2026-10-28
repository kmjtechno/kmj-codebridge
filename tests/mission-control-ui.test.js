import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { KMJ_STATUS_HTML, APPROVED_ICON_URL } from "../src/branded-status.js";

function openCard(initialOutput = null) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id,
        textContent: "",
        hidden: false,
        tabIndex: 0,
        attributes: {},
        classList: {
          add: (name) => classes.add(name),
          toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
          contains: (name) => classes.has(name),
        },
        handlers: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        getAttribute(name) {
          return this.attributes[name];
        },
        addEventListener(name, fn) {
          this.handlers[name] = fn;
        },
        focus() {
          this.focused = true;
        },
      });
    }
    return elements.get(id);
  }
  const views = ["overview", "work", "evidence", "workspace"];
  for (const view of views) {
    element("tab-" + view).attributes["data-view"] = view;
    element("panel-" + view);
  }
  const handlers = {};
  const parentMessages = [];
  const parent = {
    postMessage(message, origin) {
      parentMessages.push({ message, origin });
    },
  };
  const window = {
    parent,
    openai: initialOutput ? { toolOutput: initialOutput } : {},
    addEventListener(name, callback) {
      handlers[name] = callback;
    },
  };
  const document = {
    getElementById: element,
    querySelectorAll: (query) =>
      query === "nav button[data-view]"
        ? views.map((view) => element("tab-" + view))
        : [],
  };
  const script = KMJ_STATUS_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "The widget must contain its local UI controller");
  vm.runInNewContext(script, { window, document }, { timeout: 1000 });
  return {
    element,
    parentMessages,
    handshake() {
      handlers.message({
        source: parent,
        data: {
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2026-01-26" },
        },
      });
    },
    replyHost(id, error = null) {
      handlers.message({
        source: parent,
        data: error
          ? { jsonrpc: "2.0", id, error: { code: -32000, message: error } }
          : { jsonrpc: "2.0", id, result: {} },
      });
    },
    send(data, source = parent) {
      handlers.message({
        source,
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { structuredContent: data },
        },
      });
    },
  };
}

test("premium MCP Apps UI keeps the canonical pinned KMJ icon and status resource", () => {
  assert.match(KMJ_STATUS_HTML, /<img alt="Approved KMJ TECHNO icon"/);
  assert.ok(KMJ_STATUS_HTML.includes(APPROVED_ICON_URL));
  assert.match(KMJ_STATUS_HTML, /role="tablist"/);
  assert.match(KMJ_STATUS_HTML, /role="tabpanel"/);
  assert.match(KMJ_STATUS_HTML, /prefers-reduced-motion:reduce/);
  assert.match(KMJ_STATUS_HTML, /ui\/notifications\/tool-result/);
  assert.doesNotMatch(
    KMJ_STATUS_HTML,
    /<script\s+src=|fetch\s*\(|XMLHttpRequest|new WebSocket\s*\(/i,
  );
});

test("MCP Apps sends the portable handshake before receiving results", () => {
  const view = openCard();
  assert.equal(view.parentMessages.length, 1);
  assert.equal(view.parentMessages[0].message.method, "ui/initialize");
  assert.equal(
    view.parentMessages[0].message.params.protocolVersion,
    "2026-01-26",
  );
  view.handshake();
  assert.equal(view.parentMessages.length, 2);
  assert.equal(
    view.parentMessages[1].message.method,
    "ui/notifications/initialized",
  );
  view.handshake();
  assert.equal(view.parentMessages.length, 2);
});

test("initial UI never invents workers, task counts, capacity, or release progress", () => {
  const view = openCard();
  assert.equal(view.element("running").textContent, "");
  assert.equal(view.element("signalText").textContent, "");
  assert.equal(view.element("node-execute").classList.contains("busy"), false);
  view.send({
    product: "KMJ CodeBridge",
    project: "authorized-project",
    device: "device1",
    evidence: { git: false, tasks: false, capacity: false },
    availableAuthorizedSlots: 11,
    tasks: { running: 20, queued: 22 },
    action: "CHECK_PROJECT_READ_ACCESS",
  });
  assert.equal(view.element("running").textContent, "—");
  assert.equal(view.element("slots").textContent, "—");
  assert.equal(view.element("gitEvidence").textContent, "Not reported");
  assert.equal(view.element("signalText").textContent, "SNAPSHOT RECEIVED");
});

test("verified task counts show correctly, host events update, and the running state is evidence-based", () => {
  const view = openCard({
    product: "KMJ CodeBridge",
    project: "project1",
    device: "device1",
    evidence: { git: true, tasks: true, capacity: true },
    git: { branch: "feature/ui", dirty: true },
    tasks: {
      queued: 4,
      running: 2,
      waiting: 1,
      succeeded: 7,
      failed: 0,
      cancelled: 0,
    },
    availableAuthorizedSlots: 1,
    nextReadyTaskId: "fix-17",
  });
  assert.equal(view.element("project").textContent, "project1");
  assert.equal(view.element("running").textContent, "2");
  assert.equal(view.element("queued").textContent, "4");
  assert.equal(view.element("slots").textContent, "1");
  assert.equal(view.element("succeeded").textContent, "7");
  assert.equal(view.element("branch").textContent, "feature/ui");
  assert.equal(view.element("node-execute").classList.contains("busy"), true);
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    device: "device1",
    evidence: { tasks: true, git: false, capacity: true },
    tasks: {
      running: 0,
      queued: 0,
      waiting: 0,
      succeeded: 8,
      failed: 0,
      cancelled: 0,
    },
    availableAuthorizedSlots: 2,
  });
  assert.equal(view.element("running").textContent, "0");
  assert.equal(view.element("node-execute").classList.contains("busy"), false);
  view.send({ product: "KMJ CodeBridge", project: "untrusted" }, {});
  assert.equal(view.element("project").textContent, "project1");
});

test("the overview/workstream/evidence tabs are actual accessible interactive controls", () => {
  const view = openCard();
  const workTab = view.element("tab-work");
  workTab.handlers.click();
  assert.equal(workTab.attributes["aria-selected"], "true");
  assert.equal(view.element("panel-work").hidden, false);
  assert.equal(view.element("panel-overview").hidden, true);
  let prevented = false;
  workTab.handlers.keydown({
    key: "ArrowRight",
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(
    view.element("tab-evidence").attributes["aria-selected"],
    "true",
  );
  assert.equal(view.element("tab-evidence").focused, true);
});

test("authenticated project job receipts render real status timeline without executing tools", () => {
  const view = openCard();
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    evidence: { git: false, tasks: false, capacity: false },
    activity: {
      source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
      status: "AVAILABLE",
      observedAt: "2026-10-16T02:00:00Z",
      hasMore: true,
      items: [
        {
          id: "job-123",
          gate: "p720_ai_tests",
          state: "running",
          at: "2026-10-16T01:59:00.000Z",
        },
        {
          id: "job-122",
          gate: "check",
          state: "succeeded",
          at: "2026-10-16T01:58:00.000Z",
        },
      ],
    },
  });
  assert.equal(view.element("activity-0").hidden, false);
  assert.equal(
    view.element("activity-title-0").textContent,
    "p720_ai_tests · running",
  );
  assert.equal(
    view.element("activity-time-0").textContent,
    "2026-10-16T01:59:00.000Z",
  );
  assert.equal(view.element("activity-0").attributes["data-state"], "running");
  assert.equal(view.element("activity-1").hidden, false);
  assert.equal(view.element("activity-2").hidden, true);
  assert.match(
    view.element("activityNotice").textContent,
    /More entries available/,
  );

  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    activity: {
      source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
      status: "UNAVAILABLE",
    },
  });
  assert.equal(view.element("activity-0").hidden, true);
  assert.match(view.element("activityNotice").textContent, /No verified/);
});

test("unverified or hostile job receipts cannot create convincing work activity", () => {
  const view = openCard();
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    activity: {
      source: "UNTRUSTED_FIXTURE",
      status: "AVAILABLE",
      items: [{ gate: "build", state: "running", at: "2026-10-16T02:00:00Z" }],
    },
  });
  assert.equal(view.element("activity-0").hidden, true);
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    activity: {
      source: "AUTHORIZED_PROJECT_JOB_RECEIPTS",
      status: "AVAILABLE",
      items: [
        {
          gate: "<img src=x onerror=alert(1)>",
          state: "succeeded",
          at: "2026-10-16T02:00:00Z",
        },
      ],
    },
  });
  assert.equal(view.element("activity-0").hidden, true);
});

test("optional Workspace renders scoped files and filters tracked diffs on click", () => {
  const view = openCard();
  const patch =
    "diff --git a/src/tools.js b/src/tools.js\n--- a/src/tools.js\n+++ b/src/tools.js\n@@ -1 +1 @@\n-old\n+new\n" +
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old-doc\n+new-doc\n";
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    workspace: {
      source: "AUTHORIZED_PROJECT_READS",
      tree: {
        status: "AVAILABLE",
        truncated: false,
        entries: [
          { path: "src", type: "directory", depth: 0 },
          { path: "src/tools.js", type: "file", depth: 1 },
          { path: "README.md", type: "file", depth: 0 },
        ],
      },
      diff: { status: "AVAILABLE", patch, truncated: false },
    },
  });
  assert.equal(view.element("workspace-file-0").hidden, false);
  assert.equal(view.element("workspace-file-0").textContent, "src/tools.js");
  assert.equal(view.element("workspace-file-1").textContent, "README.md");
  assert.equal(view.element("workspace-file-2").hidden, true);
  assert.equal(view.element("workspaceDiff").textContent, patch);
  view.element("workspace-file-1").handlers.click();
  assert.equal(
    view.element("workspace-file-1").attributes["aria-pressed"],
    "true",
  );
  assert.match(view.element("workspaceDiff").textContent, /new-doc/);
  assert.doesNotMatch(view.element("workspaceDiff").textContent, /\+new\n/);

  view.send({ product: "KMJ CodeBridge", project: "project1" });
  assert.equal(view.element("workspace-file-0").hidden, true);
  assert.equal(view.element("workspaceDiff").textContent, "");
  assert.match(
    view.element("workspaceFilesHint").textContent,
    /includeWorkspace/,
  );
});

test("Workspace patch uses a separate 24 KiB plain-text budget without widening status labels", () => {
  const view = openCard();
  const patch =
    "diff --git a/README.md b/README.md\n" +
    "<img src=x onerror=alert(1)>".repeat(1300);
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    workspace: {
      source: "AUTHORIZED_PROJECT_READS",
      tree: {
        status: "AVAILABLE",
        truncated: false,
        entries: [{ path: "README.md", type: "file", depth: 0 }],
      },
      diff: { status: "AVAILABLE", patch, truncated: true },
    },
  });
  assert.equal(view.element("workspaceDiff").textContent.length, 24576);
  assert.equal(
    view.element("workspaceDiff").textContent,
    patch.slice(0, 24576),
  );
  assert.equal(
    view.element("workspaceDiffHint").textContent.includes("truncated"),
    true,
  );
  view.element("workspace-file-0").handlers.click();
  assert.equal(view.element("workspaceDiff").textContent.length, 24576);
  assert.equal(
    view.element("workspace-file-0").attributes["aria-pressed"],
    "true",
  );
  assert.equal(
    view.element("workspaceDiff").textContent.includes("<img"),
    true,
  );
});

test("no workspace data does not invent file availability or simulate a diff", () => {
  const view = openCard();
  assert.equal(view.element("workspace-file-0").hidden, false);
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    workspace: {
      source: "UNVERIFIED",
      tree: {
        status: "AVAILABLE",
        entries: [{ path: "secret", type: "file" }],
      },
      diff: { status: "AVAILABLE", patch: "secret=abc" },
    },
  });
  assert.equal(view.element("workspace-file-0").hidden, true);
  assert.equal(view.element("workspaceDiff").textContent, "");
});

test("tool strings are plain text, bounded, and cannot inject markup", () => {
  const view = openCard();
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "<script>alert(1)</script>",
    evidence: { git: true, tasks: true, capacity: true },
    git: { branch: "<img src=x onerror=alert(1)>", dirty: true },
    tasks: { running: -2, queued: 5 },
    availableAuthorizedSlots: Number.POSITIVE_INFINITY,
  });
  assert.equal(view.element("project").textContent, "Not provided");
  assert.equal(
    view.element("branch").textContent,
    "<img src=x onerror=alert(1)>",
  );
  assert.equal(view.element("running").textContent, "—");
  assert.equal(view.element("slots").textContent, "—");
});

test("AI chat handoff requires initialized host, explicit intent and authorized project", () => {
  const view = openCard();
  view.element("aiPrompt").value = "Fix the current layout regression";
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 1);
  view.handshake();
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({
    product: "KMJ CodeBridge",
    project: "kmj-main-platform",
    device: "kmj-elite-main-platform",
    evidence: { git: true, tasks: true, capacity: false },
  });
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  const result = view.parentMessages[2].message;
  assert.equal(result.method, "ui/message");
  assert.equal(result.params.role, "user");
  assert.equal(result.params.content.type, "text");
  assert.match(result.params.content.text, /Fix the current layout regression/);
  assert.match(result.params.content.text, /no unapproved production cutover/);
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyHost(2);
  assert.match(view.element("aiChatNotice").textContent, /not verified/);
});
test("AI chat rejects forged scope and host denial is visible", () => {
  const view = openCard();
  view.handshake();
  view.element("aiPrompt").value = "Investigate the product editor";
  view.send({product:"KMJ CodeBridge", project:"../other", device:"device1"});
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({product:"KMJ CodeBridge", project:"project1", device:"device1"});
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyHost(2, "Denied by host");
  assert.match(view.element("aiChatNotice").textContent, /denied/);
});
