import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

function fixture(t, { project = "kmj-main-platform", writable = true, lock = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-main-private-ci-"));
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "CodeBridge Test");
  git("config", "user.email", "codebridge@example.invalid");
  const app = path.join(root, "apps", "platform");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({
      name: "@kmjtechno/main-platform",
      devDependencies: { "vite-plus": "0.3.0" },
    }),
  );
  if (lock) {
    fs.writeFileSync(
      path.join(app, "package-lock.json"),
      JSON.stringify({
        name: "@kmjtechno/main-platform",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "@kmjtechno/main-platform",
            devDependencies: { "vite-plus": "0.3.0" },
          },
          "node_modules/vite-plus": { version: "0.3.0" },
        },
      }),
    );
  }
  git("add", ".");
  git("commit", "-qm", "pinned dependency manifest");
  const head = git("rev-parse", "HEAD");
  const calls = [];
  const runner = {
    maxConcurrent: 1,
    run: (args) => {
      calls.push(args);
      return { id: "private-bootstrap-job", state: "queued", gate: args.gate };
    },
  };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  t.after(() =>
    fs.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  return { root, state, app, head, git, calls, dispatch };
}
const args = (project = "kmj-main-platform", extra = {}) => ({
  device: "d1",
  project,
  command: "main_platform_ui_deps",
  variant: "ci",
  requestKey: "locked-deps-20261017",
  ...extra,
});

test("private dependency command prepares exact HEAD without touching dirty source", async (t) => {
  const x = fixture(t);
  fs.writeFileSync(path.join(x.root, "owner-notes.txt"), "keep my changes");
  const profiles = await x.dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-main-platform" },
    ["read"],
  );
  const profile = profiles.commands.find((p) => p.id === "main_platform_ui_deps");
  assert.equal(profile.category, "build");
  assert.deepEqual(profile.variants, ["ci"]);
  assert.equal(profile.risk, "TEST");

  const queued = await x.dispatch(
    "run_project_command",
    args(),
    ["execute"],
  );
  assert.equal(queued.state, "queued");
  assert.equal(x.calls.length, 1);
  const job = x.calls[0];
  assert.equal(job.project, "kmj-main-platform");
  assert.equal(job.key, "locked-deps-20261017");
  assert.equal(job.command, process.platform === "win32" ? "npm.cmd" : "npm");
  assert.deepEqual(job.args, [
    "--prefix",
    "apps/platform",
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
  ]);
  assert.equal(job.timeoutMs, 180000);
  assert.equal(job.gate.includes(x.head), true);
  assert.equal(job.cwd.startsWith(path.join(x.state, "isolated-worktrees")), true);
  assert.equal(fs.readFileSync(path.join(x.root, "owner-notes.txt"), "utf8"), "keep my changes");
  assert.equal(fs.existsSync(path.join(x.root, "apps", "platform", "node_modules")), false);
  assert.equal(job.beforeStart(), job.cwd);

  const laneFile = path.join(job.cwd, "apps", "platform", "package-lock.json");
  fs.writeFileSync(laneFile, "{}");
  assert.throws(() => job.beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
});

test("private dependency command rejects absent lock and unauthorized overrides", async (t) => {
  const x = fixture(t, { lock: false });
  await assert.rejects(
    x.dispatch("run_project_command", args(), ["execute"]),
    /WORKTREE_DEPS_LOCK_MISSING/,
  );
  assert.equal(x.calls.length, 0);

  const other = fixture(t, { project: "another-project" });
  const listed = await other.dispatch(
    "list_project_commands",
    { device: "d1", project: "another-project" },
    ["read"],
  );
  assert.equal(listed.commands.some((p) => p.id === "main_platform_ui_deps"), false);
  await assert.rejects(
    other.dispatch("run_project_command", args("another-project"), ["execute"]),
    /READ_ONLY_PROJECT/,
  );

  const readonly = fixture(t, { writable: false });
  await assert.rejects(
    readonly.dispatch("run_project_command", args(), ["execute"]),
    /READ_ONLY_PROJECT/,
  );

  const allowed = fixture(t);
  for (const override of [
    { variant: "build" },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      allowed.dispatch("run_project_command", args("kmj-main-platform", override), ["execute"]),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    allowed.dispatch("run_project_command", args(), ["read"]),
    /ACCESS_DENIED/,
  );
  assert.equal(allowed.calls.length, 0);
});
