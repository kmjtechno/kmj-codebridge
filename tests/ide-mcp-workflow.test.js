import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-ide-mcp-"));
  const root = path.join(base, "repo");
  const stateDir = path.join(base, "agent-state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "KMJ QA");
  git("config", "user.email", "qa@example.invalid");
  fs.writeFileSync(path.join(root, "README.md"), "calibration project");
  git("add", "README.md");
  git("commit", "-qm", "pinned baseline");
  const head = git("rev-parse", "HEAD");
  const originalUserFile = path.join(root, "untracked-owner-notes.txt");
  fs.writeFileSync(originalUserFile, "PRESERVE");
  const runner = new JobRunner(path.join(stateDir, "jobs"));
  const config = {
    id: "homeoffice-test",
    stateDir,
    projects: [{
      id: "kmj-calibration-pro",
      root,
      writable: true,
      gates: {},
      commands: {
        calibration_v4_qa: {
          category: "build",
          command: process.execPath,
          variants: {
            full: {
              args: ["-e", "console.log('CTEST_Debug=PASS'); console.log('CTEST_Release=PASS'); console.log('token=private-do-not-expose')"],
              timeoutMs: 5000,
            },
          },
        },
      },
    }],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 4 });
  });
  return {
    dispatch, head, originalUserFile,
    scope: { device: "homeoffice-test", project: "kmj-calibration-pro" },
    grants: ["read", "execute"],
  };
}

test("one IDE call launches approved Calibration Pro in detached head and returns compact proof", async (t) => {
  const x = fixture(t);
  const args = {
    ...x.scope,
    command: "calibration_v4_qa",
    variant: "full",
    requestKey: "ide-test-full",
    waitMs: 10000,
  };
  const receipt = await x.dispatch("ide_run_project_task", args, x.grants);
  assert.equal(receipt.executionSucceeded, true);
  assert.deepEqual(receipt.markers.map((item) => item.key), [
    "CTEST_Debug", "CTEST_Release",
  ]);
  assert.equal(receipt.approvalOrDeploymentProven, false);
  assert.equal(receipt.terminal, true);
  assert.ok(!JSON.stringify(receipt).includes("private-do-not-expose"));
  assert.equal(fs.readFileSync(x.originalUserFile, "utf8"), "PRESERVE");

  const again = await x.dispatch("ide_run_project_task", args, x.grants);
  assert.equal(again.job, receipt.job); // idempotent, never relaunches
  const followUp = await x.dispatch("ide_job_receipt", {
    ...x.scope, job: receipt.job, waitMs: 0,
  }, x.grants);
  assert.equal(followUp.job, receipt.job);
  assert.equal(followUp.executionSucceeded, true);
});

test("IDE command blocks arbitrary shell, unapproved profile and wrong device", async (t) => {
  const x = fixture(t);
  const request = {
    ...x.scope, command: "calibration_v4_qa", variant: "full",
    requestKey: "attempt2",
  };
  await assert.rejects(
    x.dispatch("ide_run_project_task", { ...request, shell: "powershell.exe" }, x.grants),
    /unrecognized_keys|Unrecognized key|unknown key|Invalid key/i,
  );
  await assert.rejects(
    x.dispatch("ide_run_project_task", { ...request, command: "powershell" }, x.grants),
    /IDE_COMMAND_NOT_CONFIGURED/,
  );
  await assert.rejects(
    x.dispatch("ide_run_project_task", { ...request, device: "another" }, x.grants),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    x.dispatch("ide_run_project_task", request, ["execute"]),
    /ACCESS_DENIED/,
  );
});
