import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function setup(t) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "cb-supervisor-dispatch-"),
  );
  const root = path.join(base, "project");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const runner = new JobRunner(path.join(state, "jobs"));
  const autopilot = new AutopilotJournal(path.join(state, "autopilot"));
  const calls = [];
  const supervisor = {
    request: async (request) => {
      calls.push(request);
      return { ok: true, ...request };
    },
  };
  const config = {
    id: "d1",
    stateDir: state,
    projects: [{ id: "p1", root, writable: true, gates: {} }],
  };
  const licenseProvider = () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  });
  const dispatch = createDispatcher(
    config,
    runner,
    licenseProvider,
    autopilot,
    supervisor,
  );
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { dispatch, calls };
}

const scope = { device: "d1", project: "p1" };

test("supervisor status and logs use read permission", async (t) => {
  const { dispatch, calls } = setup(t);
  await dispatch("supervisor_status", { ...scope, service: "agent" }, ["read"]);
  await dispatch(
    "supervisor_logs",
    { ...scope, service: "gateway", lines: 25 },
    ["read"],
  );
  assert.deepEqual(calls, [
    { op: "status", service: "agent" },
    { op: "logs", service: "gateway", lines: 25 },
  ]);
});

test("supervisor restart requires execute permission", async (t) => {
  const { dispatch, calls } = setup(t);
  await assert.rejects(
    dispatch("supervisor_restart", { ...scope, service: "agent" }, [
      "read",
      "write",
    ]),
    /ACCESS_DENIED/,
  );
  await dispatch("supervisor_restart", { ...scope, service: "agent" }, [
    "execute",
  ]);
  assert.deepEqual(calls, [{ op: "restart", service: "agent" }]);
});

test("supervisor operations fail closed when local supervisor is absent", async (t) => {
  const { dispatch } = setup(t);
  const noSupervisor = createDispatcher(
    {
      id: "d1",
      stateDir: "/tmp/state",
      projects: [
        {
          id: "p1",
          root: fs.mkdtempSync(path.join(os.tmpdir(), "cb-nosup-")),
          writable: true,
          gates: {},
        },
      ],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  await assert.rejects(
    noSupervisor("supervisor_status", { ...scope, service: "agent" }, ["read"]),
    /SUPERVISOR_UNAVAILABLE/,
  );
  assert.equal(typeof dispatch, "function");
});
