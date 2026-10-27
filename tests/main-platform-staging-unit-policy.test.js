import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSupervisorHandler } from "../src/supervisor.js";
import { STAGING_DEPLOY_UNIT } from "../src/main-platform-staging-unit-policy.js";

const old = "9d15e14e39564ffb1e66085a483feb8331f9718f";
const next = "cd503e0137fbad2d8796709629e4d79bb7eceff3";
const root =
  "/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh";
const unit = "/etc/systemd/system/" + STAGING_DEPLOY_UNIT;
const manifest = "/etc/kmj-codebridge/main-platform-staging-approval.json";
const stageLink = "/home/kmjstage/htdocs/staging.kmjtechno.com";
const prodLink = "/home/kmjprod/current";
const hash = (s) => createHash("sha256").update(s).digest("hex");

function setup() {
  const script = "#!/bin/bash\nset -Eeuo pipefail\nexit 0\n";
  const service =
    "[Service]\nType=oneshot\nExecStart=/usr/bin/bash " + root + "\n";
  const approval = {
    schema: "kmj.main-platform.staging-approval.v1",
    approvedSha: next,
    expectedCurrentSha: old,
    expectedProductionRelease: "platform-8070dad72c55",
    runnerSha256: hash(script),
    unitSha256: hash(service),
    backupVerified: true,
    rollbackVerified: true,
    storageVerified: true,
    zeroAdditionalCostVerified: true,
  };
  const files = {
    [manifest]: JSON.stringify(approval),
    [root]: script,
    [unit]: service,
  };
  const links = {
    [stageLink]: "/home/kmjstage/releases/" + old + "/apps/platform",
    [prodLink]: "/home/kmjprod/releases/platform-8070dad72c55",
  };
  const overrides = {};
  const directoryOverrides = {};
  const missingDirectories = new Set();
  const directories = new Set([
    "/", "/etc", "/etc/kmj-codebridge", "/etc/systemd",
    "/etc/systemd/system", "/usr", "/usr/local", "/usr/local/libexec",
    "/usr/local/libexec/kmj-codebridge",
  ]);
  const started = [];
  let state = "inactive",
    dropin = "",
    needReload = "no",
    nginx = "active",
    socket = true;
  const handle = createSupervisorHandler({
    lstat: (p) => {
      if (directories.has(p) && !missingDirectories.has(p)) {
        const value = directoryOverrides[p] ?? {};
        return {
          isDirectory: () => true,
          isSymbolicLink: () => value.symlink ?? false,
          uid: value.uid ?? 0,
          mode: value.mode ?? 0o40755,
        };
      }
      if (Object.hasOwn(files, p)) {
        const value = overrides[p] ?? {};
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: value.uid ?? 0,
          nlink: 1,
          mode: value.mode ?? 0o100600,
          size: Buffer.byteLength(files[p]),
        };
      }
      if (Object.hasOwn(links, p)) return { isSymbolicLink: () => true };
      throw new Error("NO_FILE");
    },
    readFile: (p) => files[p],
    readlink: (p) => links[p],
    stat: () => ({ isSocket: () => socket }),
    run: (bin, args) => {
      assert.equal(bin, "/usr/bin/systemctl");
      const name = args[1];
      if (name === STAGING_DEPLOY_UNIT)
        return (
          "LoadState=loaded\nActiveState=" +
          state +
          "\nFragmentPath=" +
          unit +
          "\nDropInPaths=" +
          dropin +
          "\nNeedDaemonReload=" + needReload + "\n"
        );
      return (
        "LoadState=loaded\nActiveState=" +
        (name === "nginx.service" ? nginx : "active") +
        "\n"
      );
    },
    start: (name) => started.push(name),
  });
  return {
    handle,
    files,
    links,
    approval,
    overrides,
    directoryOverrides,
    missingDirectories,
    started,
    unitState: (x) => {
      state = x;
    },
    dropIns: (x) => {
      dropin = x;
    },
    needReload: (x) => {
      needReload = x;
    },
    nginx: (x) => {
      nginx = x;
    },
    socket: (x) => {
      socket = x;
    },
  };
}
const request = {
  op: "main_platform_staging_deploy",
  approvedSha: next,
  expectedCurrentSha: old,
  confirmation: "DEPLOY_APPROVED_STAGING_RELEASE",
};

test("root-pinned staging control ACK is not deployment verification", async () => {
  const x = setup();
  const status = (await x.handle({ op: "main_platform_staging_status" }))
    .response;
  assert.equal(status.ready, true);
  assert.equal(status.currentSha, old);
  assert.equal(status.approvedSha, next);
  assert.equal(JSON.stringify(status).includes(root), false);
  const result = await x.handle(request);
  assert.equal(result.response.accepted, true);
  assert.equal(result.response.deploymentVerified, false);
  assert.deepEqual(x.started, []);
  result.afterSend();
  assert.deepEqual(x.started, [STAGING_DEPLOY_UNIT]);
});

test("staging root broker forbids caller commands and invalid approval", async () => {
  const x = setup();
  for (const change of [
    { command: "/bin/bash" },
    { path: "/root/.ssh" },
    { approvedSha: "main" },
    { expectedCurrentSha: next },
    { confirmation: "YES" },
  ])
    await assert.rejects(
      x.handle({ ...request, ...change }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  assert.deepEqual(x.started, []);
});

test("staging fails closed on every privileged trust boundary", async () => {
  const mutations = [
    (x) => {
      delete x.files[manifest];
    },
    (x) => {
      x.overrides[manifest] = { mode: 0o100666 };
    },
    (x) => {
      x.overrides[root] = { uid: 1000 };
    },
    (x) => {
      x.files[root] += "echo unsafe\n";
    },
    (x) => {
      x.files[unit] += "ExecStartPre=/bin/sh\n";
    },
    (x) => {
      x.approval.backupVerified = false;
      x.files[manifest] = JSON.stringify(x.approval);
    },
    (x) => {
      x.approval.zeroAdditionalCostVerified = false;
      x.files[manifest] = JSON.stringify(x.approval);
    },
    (x) => {
      x.approval.command = "/bin/sh";
      x.files[manifest] = JSON.stringify(x.approval);
    },
    (x) => {
      x.links[stageLink] = "/home/kmjstage/releases/" + next + "/apps/platform";
    },
    (x) => {
      x.links[prodLink] = "/home/kmjprod/releases/unapproved";
    },
    (x) => {
      x.unitState("active");
    },
    (x) => {
      x.dropIns("/etc/systemd/system/override.conf");
    },
    (x) => {
      x.needReload("yes");
    },
    (x) => {
      x.needReload("");
    },
    (x) => {
      x.directoryOverrides["/usr/local/libexec"] = { mode: 0o40777 };
    },
    (x) => {
      x.directoryOverrides["/etc/kmj-codebridge"] = { uid: 1000 };
    },
    (x) => {
      x.directoryOverrides["/etc/systemd"] = { symlink: true };
    },
    (x) => {
      x.missingDirectories.add("/usr/local/libexec/kmj-codebridge");
    },
    (x) => {
      x.nginx("failed");
    },
    (x) => {
      x.socket(false);
    },
  ];
  for (const mutate of mutations) {
    const x = setup();
    mutate(x);
    assert.equal(
      (await x.handle({ op: "main_platform_staging_status" })).response.ready,
      false,
    );
    await assert.rejects(x.handle(request), /SUPERVISOR_STAGING_NOT_READY/);
    assert.deepEqual(x.started, []);
  }
});

test("post-ACK pointer drift prevents fixed unit from starting", async () => {
  const x = setup();
  const ack = await x.handle(request);
  x.links[stageLink] = "/home/kmjstage/releases/" + next + "/apps/platform";
  ack.afterSend();
  assert.deepEqual(x.started, []);
});


test("post-ACK runner replacement and stale systemd cache block start", async () => {
  for (const mutate of [
    (x) => { x.files[root] += "# changed after acknowledgement\n"; },
    (x) => { x.needReload("yes"); },
    (x) => { x.directoryOverrides["/usr/local/libexec"] = { mode: 0o40777 }; },
  ]) {
    const x = setup();
    const ack = await x.handle(request);
    assert.equal(ack.response.accepted, true);
    mutate(x);
    ack.afterSend();
    assert.deepEqual(x.started, []);
  }
});
