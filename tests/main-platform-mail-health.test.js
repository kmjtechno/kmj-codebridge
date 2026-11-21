import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateEliteMailHealth } from "../src/main-platform-mail-health.js";
import { createSupervisorHandler } from "../src/supervisor.js";
import { createDispatcher } from "../src/tools.js";

const NOW = 1800000000000;
const el = (
  ageHours,
  reasons = ["525 5.7.1 unauthorized ip: PRIVATE@example.test"],
) =>
  JSON.stringify({
    queue_id: "DO-NOT-LEAK-PRIVATE-ID",
    sender: "PRIVATE@example.test",
    arrival_time: NOW / 1000 - 3600 * ageHours,
    queue_name: "deferred",
    recipients: reasons.map((delay_reason) => ({
      address: "victim@example.test",
      delay_reason,
    })),
  }) + "\n";
const base = (queueJsonl = "") => ({
  queueJsonl,
  lifetime: "5d\n",
  relayhost: "\n",
  fallback: "[smtp-relay.brevo.com]:587\n",
  postfixState: "ActiveState=active\n",
  opendkimState: "ActiveState=active\n",
});

test("empty queue remains NOT a recipient delivery receipt", () => {
  const a = aggregateEliteMailHealth(base(), NOW);
  assert.equal(a.queueMessages, 0);
  assert.equal(a.queueDrained, true);
  assert.equal(a.recipientDeliveryProven, false);
  assert.equal(a.maximalQueueLifetimeHours, 120);
  assert.equal(a.directMxPrimaryConfigured, true);
  assert.equal(a.brevoFallbackConfigured, true);
  assert.equal(a.postfixActive, true);
  assert.equal(a.opendkimActive, true);
  assert.equal(a.queueMutation, "NONE");
});

test("stale 525 errors are categorical and old queue count never means delivered", () => {
  const a = aggregateEliteMailHealth(
    base(
      el(137, [
        "525 5.7.1 unauthorized IP PRIVATE@example.test",
        "535 SASL failed victim@example.test",
      ]) + el(4, ["timeout"]),
    ),
    NOW,
  );
  assert.equal(a.queueMessages, 2);
  assert.equal(a.queueRecipients, 3);
  assert.deepEqual(a.lastRecordedDelayCategories, {
    SMTP_525: 1,
    SMTP_535: 1,
    TIMEOUT: 1,
  });
  assert.equal(a.queueAgeBuckets.AT_OR_OVER_LIFETIME, 1);
  assert.equal(a.queueAgeBuckets.BELOW_WARNING_WINDOW, 1);
  assert.equal(a.oldestHours, 137);
  assert.equal(a.recipientDeliveryProven, false);
  assert.doesNotMatch(
    JSON.stringify(a),
    /PRIVATE|victim|DO-NOT-LEAK|unauthorized IP/,
  );
});

test("unknown lifetime or absent routing data cannot claim known, safe mail health", () => {
  const a = aggregateEliteMailHealth(
    {
      ...base(el(24, [])),
      lifetime: "unknown",
      relayhost: undefined,
      fallback: "[not-brevo]:587",
      postfixState: "ActiveState=inactive",
    },
    NOW,
  );
  assert.equal(a.maximalQueueLifetimeHours, null);
  assert.equal(a.queueAgeBuckets.THRESHOLD_UNKNOWN, 1);
  assert.equal(a.opendkimActive, true);
  assert.equal(a.postfixActive, false);
  assert.equal(a.directMxPrimaryConfigured, false);
  assert.equal(a.brevoFallbackConfigured, false);
});

test("malformed and oversized queue input fail closed without revealing content", () => {
  for (const input of [
    "{secret PRIVATE@example.test\n",
    "[]\n",
    JSON.stringify({ queue_name: "deferred", recipients: "broken" }) + "\n",
    JSON.stringify({ queue_name: "deferred", recipients: ["bad"] }) + "\n",
    "x".repeat(262145),
  ]) {
    assert.throws(() => aggregateEliteMailHealth(base(input), NOW));
  }
});

test("future or missing arrival times do not get classified as fresh", () => {
  const q =
    JSON.stringify({
      arrival_time: NOW / 1000 + 3000,
      queue_name: "deferred",
      recipients: [],
    }) + "\n";
  const a = aggregateEliteMailHealth(base(q), NOW);
  assert.equal(a.unknownAgeMessages, 1);
  assert.deepEqual(a.queueAgeBuckets, {});
});

test("fixed root Supervisor operation exposes only aggregate result, fixed executables and no mutations", async () => {
  const calls = [];
  const outputs = new Map([
    ["/usr/sbin/postqueue -j", el(120)],
    ["/usr/sbin/postconf -h maximal_queue_lifetime", "5d\n"],
    ["/usr/sbin/postconf -h relayhost", "\n"],
    [
      "/usr/sbin/postconf -h smtp_fallback_relay",
      "[smtp-relay.brevo.com]:587\n",
    ],
    [
      "/usr/bin/systemctl show postfix.service --property=ActiveState --no-pager",
      "ActiveState=active\n",
    ],
    [
      "/usr/bin/systemctl show opendkim.service --property=ActiveState --no-pager",
      "ActiveState=active\n",
    ],
  ]);
  const handle = createSupervisorHandler({
    run(command, args, opts) {
      calls.push([command, ...args]);
      assert.equal(opts.timeout, 5000);
      assert.ok(opts.maxBuffer <= 262144);
      const key = [command, ...args].join(" ");
      assert.ok(outputs.has(key));
      return outputs.get(key);
    },
    start() {
      throw Error("MUTATION ATTEMPT");
    },
    restart() {
      throw Error("MUTATION ATTEMPT");
    },
  });
  const result = await handle({ op: "main_platform_mail_health" });
  assert.equal(result.response.inspection, "PASS");
  assert.equal(result.response.queueMessages, 1);
  assert.equal(result.response.lastRecordedDelayCategories.SMTP_525, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|victim|DO-NOT-LEAK/);
  assert.equal(calls.length, 6);
  for (const key of [
    "path",
    "argv",
    "target",
    "shell",
    "confirmation",
    "command",
  ]) {
    await assert.rejects(
      handle({ op: "main_platform_mail_health", [key]: "evil" }),
    );
  }
  assert.equal(calls.length, 6);
});

test("root Supervisor fails closed on postqueue error and never emits stderr", async () => {
  const handle = createSupervisorHandler({
    run() {
      throw Error("PRIVATE SMTP password, secret queue message");
    },
  });
  const { response } = await handle({ op: "main_platform_mail_health" });
  assert.equal(response.inspection, "UNAVAILABLE");
  assert.equal(response.queueDrained, null);
  assert.equal(response.recipientDeliveryProven, false);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|password|secret/);
});

function fixture(
  t,
  {
    device = "kmj-elite-main-platform",
    project = "kmj-main-platform",
    writable = true,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-mail-health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const calls = [];
  const provider = {
    request: async (request) => {
      calls.push(request);
      return {
        response: {
          ...aggregateEliteMailHealth(base(el(2)), NOW),
          secret: "PRIVATE-SECRET",
          queueStates: { deferred: 1, "victim@example.test": 99 },
        },
      };
    },
  };
  const dispatcher = createDispatcher(
    {
      id: device,
      stateDir,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    {
      maxConcurrent: 1,
      run() {
        throw Error("NO EXEC");
      },
    },
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    provider,
  );
  return { dispatcher, calls };
}

test("MCP response is allowlisted a second time; only Elite writable project authorized", async (t) => {
  const f = fixture(t);
  const got = await f.dispatcher(
    "supervisor_main_platform_mail_health",
    {
      device: "kmj-elite-main-platform",
      project: "kmj-main-platform",
    },
    ["read"],
  );
  assert.equal(got.response.queueMessages, 1);
  assert.equal(got.response.queueStates.deferred, 1);
  assert.equal(got.response.queueStates["victim@example.test"], undefined);
  assert.equal(got.response.recipientDeliveryProven, false);
  assert.deepEqual(f.calls, [{ op: "main_platform_mail_health" }]);
  assert.doesNotMatch(
    JSON.stringify(got),
    /PRIVATE-SECRET|victim@example.test/,
  );
  for (const props of [{ path: "/root" }, { command: "bash" }]) {
    await assert.rejects(
      f.dispatcher(
        "supervisor_main_platform_mail_health",
        {
          device: "kmj-elite-main-platform",
          project: "kmj-main-platform",
          ...props,
        },
        ["read"],
      ),
    );
  }
});

test("untrusted project, device or readonly registration cannot inspect privileged mail queue", async (t) => {
  for (const x of [
    { device: "other" },
    { project: "other" },
    { writable: false },
  ]) {
    const f = fixture(t, x);
    const device = x.device ?? "kmj-elite-main-platform";
    const project = x.project ?? "kmj-main-platform";
    await assert.rejects(
      f.dispatcher(
        "supervisor_main_platform_mail_health",
        {
          device,
          project,
        },
        ["read"],
      ),
      /ACCESS_DENIED/,
    );
    assert.deepEqual(f.calls, []);
  }
});
