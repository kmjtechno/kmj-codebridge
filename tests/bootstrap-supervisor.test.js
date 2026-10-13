import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  bootstrapSupervisorStatus,
  requestBootstrapSupervisor,
} from "../src/bootstrap-supervisor.js";
import { createDispatcher, definitions } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

const ROOT =
  "/usr/local/libexec/kmj-codebridge/activate-supervisor-socket-approved";
const isRootDir = () => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o40755,
});
const isRootHelper = () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  nlink: 1,
  mode: 0o100755,
});

function fake(override = {}) {
  const calls = [];
  let started = false;
  const run = (_exe, args) => {
    calls.push(["show", ...args]);
    const unit = args[1];
    const key = args[2];
    if (key === "--property=ActiveState")
      return unit === "kmj-codebridge-supervisor.socket" && started
        ? "active\n"
        : "inactive\n";
    return "loaded\n";
  };
  const lstat = (name) => {
    if (name === ROOT) return isRootHelper();
    if (name === "/run/kmj-codebridge/supervisor.sock") {
      if (!started) throw new Error("ENOENT");
      return { isSocket: () => true, isSymbolicLink: () => false };
    }
    return isRootDir();
  };
  const invoke = (exe, args, options) => {
    calls.push(["invoke", exe, ...args]);
    assert.equal(options.timeout, 15000);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C" });
    started = true;
    return "SUPERVISOR_SOCKET_READY=1\n";
  };
  return {
    args: {
      platform: "linux",
      hostname: "KMJ-elite",
      run,
      lstat,
      invoke,
      ...override,
    },
    calls,
  };
}

test("fixed-host bootstrap diagnostics never run elsewhere", () => {
  const f = fake({
    platform: "win32",
    run: () => {
      throw new Error("must never execute");
    },
    lstat: () => {
      throw new Error("must never read");
    },
  });
  const result = bootstrapSupervisorStatus(f.args);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "BOOTSTRAP_FIXED_HOST_ONLY");
  assert.deepEqual(f.calls, []);
});

test("the unprivileged status tool distinguishes a missing operator helper", () => {
  const f = fake({
    lstat: (name) => {
      if (name === ROOT || name === "/run/kmj-codebridge/supervisor.sock")
        throw new Error("ENOENT");
      return isRootDir();
    },
  });
  const result = bootstrapSupervisorStatus(f.args);
  assert.equal(result.operatorSetupRequired, true);
  assert.equal(result.reason, "BOOTSTRAP_OPERATOR_HELPER_NOT_PROVISIONED");
  assert.equal(result.socketVerified, false);
  assert.ok(f.calls.every((entry) => entry[0] === "show"));
});

test("strict root ownership, symlinks and modes are not delegated", () => {
  const invalidStats = [
    { ...isRootHelper(), uid: 1000 },
    { ...isRootHelper(), mode: 0o100777 },
    { ...isRootHelper(), nlink: 2 },
    { ...isRootHelper(), isSymbolicLink: () => true },
  ];
  for (const invalid of invalidStats) {
    const f = fake({
      lstat: (name) => {
        if (name === ROOT) return invalid;
        if (name === "/run/kmj-codebridge/supervisor.sock")
          throw new Error("ENOENT");
        return isRootDir();
      },
      invoke: () => {
        throw new Error("must not execute");
      },
    });
    assert.equal(bootstrapSupervisorStatus(f.args).eligible, false);
    assert.throws(
      () =>
        requestBootstrapSupervisor(
          "START_APPROVED_CODEBRIDGE_SUPERVISOR",
          f.args,
        ),
      /BOOTSTRAP_OPERATOR_HELPER_NOT_PROVISIONED/,
    );
  }
});

test("activation is one exact passwordless sudo invocation and verifies socket", () => {
  const f = fake();
  assert.equal(bootstrapSupervisorStatus(f.args).eligible, true);
  const result = requestBootstrapSupervisor(
    "START_APPROVED_CODEBRIDGE_SUPERVISOR",
    f.args,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.socketVerified, true);
  assert.equal(result.liveMcpVerified, false);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === "invoke"),
    [["invoke", "/usr/bin/sudo", "-n", ROOT]],
  );
});

test("activation cannot be used without confirmation or owner sudo setup", () => {
  const f = fake({
    invoke: () => {
      throw new Error("permission denied");
    },
  });
  assert.throws(
    () => requestBootstrapSupervisor("yes", f.args),
    /BOOTSTRAP_CONFIRMATION_REQUIRED/,
  );
  assert.throws(
    () =>
      requestBootstrapSupervisor(
        "START_APPROVED_CODEBRIDGE_SUPERVISOR",
        f.args,
      ),
    /BOOTSTRAP_OPERATOR_AUTH_REQUIRED/,
  );
});

test("one-click bootstrap accepts no shell/path/host override in MCP schema", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bootstrap-"));
  const runner = new JobRunner(path.join(base, "jobs"), { maxConcurrent: 1 });
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: base,
      projects: [
        { id: "kmj-main-platform", root: base, writable: true, gates: {} },
        { id: "p2", root: base, writable: true, gates: {} },
      ],
    },
    runner,
    () => ({
      features: ["read", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scoped = { device: "device1", project: "kmj-main-platform" };
  assert.equal(definitions.bootstrap_supervisor_status.access, "read");
  assert.equal(definitions.bootstrap_supervisor_start.access, "execute");
  const status = await dispatch("bootstrap_supervisor_status", scoped, [
    "read",
  ]);
  assert.equal(status.reason, "BOOTSTRAP_FIXED_HOST_ONLY");
  await assert.rejects(
    dispatch(
      "bootstrap_supervisor_start",
      {
        ...scoped,
        confirmation: "START_APPROVED_CODEBRIDGE_SUPERVISOR",
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch(
      "bootstrap_supervisor_start",
      {
        ...scoped,
        confirmation: "START_APPROVED_CODEBRIDGE_SUPERVISOR",
        command: "/bin/bash",
      },
      ["execute"],
    ),
  );
  await assert.rejects(
    dispatch(
      "bootstrap_supervisor_status",
      {
        ...scoped,
        project: "p2",
      },
      ["read"],
    ),
    /BOOTSTRAP_PROJECT_DENIED/,
  );
});

test(
  "fixed root bootstrap helper passes shell syntax check on Linux",
  {
    skip: process.platform === "win32",
  },
  () => {
    const result = spawnSync(
      "bash",
      ["-n", "scripts/production/activate-supervisor-socket-approved.sh"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const source = fs.readFileSync(
      "scripts/production/activate-supervisor-socket-approved.sh",
      "utf8",
    );
    assert.match(source, /SUPERVISOR_START_STAGE_NOT_PINNED/);
    assert.match(source, /SUPERVISOR_START_RUNTIME_WRITABLE/);
    assert.doesNotMatch(source, /curl |wget |git pull|eval |\/bin\/bash -c/);
    const installer = fs.readFileSync(
      "scripts/production/install-main-platform-control.sh",
      "utf8",
    );
    assert.match(installer, /SUPERVISOR_FIXED_HELPER_INSTALLED_NO_SUDO_GRANT/);
    assert.doesNotMatch(installer, /\/etc\/sudoers\.d/);
  },
);
