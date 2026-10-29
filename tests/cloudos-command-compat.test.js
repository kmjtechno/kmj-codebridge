import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function fixture(
  t,
  projectId = "kmj-cloudos",
  writable = true,
  hasFullGate = true,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cloudos-qa-"));
  t.after(() =>
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }),
  );
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  git(root, "init", "-q");
  git(root, "config", "user.name", "KMJ Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  for (const name of [
    "KMJ_CloudOS_Phase1_COMPLETE_Release_Gates_v1.2.yaml",
    "KMJ_CloudOS_Phase2_COMPLETE_Release_Gates_v2.0.yaml",
  ])
    fs.writeFileSync(path.join(root, name), "project: test\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(
    path.join(root, "tests", "test_example.py"),
    "def test_example(): assert True\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "approved test root");
  const head = git(root, "rev-parse", "HEAD");
  // Real CloudOS checkout can contain another engineer's uncommitted files.
  fs.writeFileSync(path.join(root, "DO_NOT_TOUCH.txt"), "protected changes\n");
  const jobs = [];
  const runner = {
    maxConcurrent: 1,
    run: (args) => {
      jobs.push(args);
      return { id: "qa-job", state: "queued", gate: args.gate };
    },
  };
  const config = {
    id: "d1",
    stateDir,
    projects: [
      {
        id: projectId,
        root,
        writable,
        gates: hasFullGate
          ? {
              full: {
                command: "python3",
                args: ["-B", "-m", "unittest", "discover", "-s", "tests"],
                timeoutMs: 90000,
              },
            }
          : {},
        commands: {},
      },
    ],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  const input = (extra = {}) => ({
    device: "d1",
    project: projectId,
    command: "cloudos_release_qa",
    variant: "full",
    requestKey: "cloudos-safe-qa-01",
    ...extra,
  });
  return { dispatch, input, jobs, root, head, stateDir };
}

test("fixed CloudOS QA runs only on a clean detached exact-HEAD lane", async (t) => {
  const f = fixture(t);
  const list = await f.dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-cloudos" },
    ["read"],
  );
  assert.equal(list.commands.length, 1);
  assert.equal(list.commands[0].id, "cloudos_release_qa");
  assert.deepEqual(list.commands[0].variants, ["full"]);
  assert.equal(list.commands[0].risk, "TEST");

  const response = await f.dispatch("run_project_command", f.input(), [
    "execute",
  ]);
  assert.equal(response.state, "queued");
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  assert.equal(job.project, "kmj-cloudos");
  assert.equal(job.key, "cloudos-safe-qa-01");
  assert.equal(job.command, "python3");
  assert.deepEqual(job.args, [
    "-B",
    "-m",
    "unittest",
    "discover",
    "-s",
    "tests",
  ]);
  assert.equal(job.timeoutMs, 90000);
  assert.match(
    job.gate,
    new RegExp(`cloudos_qa_${f.head.slice(0, 12)}#${f.head}$`),
  );
  assert.notEqual(job.cwd, f.root);
  assert.equal(git(job.cwd, "rev-parse", "HEAD"), f.head);
  assert.equal(git(job.cwd, "status", "--porcelain"), "");
  assert.equal(job.beforeStart(), job.cwd);
  assert.equal(
    fs.readFileSync(path.join(f.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );
  assert.equal(fs.existsSync(path.join(job.cwd, "DO_NOT_TOUCH.txt")), false);

  fs.writeFileSync(
    path.join(job.cwd, "untrusted-test.py"),
    "raise Exception('unsafe')\n",
  );
  assert.throws(() => job.beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
  assert.equal(
    fs.readFileSync(path.join(f.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );
});

test("explicit matching CloudOS expectedHead is a safe assertion, not a ref override", async (t) => {
  const matched = fixture(t);
  const response = await matched.dispatch(
    "run_project_command",
    matched.input({ expectedHead: matched.head }),
    ["execute"],
  );
  assert.equal(response.state, "queued");
  assert.equal(matched.jobs.length, 1);
  assert.match(matched.jobs[0].gate, new RegExp(`#${matched.head}import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function fixture(
  t,
  projectId = "kmj-cloudos",
  writable = true,
  hasFullGate = true,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cloudos-qa-"));
  t.after(() =>
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }),
  );
  const root = path.join(home, "repo");
  const stateDir = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  git(root, "init", "-q");
  git(root, "config", "user.name", "KMJ Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  for (const name of [
    "KMJ_CloudOS_Phase1_COMPLETE_Release_Gates_v1.2.yaml",
    "KMJ_CloudOS_Phase2_COMPLETE_Release_Gates_v2.0.yaml",
  ])
    fs.writeFileSync(path.join(root, name), "project: test\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(
    path.join(root, "tests", "test_example.py"),
    "def test_example(): assert True\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "approved test root");
  const head = git(root, "rev-parse", "HEAD");
  // Real CloudOS checkout can contain another engineer's uncommitted files.
  fs.writeFileSync(path.join(root, "DO_NOT_TOUCH.txt"), "protected changes\n");
  const jobs = [];
  const runner = {
    maxConcurrent: 1,
    run: (args) => {
      jobs.push(args);
      return { id: "qa-job", state: "queued", gate: args.gate };
    },
  };
  const config = {
    id: "d1",
    stateDir,
    projects: [
      {
        id: projectId,
        root,
        writable,
        gates: hasFullGate
          ? {
              full: {
                command: "python3",
                args: ["-B", "-m", "unittest", "discover", "-s", "tests"],
                timeoutMs: 90000,
              },
            }
          : {},
        commands: {},
      },
    ],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  const input = (extra = {}) => ({
    device: "d1",
    project: projectId,
    command: "cloudos_release_qa",
    variant: "full",
    requestKey: "cloudos-safe-qa-01",
    ...extra,
  });
  return { dispatch, input, jobs, root, head, stateDir };
}

test("fixed CloudOS QA runs only on a clean detached exact-HEAD lane", async (t) => {
  const f = fixture(t);
  const list = await f.dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-cloudos" },
    ["read"],
  );
  assert.equal(list.commands.length, 1);
  assert.equal(list.commands[0].id, "cloudos_release_qa");
  assert.deepEqual(list.commands[0].variants, ["full"]);
  assert.equal(list.commands[0].risk, "TEST");

  const response = await f.dispatch("run_project_command", f.input(), [
    "execute",
  ]);
  assert.equal(response.state, "queued");
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  assert.equal(job.project, "kmj-cloudos");
  assert.equal(job.key, "cloudos-safe-qa-01");
  assert.equal(job.command, "python3");
  assert.deepEqual(job.args, [
    "-B",
    "-m",
    "unittest",
    "discover",
    "-s",
    "tests",
  ]);
  assert.equal(job.timeoutMs, 90000);
  assert.match(
    job.gate,
    new RegExp(`cloudos_qa_${f.head.slice(0, 12)}#${f.head}$`),
  );
  assert.notEqual(job.cwd, f.root);
  assert.equal(git(job.cwd, "rev-parse", "HEAD"), f.head);
  assert.equal(git(job.cwd, "status", "--porcelain"), "");
  assert.equal(job.beforeStart(), job.cwd);
  assert.equal(
    fs.readFileSync(path.join(f.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );
  assert.equal(fs.existsSync(path.join(job.cwd, "DO_NOT_TOUCH.txt")), false);

  fs.writeFileSync(
    path.join(job.cwd, "untrusted-test.py"),
    "raise Exception('unsafe')\n",
  );
  assert.throws(() => job.beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
  assert.equal(
    fs.readFileSync(path.join(f.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );
});

));
  assert.equal(git(matched.jobs[0].cwd, "rev-parse", "HEAD"), matched.head);
  assert.equal(
    fs.readFileSync(path.join(matched.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );

  const stale = fixture(t);
  const privateLanes = path.join(stale.stateDir, "isolated-worktrees");
  assert.equal(fs.existsSync(privateLanes), false);
  await assert.rejects(
    stale.dispatch(
      "run_project_command",
      stale.input({ expectedHead: "a".repeat(40) }),
      ["execute"],
    ),
    /WORKTREE_HEAD_MISMATCH/,
  );
  assert.equal(stale.jobs.length, 0);
  assert.equal(fs.existsSync(privateLanes), false);
  assert.equal(
    fs.readFileSync(path.join(stale.root, "DO_NOT_TOUCH.txt"), "utf8"),
    "protected changes\n",
  );
});

test("rejects unauthorized, read-only, overrides, and insufficient permissions", async (t) => {
  const other = fixture(t, "unrelated");
  const otherList = await other.dispatch(
    "list_project_commands",
    { device: "d1", project: "unrelated" },
    ["read"],
  );
  assert.deepEqual(otherList.commands, []);
  await assert.rejects(
    other.dispatch("run_project_command", other.input(), ["execute"]),
    /CLOUDOS_QA_PROJECT_NOT_ALLOWED/,
  );
  const readOnly = fixture(t, "kmj-cloudos", false);
  await assert.rejects(
    readOnly.dispatch("run_project_command", readOnly.input(), ["execute"]),
    /CLOUDOS_QA_PROJECT_NOT_ALLOWED/,
  );
  const approved = fixture(t);
  for (const extra of [
    { variant: "deploy" },
    { laneId: "arbitrary" },
  ]) {
    await assert.rejects(
      approved.dispatch("run_project_command", approved.input(extra), [
        "execute",
      ]),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    approved.dispatch(
      "run_project_command",
      approved.input({ expectedHead: "a".repeat(40) }),
      ["execute"],
    ),
    /WORKTREE_HEAD_MISMATCH/,
  );
  await assert.rejects(
    approved.dispatch("run_project_command", approved.input(), ["read"]),
    /ACCESS_DENIED/,
  );
  assert.equal(approved.jobs.length, 0);
});

test("missing required CloudOS files block queued QA from running", async (t) => {
  const f = fixture(t);
  const job = await f.dispatch("run_project_command", f.input(), ["execute"]);
  assert.equal(job.id, "qa-job");
  const cwd = f.jobs[0].cwd;
  fs.rmSync(path.join(cwd, "tests", "test_example.py"));
  assert.throws(() => f.jobs[0].beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
  assert.equal(
    fs.existsSync(path.join(f.root, "tests", "test_example.py")),
    true,
  );
});

test("CloudOS fixed QA requires an administrator-approved full gate", async (t) => {
  const f = fixture(t, "kmj-cloudos", true, false);
  const list = await f.dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-cloudos" },
    ["read"],
  );
  assert.equal(
    list.commands.some((cmd) => cmd.id === "cloudos_release_qa"),
    false,
  );
  await assert.rejects(
    f.dispatch("run_project_command", f.input(), ["execute"]),
    /CLOUDOS_QA_GATE_NOT_CONFIGURED/,
  );
  assert.equal(f.jobs.length, 0);
});
