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

test("device resource status uses the local supervisor", async (t) => {
  const { dispatch, calls } = setup(t);
  await dispatch("supervisor_device_status", scope, ["read"]);
  assert.deepEqual(calls, [{ op: "device_status" }]);
});

test("managed project status uses the already-authorized project scope", async (t) => {
  const { dispatch, calls } = setup(t);
  await dispatch("supervisor_project_status", scope, ["read"]);
  assert.deepEqual(calls, [{ op: "project_status", projectId: "p1" }]);
  const unauthorizedScope = { device: "d1", project: "p2" };
  await assert.rejects(
    dispatch("supervisor_project_status", unauthorizedScope, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  assert.deepEqual(calls, [{ op: "project_status", projectId: "p1" }]);
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

test("auto-update supervisor tools preserve read versus execute permissions", async (t) => {
  const { dispatch, calls } = setup(t);
  await dispatch("supervisor_update_status", scope, ["read"]);
  await assert.rejects(
    dispatch("supervisor_update_now", scope, ["read", "write"]),
    /ACCESS_DENIED/,
  );
  await dispatch("supervisor_update_now", scope, ["execute"]);
  assert.deepEqual(calls, [{ op: "update_status" }, { op: "update_now" }]);
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

test("production release inventory is read-only, activation is execute and project scoped", async (t) => {
  const { dispatch, calls } = setup(t);
  const valid = {
    ...scope,
    approvedSha: "a".repeat(40),
    expectedCurrentRelease: "commerce-3315f2a-20261009",
    confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE",
  };
  await dispatch("supervisor_main_platform_production_status", scope, ["read"]);
  assert.deepEqual(calls, [{ op: "main_platform_production_status" }]);
  await assert.rejects(
    dispatch("supervisor_main_platform_production_activate", valid, ["read"]),
    /ACCESS_DENIED/,
  );
  await dispatch("supervisor_main_platform_production_activate", valid, [
    "execute",
  ]);
  assert.deepEqual(calls.at(-1), {
    op: "main_platform_production_activate",
    approvedSha: "a".repeat(40),
    expectedCurrentRelease: "commerce-3315f2a-20261009",
    confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE",
  });
  await assert.rejects(
    dispatch("supervisor_main_platform_production_activate", {
      ...valid,
      project: "other",
    }, ["execute"]),
    /PROJECT_NOT_FOUND/,
  );
  assert.equal(calls.length, 2);
});

test("production release tool rejects caller-chosen shell, path and invalid SHA", async (t) => {
  const { dispatch, calls } = setup(t);
  const input = {
    ...scope,
    approvedSha: "b".repeat(40),
    expectedCurrentRelease: "commerce-3315f2a-20261009",
    confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE",
  };
  for (const malicious of [
    { ...input, command: "/bin/bash" },
    { ...input, path: "/root/.ssh" },
    { ...input, approvedSha: "main" },
    { ...input, expectedCurrentRelease: "../current" },
    { ...input, confirmation: "yes" },
  ]) {
    await assert.rejects(
      dispatch("supervisor_main_platform_production_activate", malicious, [
        "execute",
      ]),
    );
  }
  assert.deepEqual(calls, []);
});
