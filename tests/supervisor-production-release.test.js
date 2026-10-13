import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const APPROVAL = "/etc/kmj-codebridge/main-platform-production-release.json";
const CURRENT = "/home/kmjprod/current";
const RELEASE = "commerce-3315f2a-20261009";
const SHA = "f21f6f36d9cbc3067edb7107b1a7517d862183ad";
const UNIT = "kmj-main-platform-production-release.service";

function harness({
  file = {
    approvedSha: SHA,
    expectedCurrentRelease: RELEASE,
    backupVerified: true,
    rollbackVerified: true,
  },
  fileMode = 0o100600,
  fileUid = 0,
  fileNlink = 1,
  symlink = "/home/kmjprod/releases/" + RELEASE,
  service = "inactive",
  nginx = "active",
  php = "active",
  unitInstalled = true,
} = {}) {
  const started = [];
  const calls = [];
  const handle = createSupervisorHandler({
    run: (exe, args) => {
      calls.push({ exe, args });
      assert.equal(exe, "/usr/bin/systemctl");
      assert.equal(args[0], "show");
      const unit = args[1];
      if (unit === UNIT)
        return `LoadState=${unitInstalled ? "loaded" : "not-found"}\nActiveState=${service}\nSubState=dead\nResult=success\nExecMainStatus=0\n`;
      if (unit === "nginx.service")
        return `LoadState=loaded\nActiveState=${nginx}\n`;
      if (unit === "php8.4-fpm.service")
        return `LoadState=loaded\nActiveState=${php}\n`;
      throw Error("unexpected unit request");
    },
    start: (unit) => started.push(unit),
    lstat: (path) => {
      if (path === APPROVAL)
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: fileUid,
          mode: fileMode,
          nlink: fileNlink,
        };
      if (path === CURRENT)
        return {
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      throw Error("unapproved lstat");
    },
    readlink: (path) => {
      assert.equal(path, CURRENT);
      return symlink;
    },
    readFile: (path) => {
      assert.equal(path, APPROVAL);
      return JSON.stringify(file);
    },
  });
  return { handle, started, calls };
}

const activate = {
  op: "main_platform_production_activate",
  approvedSha: SHA,
  expectedCurrentRelease: RELEASE,
  confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE",
};

test("production inventory reports only bounded status and safe release identity", async () => {
  const { handle, started, calls } = harness();
  const result = (await handle({ op: "main_platform_production_status" }))
    .response;
  assert.equal(result.currentRelease, RELEASE);
  assert.equal(result.approvedSha, SHA);
  assert.equal(result.expectedCurrentRelease, RELEASE);
  assert.equal(result.readyToActivate, true);
  assert.equal(result.releaseUnit.installed, true);
  assert.equal(result.nginxActive, true);
  assert.equal(result.phpFpmActive, true);
  assert.deepEqual(started, []);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(
    JSON.stringify(result),
    /\/etc\/|\/root\/|token|privateKey/i,
  );
});

test("deploy trigger acknowledges only after pinned manifest and fixed service preflight", async () => {
  const { handle, started } = harness();
  const res = await handle(activate);
  assert.deepEqual(res.response, { accepted: true, approvedSha: SHA });
  assert.deepEqual(
    started,
    [],
    "execution begins only after response delivered",
  );
  res.afterSend();
  assert.deepEqual(started, [UNIT]);
});

test("activation refuses any caller-supplied command, path, or manipulated approval", async () => {
  const { handle, started } = harness();
  for (const request of [
    { ...activate, command: "/bin/sh" },
    { ...activate, unit: "ssh.service" },
    { ...activate, cwd: "/" },
    { ...activate, approvedSha: "main" },
    { ...activate, expectedCurrentRelease: "../etc" },
    { ...activate, confirmation: "deploy" },
    { op: "main_platform_production_status", path: "/root/.ssh" },
  ]) {
    await assert.rejects(handle(request));
  }
  assert.deepEqual(started, []);
});

test("protected approval manifest failures, absent unit and unhealthy processes fail closed", async () => {
  for (const options of [
    { file: null },
    { file: { approvedSha: SHA, expectedCurrentRelease: RELEASE } },
    {
      file: {
        approvedSha: SHA,
        expectedCurrentRelease: RELEASE,
        backupVerified: true,
        rollbackVerified: true,
        command: "/bin/sh",
      },
    },
    { fileMode: 0o100666 },
    { fileUid: 1000 },
    { fileNlink: 2 },
    { symlink: "/tmp/evil" },
    { symlink: "/home/kmjprod/releases/../danger" },
    { service: "active" },
    { nginx: "inactive" },
    { php: "failed" },
    { unitInstalled: false },
    {
      file: {
        approvedSha: "0".repeat(40),
        expectedCurrentRelease: RELEASE,
        backupVerified: true,
        rollbackVerified: true,
      },
    },
    {
      file: {
        approvedSha: SHA,
        expectedCurrentRelease: "different_release",
        backupVerified: true,
        rollbackVerified: true,
      },
    },
  ]) {
    const { handle, started } = harness(options);
    const status = (await handle({ op: "main_platform_production_status" }))
      .response;
    assert.equal(status.readyToActivate, false, JSON.stringify(options));
    await assert.rejects(handle(activate), undefined, JSON.stringify(options));
    assert.deepEqual(
      started,
      [],
      "no side effects for " + JSON.stringify(options),
    );
  }
});

test("activation rejects mismatched old-release and candidate SHA even when host is healthy", async () => {
  const { handle } = harness();
  await assert.rejects(
    handle({ ...activate, approvedSha: "a".repeat(40) }),
    /SUPERVISOR_PRODUCTION_RELEASE_MISMATCH/,
  );
  await assert.rejects(
    handle({
      ...activate,
      expectedCurrentRelease: "commerce-aaaaaaa-20261001",
    }),
    /SUPERVISOR_PRODUCTION_RELEASE_MISMATCH/,
  );
});
