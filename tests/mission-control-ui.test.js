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
  const views = ["overview", "work", "evidence", "workspace", "devices"];
  for (const view of views) {
    element("tab-" + view).attributes["data-view"] = view;
    element("rail-" + view).attributes["data-target-view"] = view;
    element("panel-" + view);
  }
  element("inspector-work").attributes["data-target-view"] = "work";
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
        : query === ".kmj-rail-action[data-target-view]"
          ? views.map((view) => element("rail-" + view))
          : query ===
              ".kmj-rail-action[data-target-view],.kmj-inspector-action[data-target-view]"
            ? [
                ...views.map((view) => element("rail-" + view)),
                element("inspector-work"),
              ]
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
    replyResult(id, result) {
      handlers.message({
        source: parent,
        data: { jsonrpc: "2.0", id, result },
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
  view.element("showAllDiff").handlers.click();
  assert.equal(view.element("workspaceDiff").textContent, patch);

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
  view.send({
    product: "KMJ CodeBridge",
    project: "../other",
    device: "device1",
  });
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    device: "device1",
  });
  view.element("askHostAi").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyHost(2, "Denied by host");
  assert.match(view.element("aiChatNotice").textContent, /denied/);
});

test("AI chat host errors and malformed acknowledgments never claim delivery", () => {
  const view = openCard();
  view.handshake();
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  view.element("aiPrompt").value = "Review the signed release gates";
  for (const result of [{ isError: true }, null, false]) {
    view.element("askHostAi").handlers.click();
    assert.equal(view.parentMessages.at(-1).message.method, "ui/message");
    view.replyResult(2, result);
    assert.match(
      view.element("aiChatNotice").textContent,
      /no AI chat delivery or work is verified/,
    );
    assert.doesNotMatch(
      view.element("aiChatNotice").textContent,
      /Host acknowledged/,
    );
  }
  view.element("askHostAi").handlers.click();
  view.replyResult(2, {});
  assert.match(
    view.element("aiChatNotice").textContent,
    /Host acknowledged AI chat message/,
  );
  assert.match(view.element("aiChatNotice").textContent, /not verified/);
});

test("development task enqueues only on a real click and never reports execution", () => {
  const view = openCard();
  view.handshake();
  view.element("aiPrompt").value = "Repair the isolated staging CI failure";
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  assert.equal(view.parentMessages.length, 2);
  view.element("queueDevTask").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  const request = view.parentMessages[2].message;
  assert.equal(request.method, "tools/call");
  assert.equal(request.params.name, "autopilot_enqueue");
  assert.equal(request.params.arguments.device, "device1");
  assert.equal(request.params.arguments.project, "project1");
  assert.equal(request.params.arguments.priority, 0);
  assert.match(request.params.arguments.key, /^mission-ui:/);
  view.element("queueDevTask").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyHost(3);
  assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
});
test("no valid project or a denied queue request never appears accepted", () => {
  const view = openCard();
  view.handshake();
  view.element("aiPrompt").value = "Investigate README smoke";
  view.element("queueDevTask").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  view.element("queueDevTask").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyHost(3, "Not authorized");
  assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
});

test("progress refresh uses authorized project and rejects cross-project tool output", () => {
  const v = openCard();
  v.handshake();
  v.element("refreshProgress").handlers.click();
  assert.equal(v.parentMessages.length, 2);
  v.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
    evidence: { tasks: true, git: false, capacity: false },
    tasks: { running: 1, queued: 1 },
  });
  v.element("refreshProgress").handlers.click();
  assert.equal(v.parentMessages.length, 3);
  assert.equal(v.parentMessages[2].message.method, "tools/call");
  assert.equal(
    v.parentMessages[2].message.params.name,
    "render_codebridge_status",
  );
  assert.equal(
    v.parentMessages[2].message.params.arguments.project,
    "project1",
  );
  v.replyResult(4, {
    structuredContent: {
      product: "KMJ CodeBridge",
      device: "device1",
      project: "foreign",
    },
  });
  assert.match(v.element("progressRefreshNotice").textContent, /unavailable/);
  v.element("refreshProgress").handlers.click();
  v.replyResult(4, {
    structuredContent: {
      product: "KMJ CodeBridge",
      device: "device1",
      project: "project1",
      evidence: { tasks: true, git: false, capacity: false },
      tasks: { running: 3, queued: 2 },
    },
  });
  assert.equal(v.element("running").textContent, "3");
  assert.match(
    v.element("progressRefreshNotice").textContent,
    /authenticated snapshot/,
  );
});

test("queue ACK requires a real matching scoped task receipt, not a bare host success", () => {
  const view = openCard();
  view.handshake();
  view.element("aiPrompt").value = "Investigate the isolated CI failure";
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  view.element("queueDevTask").handlers.click();
  const first = view.parentMessages.at(-1).message.params.arguments;
  view.replyHost(3);
  assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
  view.element("queueDevTask").handlers.click();
  const retry = view.parentMessages.at(-1).message.params.arguments;
  assert.equal(
    retry.key,
    first.key,
    "ambiguous ACK must not generate a second task key",
  );
  view.replyResult(3, {
    structuredContent: {
      id: "e6c15cb8-17a0-40b7-9228-b16a39d59ec3",
      key: retry.key,
      project: "foreign-project",
      state: "queued",
    },
  });
  assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
  view.element("queueDevTask").handlers.click();
  assert.equal(
    view.parentMessages.at(-1).message.params.arguments.key,
    first.key,
  );
  view.replyResult(3, {
    structuredContent: {
      id: "e6c15cb8-17a0-40b7-9228-b16a39d59ec3",
      key: first.key,
      project: "project1",
      state: "queued",
    },
  });
  assert.match(
    view.element("aiChatNotice").textContent,
    /Task queued with scoped receipt/,
  );
  assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
  view.element("queueDevTask").handlers.click();
  assert.notEqual(
    view.parentMessages.at(-1).message.params.arguments.key,
    first.key,
  );
});

test("queue receipt rejects forged key, missing task id, nonqueued state and tool errors", () => {
  const view = openCard();
  view.handshake();
  view.element("aiPrompt").value = "Review safe worker canary plan";
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  for (const result of [
    {
      structuredContent: {
        id: "e6c15cb8-17a0-40b7-9228-b16a39d59ec3",
        key: "other",
        project: "project1",
        state: "queued",
      },
    },
    {
      structuredContent: {
        id: "",
        key: "other",
        project: "project1",
        state: "queued",
      },
    },
    {
      structuredContent: {
        id: "e6c15cb8-17a0-40b7-9228-b16a39d59ec3",
        key: "other",
        project: "project1",
        state: "running",
      },
    },
    {
      isError: true,
      structuredContent: {
        id: "e6c15cb8-17a0-40b7-9228-b16a39d59ec3",
        key: "other",
        project: "project1",
        state: "queued",
      },
    },
  ]) {
    view.element("queueDevTask").handlers.click();
    view.replyResult(3, result);
    assert.match(view.element("aiChatNotice").textContent, /NOT verified/);
  }
});

test("locked CodeBridge workspace is a responsive three-panel functional shell", () => {
  assert.match(KMJ_STATUS_HTML, /class="kmj-workspace"/);
  assert.match(KMJ_STATUS_HTML, /class="kmj-rail"/);
  assert.match(KMJ_STATUS_HTML, /class="kmj-main"/);
  assert.match(KMJ_STATUS_HTML, /class="kmj-inspector"/);
  assert.match(KMJ_STATUS_HTML, /class="kmj-composer"/);
  assert.match(KMJ_STATUS_HTML, /@media\(max-width:640px\)/);
  assert.match(KMJ_STATUS_HTML, /aria-label="CodeBridge project navigation"/);
  assert.match(KMJ_STATUS_HTML, /Host-managed conversations/);
  assert.match(KMJ_STATUS_HTML, /Provider \/ model/);
  assert.equal((KMJ_STATUS_HTML.match(/id="aiPrompt"/g) ?? []).length, 1);
  assert.ok(!KMJ_STATUS_HTML.includes("__CODEBRIDGE_APPROVED_ICON_URL__"));
  assert.doesNotMatch(
    KMJ_STATUS_HTML,
    /<script\s+src=|fetch\s*\(|XMLHttpRequest|new WebSocket\s*\(/i,
  );

  const view = openCard();
  view.element("rail-work").handlers.click();
  assert.equal(view.element("tab-work").attributes["aria-selected"], "true");
  assert.equal(view.element("panel-work").hidden, false);
  assert.equal(view.element("rail-work").attributes["aria-current"], "page");
  view.element("inspector-work").handlers.click();
  assert.equal(view.element("tab-work").focused, true);
  view.element("rail-workspace").handlers.click();
  assert.equal(view.element("panel-workspace").hidden, false);
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
    evidence: { git: false, tasks: false, capacity: false },
  });
  assert.equal(view.element("inspectorProject").textContent, "project1");
  assert.equal(view.element("inspectorDevice").textContent, "device1");
});

test("readable locked workspace scales on mobile and preserves evidence-only state", () => {
  assert.match(
    KMJ_STATUS_HTML,
    /\.kmj-workspace\{font-size:14px;line-height:1\.55\}/,
  );
  assert.match(
    KMJ_STATUS_HTML,
    /nav\[role="tablist"\]\{overflow-x:auto;flex-wrap:nowrap\}/,
  );
  assert.match(
    KMJ_STATUS_HTML,
    /aria-keyshortcuts="Control\+Enter Meta\+Enter"/,
  );
  assert.match(KMJ_STATUS_HTML, /Ctrl\+Enter \(or ⌘\+Enter\)/);
  assert.match(KMJ_STATUS_HTML, /worker claim and completion NOT verified/);
  assert.doesNotMatch(
    KMJ_STATUS_HTML,
    /<script\s+src=|fetch\s*\(|XMLHttpRequest|new WebSocket\s*\(/i,
  );
});

test("Ctrl/Meta+Enter asks only initialized scoped host, never starts a job", () => {
  const view = openCard();
  const prompt = view.element("aiPrompt");
  prompt.value = "Investigate the gateway exact-deploy SHA mismatch";
  const key = (options) => {
    let prevented = false;
    prompt.handlers.keydown({
      key: "Enter",
      preventDefault() {
        prevented = true;
      },
      ...options,
    });
    return prevented;
  };
  assert.equal(key({ ctrlKey: true }), true);
  assert.match(view.element("aiChatNotice").textContent, /not initialized/);
  assert.equal(view.parentMessages.length, 1);
  view.handshake();
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    device: "device1",
  });
  assert.equal(key({}), false);
  assert.equal(key({ ctrlKey: true, isComposing: true }), false);
  assert.equal(key({ ctrlKey: true, shiftKey: true }), false);
  assert.equal(view.parentMessages.length, 2);
  assert.equal(key({ ctrlKey: true }), true);
  assert.equal(view.parentMessages.at(-1).message.method, "ui/message");
  assert.match(
    view.parentMessages.at(-1).message.params.content.text,
    /project1/,
  );
  assert.equal(view.parentMessages.length, 3);
  assert.equal(key({ metaKey: true }), true);
  assert.equal(
    view.parentMessages.length,
    3,
    "pending request must not duplicate",
  );
  view.replyHost(2);
  assert.equal(key({ metaKey: true }), true);
  assert.equal(view.parentMessages.length, 4);
  assert.equal(view.parentMessages.at(-1).message.method, "ui/message");
});

test("cross-chat handoff requires a host handshake and valid project scope", () => {
  const view = openCard();
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 1);
  assert.match(view.element("aiChatNotice").textContent, /no checkpoint saved/);
  view.handshake();
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "../untrusted",
  });
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 2);
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  assert.equal(view.parentMessages.length, 2);
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  const request = view.parentMessages.at(-1).message;
  assert.equal(request.method, "ui/message");
  assert.equal(request.params.role, "user");
  assert.match(request.params.content.text, /project project1/);
  assert.match(request.params.content.text, /device device1/);
  assert.match(request.params.content.text, /lane mission-control/);
  assert.match(request.params.content.text, /compact_session_resume/);
  assert.match(request.params.content.text, /compact_session_save/);
  assert.match(request.params.content.text, /chat_continuity_read/);
  assert.match(request.params.content.text, /chat_continuity_save/);
  assert.match(request.params.content.text, /matching legacy revision/);
  assert.match(request.params.content.text, /exact expectedRevision/);
  assert.match(request.params.content.text, /Re-read.*verify persistence/);
  assert.match(request.params.content.text, /NOT_SAVED/);
  assert.match(request.params.content.text, /Never capture a raw transcript/);
  assert.equal(
    view.parentMessages.filter((entry) => entry.message.method === "tools/call")
      .length,
    0,
  );
});

test("handoff is deduplicated pending host reply and ACK never claims saved", () => {
  const view = openCard();
  view.handshake();
  view.send({
    product: "KMJ CodeBridge",
    device: "device1",
    project: "project1",
  });
  view.element("checkpointHandoff").handlers.click();
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 3);
  view.replyResult(5, {});
  assert.match(view.element("aiChatNotice").textContent, /UNVERIFIED/);
  assert.doesNotMatch(
    view.element("aiChatNotice").textContent,
    /checkpoint saved/i,
  );
  view.element("checkpointHandoff").handlers.click();
  assert.equal(view.parentMessages.length, 4);
  view.replyHost(5, "Denied");
  assert.match(
    view.element("aiChatNotice").textContent,
    /no saved checkpoint is verified/,
  );
  assert.equal(view.parentMessages.at(-1).message.method, "ui/message");
});

test("handoff UI explicitly distinguishes CodeBridge continuation from host chat limits", () => {
  assert.match(KMJ_STATUS_HTML, /id="checkpointHandoff"/);
  assert.match(
    KMJ_STATUS_HTML,
    /ChatGPT host conversation limits cannot be increased/,
  );
  assert.match(KMJ_STATUS_HTML, /only report saved after readback/);
  assert.match(KMJ_STATUS_HTML, /no saved checkpoint is verified/);
  assert.doesNotMatch(
    KMJ_STATUS_HTML,
    /<script\s+src=|fetch\s*\(|XMLHttpRequest|new WebSocket\s*\(/i,
  );
});

test("real connection_overview may omit connectionState on unregistered device without breaking fleet", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
        {
          device: "device2",
          project: "project2",
          status: "GATEWAY_REGISTRATION_MISSING",
          nextAction: "RUN_VM_CONNECTION_DOCTOR",
        },
      ],
    },
  });
  assert.equal(v.element("fleetKnown").textContent, "2");
  assert.equal(v.element("fleetReady").textContent, "1");
  assert.equal(v.element("fleetAttention").textContent, "1");
  assert.match(
    v.element("fleet-device-1").textContent,
    /GATEWAY_REGISTRATION_MISSING/,
  );
});

test("a registered device that has never reported does not invalidate the fleet", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
        {
          device: "device2",
          project: "project2",
          status: "AGENT_NEVER_ONLINE",
          connectionState: "never_seen",
        },
      ],
    },
  });
  assert.equal(v.element("fleetKnown").textContent, "2");
  assert.equal(v.element("fleetReady").textContent, "1");
  assert.equal(v.element("fleetAttention").textContent, "1");
  assert.match(v.element("fleet-device-1").textContent, /AGENT_NEVER_ONLINE/);
});

test("authenticated Linux systemd receipt displays running service without Windows HMAC assumption", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "elite1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("checkSupervisor").handlers.click();
  v.replyResult(7, {
    structuredContent: {
      service: "agent",
      activeState: "active",
      subState: "running",
      mainPid: 58771,
    },
  });
  v.replyResult(8, { isError: true });
  assert.equal(v.element("fleetAgentState").textContent, "SERVICE RUNNING");
  assert.equal(v.element("fleetGatewayState").textContent, "UNKNOWN");
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
  v.element("checkSupervisor").handlers.click();
  assert.deepEqual(
    v.parentMessages.slice(-2).map(({ message }) => message.id),
    [12, 13],
  );
  v.replyResult(12, {
    structuredContent: {
      service: "agent",
      activeState: "active",
      subState: "running",
      mainPid: 0,
    },
  });
  v.replyResult(13, { isError: true });
  assert.equal(v.element("fleetAgentState").textContent, "UNKNOWN");
});

test("Devices tab checks authenticated account fleet only after a real click", () => {
  const v = openCard();
  v.element("refreshFleet").handlers.click();
  assert.equal(v.parentMessages.length, 1);
  v.handshake();
  v.element("openDevices").handlers.click();
  assert.equal(v.element("panel-devices").hidden, false);
  const req = v.parentMessages.at(-1).message;
  assert.equal(req.method, "tools/call");
  assert.equal(req.params.name, "connection_overview");
  assert.deepEqual({ ...req.params.arguments }, {});
  assert.equal(v.element("fleetReady").textContent, "");
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
        {
          device: "device2",
          project: "project2",
          status: "GATEWAY_REGISTRATION_MISSING",
          connectionState: "offline",
        },
      ],
    },
  });
  assert.equal(v.element("fleetReady").textContent, "1");
  assert.equal(v.element("fleetAttention").textContent, "1");
  assert.equal(v.element("fleetKnown").textContent, "2");
  assert.equal(v.element("fleet-device-1").hidden, false);
});

test("Device pages cover authorized entries beyond 12, without granting a new device", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  const devices = Array.from({ length: 25 }, (_, index) => ({
    device: "device" + index,
    project: "project1",
    status: index === 24 ? "AGENT_OFFLINE" : "READY",
    connectionState: index === 24 ? "offline" : "online",
  }));
  v.replyResult(6, { structuredContent: { devices } });
  assert.equal(v.element("fleetKnown").textContent, "25");
  assert.equal(v.element("fleetReady").textContent, "24");
  assert.equal(
    v.element("fleetPageInfo").textContent,
    "Showing 1–12 of 25 authorized entries",
  );
  assert.equal(v.element("fleetPrev").disabled, true);
  assert.equal(v.element("fleetNext").disabled, false);
  v.element("fleetNext").handlers.click();
  assert.equal(
    v.element("fleetPageInfo").textContent,
    "Showing 13–24 of 25 authorized entries",
  );
  assert.match(v.element("fleet-device-0").textContent, /device12/);
  v.element("fleetNext").handlers.click();
  assert.equal(
    v.element("fleetPageInfo").textContent,
    "Showing 25–25 of 25 authorized entries",
  );
  assert.equal(v.element("fleetNext").disabled, true);
  assert.equal(v.element("fleet-device-1").hidden, true);
  v.element("fleet-device-0").handlers.click();
  assert.match(v.element("fleetSelected").textContent, /device24 \/ project1/);
  v.element("fleetPrev").handlers.click();
  assert.match(v.element("fleetSelected").textContent, /device24 \/ project1/);
  v.element("fleetNext").handlers.click();
  assert.equal(v.element("fleet-device-0").attributes["aria-pressed"], "true");
  v.element("connectDevice").handlers.click();
  const action = v.parentMessages.at(-1).message;
  assert.equal(action.method, "ui/message");
  assert.match(action.params.content.text, /device24 project project1/);
  assert.equal(
    v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
    false,
  );
});

test("Fleet refresh preserves selected grant and page but clamps after device removal", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  const rows = Array.from({ length: 13 }, (_, index) => ({
    device: "d" + index,
    project: "project1",
    status: "READY",
    connectionState: "online",
  }));
  v.replyResult(6, { structuredContent: { devices: rows } });
  v.element("fleetNext").handlers.click();
  v.element("fleet-device-0").handlers.click();
  assert.match(v.element("fleetSelected").textContent, /d12/);
  v.element("refreshFleet").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [...rows].reverse(),
    },
  });
  assert.equal(
    v.element("fleetPageInfo").textContent,
    "Showing 1–12 of 13 authorized entries",
  );
  assert.equal(v.element("fleet-device-0").attributes["aria-pressed"], "true");
  assert.match(v.element("fleetSelected").textContent, /d12/);
  v.element("refreshFleet").handlers.click();
  v.replyResult(6, {
    structuredContent: { devices: rows.slice(0, 5) },
  });
  assert.equal(v.element("fleetPrev").disabled, true);
  assert.equal(v.element("fleetNext").disabled, true);
  assert.equal(
    v.element("fleetPageInfo").textContent,
    "Showing 1–5 of 5 authorized entries",
  );
  assert.match(
    v.element("fleetSelected").textContent,
    /Select an account-authorized device/,
  );
});

test("READY device Connect click verifies exact scope then automatically checks Supervisor", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("connectDevice").handlers.click();
  const req = v.parentMessages.at(-1).message;
  assert.equal(req.method, "tools/call");
  assert.equal(req.params.name, "connection_overview");
  assert.deepEqual(
    { ...req.params.arguments },
    {
      expectedDevice: "device1",
      expectedProject: "project1",
    },
  );
  const before = v.parentMessages.length;
  v.element("connectDevice").handlers.click();
  assert.equal(v.parentMessages.length, before);
  v.replyResult(11, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  assert.match(
    v.element("fleetActionNotice").textContent,
    /fresh scoped account status PASS/,
  );
  assert.deepEqual(
    v.parentMessages.slice(-2).map((item) => item.message.params.name),
    ["supervisor_status", "supervisor_status"],
  );
  assert.equal(
    v.parentMessages.some(({ message }) => message.method === "ui/message"),
    false,
  );
  assert.equal(
    v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
    false,
  );
});

test("READY recheck refuses malformed tools response without crashing or creating service jobs", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("connectDevice").handlers.click();
  v.replyResult(11, { structuredContent: { devices: [null] } });
  assert.match(v.element("fleetActionNotice").textContent, /NOT VERIFIED/);
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_status",
    ),
  );
});

test("READY recheck refuses swapped scope and converts stale offline to guarded repair", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("connectDevice").handlers.click();
  v.replyResult(11, {
    structuredContent: {
      devices: [
        {
          device: "other",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  assert.match(v.element("fleetActionNotice").textContent, /NOT VERIFIED/);
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_status",
    ),
  );
  v.element("connectDevice").handlers.click();
  v.replyResult(11, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "AGENT_OFFLINE",
          connectionState: "offline",
        },
      ],
    },
  });
  assert.match(v.element("fleetActionNotice").textContent, /NOT VERIFIED/);
  v.element("connectDevice").handlers.click();
  const request = v.parentMessages.at(-1).message;
  assert.equal(request.method, "ui/message");
  assert.match(request.params.content.text, /allowlisted/);
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("Connect/Repair is one host-approved click, never an unaudited service restart", () => {
  const v = openCard();
  v.handshake();
  v.send({ product: "KMJ CodeBridge", device: "device1", project: "project1" });
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "AGENT_OFFLINE",
          connectionState: "offline",
        },
      ],
    },
  });
  v.element("connectDevice").handlers.click();
  const req = v.parentMessages.at(-1).message;
  assert.equal(req.method, "ui/message");
  assert.match(req.params.content.text, /connection_overview/);
  assert.match(req.params.content.text, /supervisor_status/);
  assert.match(req.params.content.text, /no active jobs/);
  assert.match(
    req.params.content.text,
    /If already READY, do not restart anything/,
  );
  v.element("connectDevice").handlers.click();
  assert.equal(v.parentMessages.at(-1).message, req);
  v.replyHost(9);
  assert.match(v.element("fleetActionNotice").textContent, /NOT VERIFIED/);
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("Unknown or forged fleet result never authorizes a restart or fake READY", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "../evil",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  assert.equal(v.element("fleetKnown").textContent, "—");
  v.element("connectDevice").handlers.click();
  assert.match(
    v.element("fleetActionNotice").textContent,
    /select an authorized device/,
  );
  assert.ok(
    !v.parentMessages.some(({ message }) => message.method === "ui/message"),
  );
});

test("Read-only Supervisor checks cannot manufacture an active agent or restart rights", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("checkSupervisor").handlers.click();
  const calls = v.parentMessages.slice(-2).map((x) => x.message);
  assert.deepEqual(
    calls.map((x) => x.params.name),
    ["supervisor_status", "supervisor_status"],
  );
  assert.deepEqual(
    calls.map((x) => x.params.arguments.service),
    ["agent", "gateway"],
  );
  v.replyResult(7, {
    structuredContent: {
      service: "agent",
      installed: true,
      supervisor: "windows-native",
      state: "unknown",
      activeProcessRuntime: { verified: false },
      restart: { supported: false },
    },
  });
  v.replyResult(8, { isError: true });
  assert.equal(v.element("fleetAgentState").textContent, "PROCESS UNVERIFIED");
  assert.equal(v.element("fleetGatewayState").textContent, "UNKNOWN");
  assert.match(
    v.element("fleetSupervisorDetail").textContent,
    /independent verified evidence/,
  );
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("READY device cannot start stale Supervisor read while scoped connection recheck is pending", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("connectDevice").handlers.click();
  const count = v.parentMessages.length;
  v.element("checkSupervisor").handlers.click();
  assert.equal(v.parentMessages.length, count);
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_status",
    ),
  );
  v.replyResult(11, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  assert.deepEqual(
    v.parentMessages.slice(-2).map(({ message }) => message.params.name),
    ["supervisor_status", "supervisor_status"],
  );
});

test("duplicate and late Supervisor RPC replies cannot complete a different service or round", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("checkSupervisor").handlers.click();
  v.replyHost(7, "SUPERVISOR_UNAVAILABLE");
  v.replyHost(7, "SUPERVISOR_SERVICE_NOT_ALLOWED");
  assert.equal(v.element("fleetAgentState").textContent, "SETUP REQUIRED");
  assert.equal(v.element("fleetGatewayState").textContent, "CHECKING");
  v.replyHost(8, "SUPERVISOR_SERVICE_NOT_ALLOWED");
  assert.equal(v.element("fleetGatewayState").textContent, "NOT SUPPORTED");

  v.element("checkSupervisor").handlers.click();
  assert.deepEqual(
    v.parentMessages.slice(-2).map(({ message }) => message.id),
    [12, 13],
  );
  v.replyHost(7, "SUPERVISOR_SERVICE_NOT_ALLOWED"); // stale previous round
  v.replyHost(8, "SUPERVISOR_UNAVAILABLE");
  assert.equal(v.element("fleetAgentState").textContent, "CHECKING");
  assert.equal(v.element("fleetGatewayState").textContent, "CHECKING");
  v.replyHost(12, "SUPERVISOR_UNAVAILABLE");
  assert.equal(v.element("fleetGatewayState").textContent, "CHECKING");
  v.replyHost(13, "SUPERVISOR_SERVICE_NOT_ALLOWED");
  assert.equal(v.element("fleetAgentState").textContent, "SETUP REQUIRED");
  assert.equal(v.element("fleetGatewayState").textContent, "NOT SUPPORTED");
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("Supervisor unavailable and unsupported platform are distinct, safe statuses", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("checkSupervisor").handlers.click();
  v.replyHost(7, "SUPERVISOR_UNAVAILABLE");
  v.replyHost(8, "SUPERVISOR_SERVICE_NOT_ALLOWED");
  assert.equal(v.element("fleetAgentState").textContent, "SETUP REQUIRED");
  assert.equal(v.element("fleetGatewayState").textContent, "NOT SUPPORTED");
  assert.match(
    v.element("fleetSupervisorDetail").textContent,
    /approved, signed host-side setup/,
  );
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("Unsupported Windows gateway is labeled without inventing healthy process identity", () => {
  const v = openCard();
  v.handshake();
  v.element("openDevices").handlers.click();
  v.replyResult(6, {
    structuredContent: {
      devices: [
        {
          device: "device1",
          project: "project1",
          status: "READY",
          connectionState: "online",
        },
      ],
    },
  });
  v.element("fleet-device-0").handlers.click();
  v.element("checkSupervisor").handlers.click();
  v.replyResult(7, {
    structuredContent: {
      service: "agent",
      platform: "win32",
      supervisor: "windows-native",
      installed: true,
      state: "unknown",
      activeProcessRuntime: {
        verified: false,
        reason: "PROCESS_IDENTITY_NOT_CORRELATED",
      },
      restart: { supported: false },
    },
  });
  v.replyResult(8, {
    isError: true,
    content: [{ type: "text", text: "SUPERVISOR_SERVICE_NOT_ALLOWED" }],
  });
  assert.equal(v.element("fleetAgentState").textContent, "PROCESS UNVERIFIED");
  assert.equal(v.element("fleetGatewayState").textContent, "NOT SUPPORTED");
  assert.match(
    v.element("fleetSupervisorDetail").textContent,
    /does not expose a gateway Supervisor/,
  );
  assert.ok(
    !v.parentMessages.some(
      ({ message }) => message.params?.name === "supervisor_restart",
    ),
  );
});

test("Pairing remains official domain-owner approval and never starts untrusted installer", () => {
  const v = openCard();
  v.handshake();
  v.element("beginPairing").handlers.click();
  const req = v.parentMessages.at(-1).message;
  assert.equal(req.method, "ui/message");
  assert.match(
    req.params.content.text,
    /kmjtechno.com owner-authorized HTTPS browser approval/,
  );
  assert.match(req.params.content.text, /No GitHub login/);
  v.replyHost(10, "denied");
  assert.match(v.element("fleetActionNotice").textContent, /denied or failed/);
});

test("worker handles are distinct from running jobs and disappear on scope refresh", () => {
  const view = openCard();
  const kinds = ["gate", "repair", "githubCiWatch", "localDraft", "coding"];
  view.send({
    product: "KMJ CodeBridge",
    project: "project1",
    workers: {
      source: "AUTHORIZED_AGENT_WORKER_HANDLES",
      status: "AVAILABLE",
      items: kinds.map((kind, index) => ({
        kind,
        configured: index === 0,
        loopStarted: index === 0,
      })),
    },
  });
  assert.equal(view.element("worker-0").hidden, false);
  assert.equal(view.element("worker-state-0").textContent, "Handle started");
  assert.match(view.element("workerNotice").textContent, /not verified/);
  view.send({ product: "KMJ CodeBridge", project: "project2" });
  assert.equal(view.element("worker-0").hidden, true);
});
