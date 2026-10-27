import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutopilotJournal } from "../src/autopilot.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function setup(t, projectId = "p1", deviceId = "d1") {
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
    id: deviceId,
    stateDir: state,
    projects: [{ id: projectId, root, writable: true, gates: {} }],
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

test("Main Platform staging status/execute are exact device and project scoped", async (t) => {
  const { dispatch, calls } = setup(t, "kmj-main-platform", "kmj-elite-main-platform");
  const scope = { device: "kmj-elite-main-platform", project: "kmj-main-platform" };
  const approvedSha = "a".repeat(40);
  const expectedCurrentSha = "b".repeat(40);
  const permitted = {
    ...scope, approvedSha, expectedCurrentSha,
    confirmation: "DEPLOY_APPROVED_STAGING_RELEASE",
  };
  await dispatch("supervisor_main_platform_staging_status", scope, ["read"]);
  assert.deepEqual(calls, [{ op: "main_platform_staging_status" }]);
  await assert.rejects(
    dispatch("supervisor_main_platform_staging_deploy", permitted, ["read", "write"]),
    /ACCESS_DENIED/,
  );
  await dispatch("supervisor_main_platform_staging_deploy", permitted, ["execute"]);
  assert.deepEqual(calls[1], {
    op: "main_platform_staging_deploy", approvedSha, expectedCurrentSha,
    confirmation: "DEPLOY_APPROVED_STAGING_RELEASE",
  });
  for (const change of [
    { approvedSha: "main" }, { expectedCurrentSha: "../stage" },
    { confirmation: "YES" }, { command: "/bin/bash" },
    { path: "/root/secrets" },
  ]) await assert.rejects(
    dispatch("supervisor_main_platform_staging_deploy", { ...permitted, ...change }, ["execute"]),
  );
  assert.equal(calls.length, 2);
  const bad = setup(t, "kmj-main-platform", "untrusted-device");
  await assert.rejects(
    bad.dispatch("supervisor_main_platform_staging_status", {
      device: "untrusted-device", project: "kmj-main-platform",
    }, ["read"]), /ACCESS_DENIED/,
  );
  assert.deepEqual(bad.calls, []);
});

test("production release inventory is read-only, activation is execute and project scoped", async (t) => {
  const { dispatch, calls } = setup(t, "kmj-main-platform");
  const prodScope = { device: "d1", project: "kmj-main-platform" };
  const valid = {
    ...prodScope,
    approvedSha: "a".repeat(40),
    expectedCurrentRelease: "commerce-3315f2a-20261009",
    confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE",
  };
  await dispatch("supervisor_main_platform_production_status", prodScope, [
    "read",
  ]);
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
    dispatch(
      "supervisor_main_platform_production_activate",
      {
        ...valid,
        project: "other",
      },
      ["execute"],
    ),
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

test("guarded development status is restricted to enrolled Main Platform device", async (t) => {
  const { dispatch, calls } = setup(
    t,
    "kmj-main-platform",
    "kmj-elite-main-platform",
  );
  const scope = {
    device: "kmj-elite-main-platform",
    project: "kmj-main-platform",
  };
  await dispatch("supervisor_development_privilege_status", scope, ["read"]);
  assert.deepEqual(calls, [{ op: "development_privilege_status" }]);
  await assert.rejects(
    dispatch(
      "supervisor_development_privilege_status",
      { ...scope, project: "other" },
      ["read"],
    ),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch(
      "supervisor_development_privilege_status",
      { ...scope, command: "/bin/sh" },
      ["read"],
    ),
  );
  assert.equal(calls.length, 1);
});

test("guarded development status denies ordinary device despite matching project", async (t) => {
  const { dispatch, calls } = setup(t, "kmj-main-platform");
  await assert.rejects(
    dispatch(
      "supervisor_development_privilege_status",
      { device: "d1", project: "kmj-main-platform" },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  assert.deepEqual(calls, []);
});

test("development broker start requires explicit execution permission and exact scope", async (t) => {
  const { dispatch, calls } = setup(
    t,
    "kmj-main-platform",
    "kmj-elite-main-platform",
  );
  const args = {
    device: "kmj-elite-main-platform",
    project: "kmj-main-platform",
    confirmation: "START_PINNED_NONROOT_DEV_PROBE",
  };
  await assert.rejects(
    dispatch("supervisor_development_ci_start", args, ["read"]),
    /ACCESS_DENIED/,
  );
  await dispatch("supervisor_development_ci_start", args, ["execute"]);
  assert.deepEqual(calls, [
    {
      op: "development_ci_start",
      confirmation: "START_PINNED_NONROOT_DEV_PROBE",
    },
  ]);
  await assert.rejects(
    dispatch("supervisor_development_ci_start", { ...args, command: "sudo" }, [
      "execute",
    ]),
  );
  assert.equal(calls.length, 1);
});

test("development broker risk catalog requires privileged approval", async (t) => {
  const { dispatch } = setup(t, "kmj-main-platform", "kmj-elite-main-platform");
  const catalog = await dispatch(
    "policy_catalog",
    {
      device: "kmj-elite-main-platform",
      project: "kmj-main-platform",
    },
    ["read"],
  );
  const item = catalog.tools.find(
    (tool) => tool.tool === "supervisor_development_ci_start",
  );
  assert.equal(item?.risk, "PRIVILEGED");
  assert.equal(item?.approvalRequired, true);
});

test("development broker refuses same project on the wrong device", async (t) => {
  const { dispatch, calls } = setup(t, "kmj-main-platform");
  await assert.rejects(
    dispatch(
      "supervisor_development_ci_start",
      {
        device: "d1",
        project: "kmj-main-platform",
        confirmation: "START_PINNED_NONROOT_DEV_PROBE",
      },
      ["execute"],
    ),
    /ACCESS_DENIED/,
  );
  assert.deepEqual(calls, []);
});
