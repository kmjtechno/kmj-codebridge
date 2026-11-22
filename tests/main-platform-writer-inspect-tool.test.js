import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";
const CONFIRM = "RUN_FIXED_READONLY_WRITER_IDENTITY_INSPECT";

function fixture(
  t,
  {
    device = DEVICE,
    project = PROJECT,
    hasSupervisor = true,
    payload = null,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-writer-tool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const calls = [];
  const supervisor = hasSupervisor
    ? {
        request: async (input) => {
          calls.push(input);
          return {
            response: payload ?? {
              mode: "READ_ONLY_FIXED_DIAGNOSTIC",
              scope: PROJECT,
              diagnostic: {
                status: "READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
                productionPoolWorkers: 3,
                activationRequestCreated: false,
                brokerStarted: false,
                activationApproved: false,
                productionReleaseVerified: false,
                productionMutation: "NONE",
              },
              rootBrokerInstalled: false,
              releaseApprovalGranted: false,
              productionMutation: "NONE",
              rawProcessDataExposed: false,
            },
          };
        },
      }
    : null;
  const dispatch = createDispatcher(
    {
      id: device,
      stateDir,
      projects: [
        { id: project, root, writable: true, gates: {}, commands: {} },
      ],
    },
    { maxConcurrent: 1, run: () => assert.fail("NO_PROJECT_JOB") },
    () => ({
      features: ["read", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    supervisor,
  );
  return { dispatch, calls, device, project };
}

test("new fixed inspector only sends a scoped, no-command supervisor request", async (t) => {
  const f = fixture(t);
  const result = await f.dispatch(
    "supervisor_main_platform_writer_identity_inspect",
    { device: DEVICE, project: PROJECT, confirmation: CONFIRM },
    ["execute"],
  );
  assert.deepEqual(f.calls, [
    {
      op: "main_platform_writer_identity_inspect",
      confirmation: CONFIRM,
    },
  ]);
  assert.equal(result.response.diagnostic.productionPoolWorkers, 3);
  assert.equal(result.response.releaseApprovalGranted, false);
});

test("new inspector cannot be invoked by read-only grant or caller path/args", async (t) => {
  const f = fixture(t);
  const original = { device: DEVICE, project: PROJECT, confirmation: CONFIRM };
  await assert.rejects(
    f.dispatch("supervisor_main_platform_writer_identity_inspect", original, [
      "read",
    ]),
  );
  for (const input of [
    { ...original, confirmation: "yes" },
    { ...original, path: "/root/.ssh" },
    { ...original, cmd: "bash" },
    { ...original, env: { PHP_INI_SCAN_DIR: "/tmp" } },
    { ...original, argv: ["--apply"] },
    { ...original, port: 22 },
  ]) {
    await assert.rejects(
      f.dispatch("supervisor_main_platform_writer_identity_inspect", input, [
        "execute",
      ]),
    );
  }
  assert.equal(f.calls.length, 0);
});

test("new inspector rejects other device, project and missing supervisor", async (t) => {
  for (const options of [
    { device: "google-vps1" },
    { device: "kmj-codebridge-elite" },
    { project: "kmj-cloudos" },
    { hasSupervisor: false },
  ]) {
    const f = fixture(t, options);
    await assert.rejects(
      f.dispatch(
        "supervisor_main_platform_writer_identity_inspect",
        {
          device: f.device,
          project: f.project,
          confirmation: CONFIRM,
        },
        ["execute"],
      ),
    );
    assert.equal(f.calls.length, 0);
  }
});

test("captured legacy client advertises one fixed inspect variant and safely executes", async (t) => {
  const f = fixture(t);
  const list = await f.dispatch(
    "list_project_commands",
    { device: DEVICE, project: PROJECT },
    ["read"],
  );
  const profile = list.commands.find(
    (command) => command.id === "main_platform_writer_identity_inspect",
  );
  assert.ok(profile);
  assert.equal(profile.category, "inspect");
  assert.equal(profile.approvalRequired, true);
  assert.deepEqual(profile.variants, [CONFIRM]);
  const result = await f.dispatch(
    "run_project_command",
    {
      device: DEVICE,
      project: PROJECT,
      command: "main_platform_writer_identity_inspect",
      variant: CONFIRM,
      requestKey: "fixed-writer-inspect-legacy-check",
    },
    ["execute"],
  );
  assert.deepEqual(f.calls, [
    {
      op: "main_platform_writer_identity_inspect",
      confirmation: CONFIRM,
    },
  ]);
  assert.deepEqual(result, {
    command: "main_platform_writer_identity_inspect",
    status: "READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
    productionPoolWorkers: 3,
    source: "FIXED_SHA_PINNED_SUPERVISOR",
    rootBrokerInstalled: false,
    releaseApprovalGranted: false,
    productionReleaseVerified: false,
    productionMutation: "NONE",
  });
});

test("captured legacy client rejects wrong variant, extra lanes and read-only grants", async (t) => {
  const f = fixture(t);
  const request = {
    device: DEVICE,
    project: PROJECT,
    command: "main_platform_writer_identity_inspect",
    variant: CONFIRM,
    requestKey: "fixed-writer-inspect-legacy-negative",
  };
  for (const extra of [
    { variant: "overview" },
    { variant: "RUN_FIXED_READONLY_WRITER_IDENTITY_INSPECT " },
    { variant: "start" },
    { expectedHead: "a".repeat(40) },
    { laneId: "anything" },
  ]) {
    await assert.rejects(
      f.dispatch("run_project_command", { ...request, ...extra }, ["execute"]),
    );
  }
  await assert.rejects(f.dispatch("run_project_command", request, ["read"]));
  assert.equal(f.calls.length, 0);
});

test("captured legacy client rejects wrong host/project and forged approval evidence", async (t) => {
  const request = {
    device: DEVICE,
    project: PROJECT,
    command: "main_platform_writer_identity_inspect",
    variant: CONFIRM,
    requestKey: "fixed-writer-inspect-mock-response",
  };
  for (const options of [
    { device: "google-vps1" },
    { project: "kmj-cloudos" },
    { hasSupervisor: false },
  ]) {
    const f = fixture(t, options);
    await assert.rejects(
      f.dispatch(
        "run_project_command",
        {
          ...request,
          device: f.device,
          project: f.project,
        },
        ["execute"],
      ),
    );
    assert.equal(f.calls.length, 0);
  }
  const valid = {
    mode: "READ_ONLY_FIXED_DIAGNOSTIC",
    scope: PROJECT,
    diagnostic: {
      status: "READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
      productionPoolWorkers: 3,
      activationRequestCreated: false,
      brokerStarted: false,
      activationApproved: false,
      productionReleaseVerified: false,
      productionMutation: "NONE",
    },
    rootBrokerInstalled: false,
    releaseApprovalGranted: false,
    productionMutation: "NONE",
    rawProcessDataExposed: false,
  };
  for (const forged of [
    { productionMutation: "SOME" },
    { rootBrokerInstalled: true },
    { releaseApprovalGranted: true },
    { rawProcessDataExposed: true },
    { scope: "kmj-cloudos" },
    { diagnostic: { ...valid.diagnostic, activationApproved: true } },
    { diagnostic: { ...valid.diagnostic, brokerStarted: true } },
    { diagnostic: { ...valid.diagnostic, productionPoolWorkers: 0 } },
    { diagnostic: { ...valid.diagnostic, productionPoolWorkers: 1025 } },
  ]) {
    const f = fixture(t, { payload: { ...valid, ...forged } });
    await assert.rejects(
      f.dispatch("run_project_command", request, ["execute"]),
      /MAIN_PLATFORM_WRITER_INSPECT_UNVERIFIED/,
    );
  }
});
