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
  { device = DEVICE, project = PROJECT, hasSupervisor = true } = {},
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
            response: {
              mode: "READ_ONLY_FIXED_DIAGNOSTIC",
              scope: PROJECT,
              diagnostic: {
                status: "READY_FOR_OWNER_REVIEW_NOT_INSTALLED",
                productionPoolWorkers: 3,
                rootBrokerInstalled: false,
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
