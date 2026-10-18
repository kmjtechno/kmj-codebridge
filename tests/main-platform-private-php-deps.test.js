import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDispatcher } from "../src/tools.js";

function fixture(t, { project = "kmj-main-platform", writable = true, lock = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-php-private-ci-"));
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  const app = path.join(root, "apps", "platform");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(state);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "CI Test");
  git("config", "user.email", "ci@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), "apps/platform/vendor/\n");
  fs.writeFileSync(
    path.join(app, "composer.json"),
    JSON.stringify({
      name: "kmjtechno/kmj-main-platform",
      description: "SHA-pinned isolated-only Composer CI fixture with no scripts executed",
      require: { "laravel/wayfinder": "^0.1.14" },
    }),
  );
  if (lock)
    fs.writeFileSync(
      path.join(app, "composer.lock"),
      JSON.stringify({
        "content-hash": "1".repeat(32),
        packages: [
          { name: "laravel/framework", version: "v13.0.0" },
          { name: "laravel/wayfinder", version: "v0.1.14" },
        ],
        description: "test-only-padding".repeat(45),
      }),
    );
  git("add", ".");
  git("commit", "-qm", "exact pinned PHP dependency fixture");
  const head = git("rev-parse", "HEAD");
  const calls = [];
  const runner = {
    maxConcurrent: 1,
    run: (options) => {
      calls.push(options);
      return { id: "php-private-ci-job", state: "queued", gate: options.gate };
    },
  };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, app, state, head, git, calls, dispatch };
}

const input = (extra = {}) => ({
  device: "d1",
  project: "kmj-main-platform",
  command: "main_platform_php_deps",
  variant: "ci",
  requestKey: "php-composer-p0-20261018",
  ...extra,
});

test("fixed Composer install is explicit, plugin/script-free and isolated at exact source HEAD", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "another-agent.txt"), "preserve");
  const listed = await f.dispatch(
    "list_project_commands",
    { device: "d1", project: "kmj-main-platform" },
    ["read"],
  );
  const profile = listed.commands.find((x) => x.id === "main_platform_php_deps");
  assert.deepEqual(profile.variants, ["ci", "routes"]);
  assert.equal(profile.risk, "TEST");

  const queued = await f.dispatch("run_project_command", input(), ["execute"]);
  assert.equal(queued.state, "queued");
  assert.equal(f.calls.length, 1);
  const job = f.calls[0];
  assert.equal(job.command, process.platform === "win32" ? "composer.bat" : "composer");
  assert.deepEqual(job.args, [
    "--no-cache",
    "--working-dir",
    "apps/platform",
    "install",
    "--no-interaction",
    "--no-progress",
    "--prefer-dist",
    "--no-plugins",
    "--no-scripts",
    "--no-ansi",
  ]);
  assert.equal(job.timeoutMs, 300000);
  assert.equal(job.cwd.includes("isolated-worktrees"), true);
  assert.equal(job.cwd.startsWith(f.root), false);
  assert.equal(job.gate.includes(f.head), true);
  assert.equal(job.beforeStart(), job.cwd);
  assert.equal(fs.readFileSync(path.join(f.root, "another-agent.txt"), "utf8"), "preserve");
  assert.equal(fs.existsSync(path.join(f.app, "vendor")), false);

  fs.writeFileSync(path.join(job.cwd, "apps", "platform", "composer.lock"), "{}");
  assert.throws(() => job.beforeStart(), /WORKTREE_HAS_UNSAVED_WORK/);
});

test("Wayfinder generation requires installed vendor and never calls a custom shell", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.dispatch(
      "run_project_command",
      input({ variant: "routes" }),
      ["execute"],
    ),
    /WORKTREE_PHP_VENDOR_NOT_INSTALLED/,
  );
  assert.equal(f.calls.length, 0);

  // Install only a synthetic vendor/autoload.php into an ignored private lane.
  await f.dispatch("run_project_command", input(), ["execute"]);
  const row = f.calls[0];
  const vendor = path.join(row.cwd, "apps", "platform", "vendor");
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, "autoload.php"), "<?php return true;");
  const routed = await f.dispatch(
    "run_project_command",
    input({
      variant: "routes",
      requestKey: "php-wayfinder-p0-20261018",
    }),
    ["execute"],
  );
  assert.equal(routed.state, "queued");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].command, "php");
  assert.deepEqual(f.calls[1].args, [
    "apps/platform/artisan",
    "wayfinder:generate",
    "--with-form",
    "--no-ansi",
  ]);
  assert.equal(f.calls[1].timeoutMs, 120000);
  assert.equal(f.calls[1].cwd, row.cwd);
});

test("PHP profile rejects caller overrides, unapproved projects, unsafe and missing locks", async (t) => {
  const valid = fixture(t);
  for (const overrides of [
    { variant: "deploy" },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
  ])
    await assert.rejects(
      valid.dispatch("run_project_command", input(overrides), ["execute"]),
      /COMMAND_NOT_ALLOWED/,
    );
  await assert.rejects(
    valid.dispatch("run_project_command", input(), ["read"]),
    /ACCESS_DENIED/,
  );
  assert.equal(valid.calls.length, 0);

  const readonly = fixture(t, { writable: false });
  await assert.rejects(
    readonly.dispatch("run_project_command", input(), ["execute"]),
    /READ_ONLY_PROJECT/,
  );
  const other = fixture(t, { project: "another-project" });
  await assert.rejects(
    other.dispatch(
      "run_project_command",
      input({ project: "another-project" }),
      ["execute"],
    ),
    /READ_ONLY_PROJECT/,
  );
  const missing = fixture(t, { lock: false });
  await assert.rejects(
    missing.dispatch("run_project_command", input(), ["execute"]),
    /WORKTREE_COMPOSER_LOCK_MISSING/,
  );
});
