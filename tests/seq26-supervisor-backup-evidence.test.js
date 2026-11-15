import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSupervisorHandler } from "../src/supervisor.js";
import { createDispatcher } from "../src/tools.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";
function evidence() {
  return {
    mode: "READ_ONLY",
    daily: {
      state: "PRESENT",
      stamp: "20261115T050000Z",
      fresh: true,
      bytes: 104,
    },
    vault: {
      state: "PRESENT",
      stamp: "20261115T050000Z",
      fresh: true,
      bytes: 128,
    },
    localHealthArtifactsFresh: true,
    remoteShaReadbackVerified: false,
    independentRestoreVerified: false,
    productionReleaseApproved: false,
  };
}
test("root Supervisor fixed backup evidence needs no shell and rejects caller parameters", async () => {
  const units = [];
  const handle = createSupervisorHandler({
    backupEvidence: evidence,
    start: (unit) => units.push(unit),
    restart: (unit) => units.push(unit),
    run: () => {
      throw Error("unexpected process execution");
    },
  });
  const result = await handle({ op: "main_platform_local_backup_evidence" });
  assert.equal(result.response.localHealthArtifactsFresh, true);
  assert.deepEqual(units, []);
  for (const override of [
    { path: "/root/.ssh" },
    { command: "bash" },
    { args: ["--repair"] },
    { unit: "nginx.service" },
    { confirmation: "APPLY" },
    { target: "../etc" },
  ]) {
    await assert.rejects(
      handle({ op: "main_platform_local_backup_evidence", ...override }),
    );
  }
});
function fixture(
  t,
  {
    device = DEVICE,
    project = PROJECT,
    writable = true,
    supervisor = true,
  } = {},
) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-seq26-tools-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const root = path.join(work, "project"),
    stateDir = path.join(work, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const calls = [];
  const provider = supervisor
    ? {
        request: async (request) => {
          calls.push(request);
          return {
            response: {
              ...evidence(),
              privateKey: "redacted-never",
              daily: {
                ...evidence().daily,
                secretToken: "never",
              },
            },
          };
        },
      }
    : null;
  const dispatcher = createDispatcher(
    {
      id: device,
      stateDir,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    {
      maxConcurrent: 1,
      run: () => {
        throw Error("must not start jobs");
      },
    },
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    provider,
  );
  return { dispatcher, calls, device, project };
}
test("direct MCP read-only tool and existing-client command use identical fixed supervisor op", async (t) => {
  const f = fixture(t);
  const direct = await f.dispatcher(
    "supervisor_main_platform_local_backup_evidence",
    { device: DEVICE, project: PROJECT },
    ["read"],
  );
  assert.equal(direct.response.localHealthArtifactsFresh, true);
  const list = await f.dispatcher(
    "list_project_commands",
    { device: DEVICE, project: PROJECT },
    ["read"],
  );
  const command = list.commands.find(
    (row) => row.id === "main_platform_local_backup_evidence",
  );
  assert.deepEqual(command?.variants, ["overview"]);
  assert.equal(command?.approvalRequired, false);
  const oldClient = await f.dispatcher(
    "run_project_command",
    {
      device: DEVICE,
      project: PROJECT,
      command: "main_platform_local_backup_evidence",
      variant: "overview",
      requestKey: "seq26-fixture-1",
    },
    ["execute"],
  );
  assert.equal(oldClient.mode, "READ_ONLY");
  assert.equal(oldClient.localHealthArtifactsFresh, true);
  assert.equal(oldClient.remoteShaReadbackVerified, false);
  assert.equal(oldClient.independentRestoreVerified, false);
  assert.equal(Object.hasOwn(oldClient, "privateKey"), false);
  assert.equal(Object.hasOwn(oldClient.daily, "secretToken"), false);
  assert.deepEqual(f.calls, [
    { op: "main_platform_local_backup_evidence" },
    { op: "main_platform_local_backup_evidence" },
  ]);
});
test("client cannot smuggle shell/path/unknown variants through old command", async (t) => {
  const f = fixture(t);
  for (const overrides of [
    { variant: "apply" },
    { variant: "prune" },
    { laneId: "private" },
    { expectedHead: "a".repeat(40) },
    { path: "/root/secret" },
    { extra: "extra" },
  ]) {
    await assert.rejects(
      f.dispatcher(
        "run_project_command",
        {
          device: DEVICE,
          project: PROJECT,
          command: "main_platform_local_backup_evidence",
          variant: "overview",
          requestKey: "seq26-invalid-1",
          ...overrides,
        },
        ["execute"],
      ),
    );
  }
  assert.deepEqual(f.calls, []);
});

test("fixed health invocation receipt parses only current unit journal marker", async () => {
  const invocation = "a".repeat(32);
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/systemctl") {
        assert.deepEqual(args.slice(0, 2), [
          "show",
          "kmj-elite-health-check.service",
        ]);
        return [
          "LoadState=loaded",
          "Result=success",
          "ExecMainStatus=0",
          "InvocationID=" + invocation,
          "ExecMainExitTimestamp=Sun 2026-11-15 12:00:00 IST",
        ].join("\n");
      }
      assert.equal(command, "/usr/bin/journalctl");
      assert.ok(args.includes("_SYSTEMD_INVOCATION_ID=" + invocation));
      assert.equal(args.includes("--lines=150"), true);
      return "redacted private unrelated text\nKMJ_ELITE_HEALTH_PASS\n";
    },
    start: () => {
      throw Error("unexpected service start");
    },
    restart: () => {
      throw Error("unexpected restart");
    },
  });
  const result = await handle({ op: "main_platform_health_unit_receipt" });
  assert.equal(result.response.unitInvocationPass, true);
  assert.equal(result.response.scheduledTimerRunProven, false);
  assert.equal(result.response.rawJournalExposed, false);
  assert.doesNotMatch(JSON.stringify(result), /private unrelated text/);
  assert.equal(calls.length, 2);
  for (const supplied of [
    { unit: "other" },
    { path: "/root" },
    { args: ["start"] },
  ]) {
    await assert.rejects(
      handle({ op: "main_platform_health_unit_receipt", ...supplied }),
    );
  }
  assert.equal(calls.length, 2);
});

test("failed health unit never passes despite a forged success marker", async () => {
  const handle = createSupervisorHandler({
    run: (command) =>
      command === "/usr/bin/systemctl"
        ? "LoadState=loaded\nResult=exit-code\nExecMainStatus=1\nInvocationID=" +
          "b".repeat(32) +
          "\n"
        : "KMJ_ELITE_HEALTH_PASS\n",
  });
  const { response } = await handle({
    op: "main_platform_health_unit_receipt",
  });
  assert.equal(response.healthPassMarkerInOwnInvocation, true);
  assert.equal(response.unitInvocationPass, false);
  assert.equal(response.scheduledTimerRunProven, false);
});

test("missing invocation id does not read a broad journal", async () => {
  let journalRead = false;
  const handle = createSupervisorHandler({
    run: (command) => {
      if (command === "/usr/bin/systemctl")
        return "LoadState=loaded\nResult=success\nExecMainStatus=0\nInvocationID=\n";
      journalRead = true;
      throw Error("should not read journal without scoped invocation");
    },
  });
  const { response } = await handle({
    op: "main_platform_health_unit_receipt",
  });
  assert.equal(response.invocationAvailable, false);
  assert.equal(response.healthPassMarkerInOwnInvocation, false);
  assert.equal(response.unitInvocationPass, false);
  assert.equal(journalRead, false);
});

test("captured client gets a sanitized health receipt command without root shell", async (t) => {
  const f = fixture(t);
  const list = await f.dispatcher(
    "list_project_commands",
    {
      device: DEVICE,
      project: PROJECT,
    },
    ["read"],
  );
  assert.deepEqual(
    list.commands.find(
      (command) => command.id === "main_platform_health_unit_receipt",
    )?.variants,
    ["overview"],
  );
  const request = {
    device: DEVICE,
    project: PROJECT,
    command: "main_platform_health_unit_receipt",
    variant: "overview",
    requestKey: "seq26-health-receipt",
  };
  const receipt = await f.dispatcher("run_project_command", request, [
    "execute",
  ]);
  assert.equal(receipt.command, "main_platform_health_unit_receipt");
  assert.equal(receipt.unitInvocationPass, false);
  assert.equal(receipt.scheduledTimerRunProven, false);
  assert.equal(receipt.rawJournalExposed, false);
  assert.deepEqual(f.calls, [{ op: "main_platform_health_unit_receipt" }]);
  for (const change of [
    { variant: "restart" },
    { path: "/root" },
    { laneId: "other" },
  ]) {
    await assert.rejects(
      f.dispatcher("run_project_command", { ...request, ...change }, [
        "execute",
      ]),
    );
  }
  assert.deepEqual(f.calls, [{ op: "main_platform_health_unit_receipt" }]);
});

test("wrong device/project, disabled write grant or absent Supervisor never exposes privileged inspection", async (t) => {
  for (const variant of [
    { device: "other", project: PROJECT },
    { device: DEVICE, project: "other" },
    { device: DEVICE, project: PROJECT, writable: false },
    { device: DEVICE, project: PROJECT, supervisor: false },
  ]) {
    const f = fixture(t, variant);
    const names = await f.dispatcher(
      "list_project_commands",
      {
        device: f.device,
        project: f.project,
      },
      ["read"],
    );
    assert.equal(
      names.commands.some(
        (x) => x.id === "main_platform_local_backup_evidence",
      ),
      false,
    );
    await assert.rejects(
      f.dispatcher(
        "run_project_command",
        {
          device: f.device,
          project: f.project,
          command: "main_platform_local_backup_evidence",
          variant: "overview",
          requestKey: "seq26-blocked-1",
        },
        ["execute"],
      ),
    );
    assert.deepEqual(f.calls, []);
  }
});

test("direct privileged reads reject readonly and wrong-device enrollments", async (t) => {
  for (const variant of [
    { device: "other", project: PROJECT },
    { device: DEVICE, project: "other" },
    { device: DEVICE, project: PROJECT, writable: false },
  ]) {
    const f = fixture(t, variant);
    for (const name of [
      "supervisor_main_platform_local_backup_evidence",
      "supervisor_main_platform_health_unit_receipt",
    ]) {
      await assert.rejects(
        f.dispatcher(name, { device: f.device, project: f.project }, ["read"]),
        /ACCESS_DENIED/,
      );
    }
    assert.deepEqual(f.calls, []);
  }
});

test("fixed backup inventory returns categorical receipt and rejects parameter injection", async () => {
  let calls = 0;
  const handle = createSupervisorHandler({
    backupInventory: () => {
      calls++;
      return {
        daily: { status: "INSPECTED" },
        vault: { status: "INSPECTED" },
        correlation: { localArtifactsFresh: false },
        retentionPreview: { policyApproved: false, deletionAuthorized: false },
        mutations: "NONE",
      };
    },
    run: (command, args) => {
      assert.equal(command, "/usr/bin/systemctl");
      assert.ok(
        [
          "kmj-elite-health-check.service",
          "kmj-elite-offsite-backup.service",
        ].includes(args[1]),
      );
      return "LoadState=loaded\nResult=exit-code\nExecMainStatus=1\n";
    },
    start: () => {
      throw Error("unexpected start");
    },
    restart: () => {
      throw Error("unexpected restart");
    },
  });
  const { response } = await handle({ op: "main_platform_backup_inventory" });
  assert.equal(response.verdict, "LOCAL_ARTIFACTS_STALE_OR_MISSING");
  assert.equal(response.healthUnit.result, "exit-code");
  assert.equal(response.healthUnit.ownInvocationMarkerVerified, false);
  assert.equal(response.retentionPreview.deletionAuthorized, false);
  assert.equal(response.remoteSftpShaVerified, undefined);
  assert.equal(response.automaticRepairPerformed, false);
  assert.equal(calls, 1);
  for (const extra of [
    { path: "/root/.ssh" },
    { command: "rm" },
    { keepCount: 0 },
    { retentionApply: true },
    { unit: "nginx.service" },
  ]) {
    await assert.rejects(
      handle({ op: "main_platform_backup_inventory", ...extra }),
    );
  }
  assert.equal(calls, 1);
});

test("inventory old-client alias exposes sanitized allowlist and never grants pruning", async (t) => {
  const f = fixture(t);
  const listed = await f.dispatcher(
    "list_project_commands",
    {
      device: DEVICE,
      project: PROJECT,
    },
    ["read"],
  );
  assert.deepEqual(
    listed.commands.find((x) => x.id === "main_platform_backup_inventory")
      ?.variants,
    ["overview"],
  );
  const parameters = {
    device: DEVICE,
    project: PROJECT,
    command: "main_platform_backup_inventory",
    variant: "overview",
    requestKey: "seq26-preview-fixture",
  };
  const receipt = await f.dispatcher("run_project_command", parameters, [
    "execute",
  ]);
  assert.equal(receipt.command, "main_platform_backup_inventory");
  assert.equal(receipt.daily.status, "BLOCKED");
  assert.equal(receipt.vault.status, "BLOCKED");
  assert.equal(receipt.retentionPreview.policyApproved, false);
  assert.equal(receipt.retentionPreview.deletionAuthorized, false);
  assert.equal(receipt.independentRestoreVerified, false);
  assert.equal(receipt.healthUnit.scheduledTimerRunProven, false);
  assert.equal(Object.hasOwn(receipt, "privateKey"), false);
  assert.equal(receipt.shellExecuted, false);
  assert.deepEqual(f.calls, [{ op: "main_platform_backup_inventory" }]);
  for (const injected of [
    { variant: "apply" },
    { path: "/root/secrets" },
    { keepCount: 0 },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      f.dispatcher("run_project_command", { ...parameters, ...injected }, [
        "execute",
      ]),
    );
  }
  assert.deepEqual(f.calls, [{ op: "main_platform_backup_inventory" }]);
});

test("inventory direct/legacy routes refuse wrong device or readonly enrollment", async (t) => {
  for (const variant of [
    { device: "other", project: PROJECT },
    { device: DEVICE, project: "other" },
    { device: DEVICE, project: PROJECT, writable: false },
  ]) {
    const f = fixture(t, variant);
    await assert.rejects(
      f.dispatcher(
        "supervisor_main_platform_backup_inventory",
        {
          device: f.device,
          project: f.project,
        },
        ["read"],
      ),
    );
    await assert.rejects(
      f.dispatcher(
        "run_project_command",
        {
          device: f.device,
          project: f.project,
          command: "main_platform_backup_inventory",
          variant: "overview",
          requestKey: "seq26-inventory-unauthorized",
        },
        ["execute"],
      ),
    );
    assert.deepEqual(f.calls, []);
  }
});
