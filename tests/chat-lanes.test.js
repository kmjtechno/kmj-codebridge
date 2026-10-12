import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatLaneRegistry } from "../src/chat-lanes.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

test("distinct chats reserve disjoint files; collisions and traversals fail closed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lanes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1000000;
  const leases = new ChatLaneRegistry(dir, { now: () => clock });
  const a = leases.reserve("project1", "chat-a", ["src/api"], 120);
  const replay = leases.reserve("project1", "chat-a", ["src/api"], 120);
  assert.equal(a.leaseToken, replay.leaseToken);
  assert.equal(replay.reused, true);
  leases.reserve("project1", "chat-b", ["docs/help.md"], 120);
  assert.equal(leases.status("project1").activeCount, 2);
  assert.doesNotMatch(
    JSON.stringify(leases.status("project1")),
    new RegExp(a.leaseToken),
  );
  assert.throws(
    () => leases.reserve("project1", "chat-c", ["src/api/file.ts"], 120),
    /CHAT_LANE_CONFLICT/,
  );
  assert.throws(
    () => leases.reserve("project1", "chat-a", ["src/other"], 120),
    /CHAT_LANE_IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => leases.reserve("project1", "chat-d", ["../outside"], 120),
    /CHAT_LANE_INVALID_PATH/,
  );
  assert.throws(
    () => leases.reserve("project1", "chat-d", [".git/config"], 120),
    /CHAT_LANE_INVALID_PATH/,
  );
  assert.throws(
    () => leases.assertWritable("project1", ["src/api/main.ts"]),
    /CHAT_LANE_CONFLICT/,
  );
  leases.assertWritable("project1", ["src/api/main.ts"], a.leaseToken);
  leases.assertWritable("project1", ["docs/new-help.txt"], undefined);
  leases.assertWritable("unrelated-project", ["src/api/main.ts"], undefined);
  clock += 121000;
  assert.equal(leases.status("project1").activeCount, 0);
  leases.assertWritable("project1", ["src/api/main.ts"], undefined);
});

test("agent enforces reserved file writes across two simultaneous MCP chats", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lane-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const runner = new JobRunner(path.join(root, "jobs"));
  t.after(async () => runner.close());
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(root, "state"),
      projects: [
        {
          id: "project1",
          root: project,
          writable: true,
          gates: {},
          commands: {},
        },
      ],
    },
    runner,
    () => ({ features: ["read", "write"], limits: { concurrent_jobs: 1 } }),
  );
  const scope = { device: "device1", project: "project1" };
  const lease = await dispatch(
    "chat_lane_reserve",
    {
      ...scope,
      requestKey: "chat-1",
      paths: ["a.txt"],
      ttlSeconds: 900,
    },
    ["write"],
  );
  assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    dispatch(
      "write_file",
      {
        ...scope,
        path: "a.txt",
        expectedHash: null,
        content: "one",
      },
      ["write"],
    ),
    /CHAT_LANE_CONFLICT/,
  );
  await dispatch(
    "write_file",
    {
      ...scope,
      path: "a.txt",
      expectedHash: null,
      content: "one",
      leaseToken: lease.leaseToken,
    },
    ["write"],
  );
  await dispatch(
    "write_file",
    {
      ...scope,
      path: "b.txt",
      expectedHash: null,
      content: "two",
    },
    ["write"],
  );
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "one");
  await assert.rejects(
    dispatch("chat_lane_status", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("chat_lane_release", { ...scope, leaseToken: lease.leaseToken }, [
      "read",
    ]),
    /ACCESS_DENIED/,
  );
  const released = await dispatch(
    "chat_lane_release",
    {
      ...scope,
      leaseToken: lease.leaseToken,
    },
    ["write"],
  );
  assert.equal(released.released, true);
  assert.equal(definitions.chat_lane_status.access, "read");
  assert.equal(definitions.chat_lane_reserve.access, "write");
});

test("reservations survive registry construction and block overlapping batch edits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lane-durable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new ChatLaneRegistry(root);
  const lease = first.reserve("p1", "chat-1", ["src"], 3600);
  const restored = new ChatLaneRegistry(root);
  assert.equal(restored.status("p1").activeCount, 1);
  assert.throws(
    () => restored.assertWritable("p1", ["src/a.ts", "docs/a.md"]),
    /CHAT_LANE_CONFLICT/,
  );
  restored.assertWritable("p1", ["src/a.ts"], lease.leaseToken);
  restored.release("p1", lease.leaseToken);
  assert.equal(restored.status("p1").activeCount, 0);
});
