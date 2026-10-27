import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const ALLOWED = [
  "kmj-codebridge-kmj-main-platform.service",
  "kmj-codebridge-auto-update.service",
  "kmj-codebridge-development-ci.service",
];

function fixture({ missing = [], loadState = "loaded" } = {}) {
  const commands = [];
  const actions = [];
  const handle = createSupervisorHandler({
    run: (exe, args) => {
      commands.push({ exe, args });
      assert.equal(exe, "/usr/bin/systemctl");
      assert.equal(args[0], "show");
      assert.ok(ALLOWED.includes(args[1]));
      assert.equal(args.at(-1), "--no-pager");
      const installed = !missing.includes(args[1]);
      return [
        `LoadState=${installed ? loadState : "not-found"}`,
        `ActiveState=${installed ? "inactive" : "unknown"}`,
        "SubState=dead",
        "Result=success",
        "ExecMainStatus=0",
        "NRestarts=0",
      ].join("\n");
    },
    start: (unit) => actions.push(["start", unit]),
    restart: (unit) => actions.push(["restart", unit]),
  });
  return { handle, commands, actions };
}

test("guarded development reports only fixed safe services without granting root", async () => {
  const { handle, commands, actions } = fixture();
  const { response, afterSend } = await handle({
    op: "development_privilege_status",
  });
  assert.equal(response.permissionModel, "FIXED_OPERATIONS_ONLY");
  assert.equal(response.project, "kmj-main-platform");
  assert.equal(response.unrestrictedRoot, false);
  assert.equal(response.projectCodeRunsAsRoot, false);
  assert.equal(response.brokerStartAuthorized, false);
  assert.equal(response.productionReleaseApproved, false);
  assert.equal(response.signedUpdaterInstalled, true);
  assert.equal(response.developmentUnitInstalled, true);
  assert.equal(response.developmentUnitSecurityVerified, false);
  assert.equal(response.developmentWorkerReady, false);
  assert.equal(response.signedUpdaterVerified, false);
  assert.equal(commands.length, 3);
  assert.equal(afterSend, undefined);
  assert.deepEqual(actions, []);
  assert.doesNotMatch(
    JSON.stringify(response),
    /\/root\/|\/etc\/|\.env|password|private.key|secret/i,
  );
});

test("missing dev unit never becomes available and nothing starts", async () => {
  const { handle, actions } = fixture({
    missing: ["kmj-codebridge-development-ci.service"],
  });
  const { response } = await handle({ op: "development_privilege_status" });
  assert.equal(response.developmentUnitInstalled, false);
  assert.equal(response.developmentWorker.installed, false);
  assert.equal(response.brokerStartAuthorized, false);
  assert.deepEqual(actions, []);
});

test("masked, malformed and unknown unit states cannot claim installed development readiness", async () => {
  for (const loadState of [
    "masked",
    "error",
    "unknown",
    "",
    "loaded-but-not-verified",
  ]) {
    const { handle, actions } = fixture({ loadState });
    const { response } = await handle({ op: "development_privilege_status" });
    assert.equal(response.developmentUnitInstalled, false, loadState);
    assert.equal(response.developmentWorker.installed, false, loadState);
    assert.equal(response.signedUpdaterInstalled, false, loadState);
    assert.equal(response.developmentUnitSecurityVerified, false, loadState);
    assert.equal(response.developmentWorkerReady, false, loadState);
    assert.equal(response.brokerStartAuthorized, false, loadState);
    assert.deepEqual(actions, []);
  }
});

test("development root readiness rejects command, path, unit and approval injections", async () => {
  const { handle, commands, actions } = fixture();
  for (const extra of [
    { command: "/bin/sh" },
    { argv: ["sudo", "-n", "bash"] },
    { path: "/root/.ssh" },
    { unit: "sshd.service" },
    { service: "nginx" },
    { confirmation: "owner-approved" },
    { approvedSha: "a".repeat(40) },
  ]) {
    await assert.rejects(
      handle({ op: "development_privilege_status", ...extra }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  }
  assert.deepEqual(commands, []);
  assert.deepEqual(actions, []);
});

test("CloudOS supervisor profile cannot use Main Platform privileged development probe", async () => {
  const handle = createSupervisorHandler({ profile: "cloudos" });
  await assert.rejects(
    handle({ op: "development_privilege_status" }),
    /SUPERVISOR_OPERATION_NOT_ALLOWED/,
  );
});
