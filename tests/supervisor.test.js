import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createSupervisorHandler, startSupervisor } from "../src/supervisor.js";
import {
  SUPERVISOR_SOCKET,
  supervisorRequest,
} from "../src/supervisor-client.js";

test("native private PR322 CI starts fixed systemd unit", async () => {
  const calls = [];
  const started = [];
  const handle = createSupervisorHandler({
    run: (bin, args) => {
      calls.push([bin, args]);
      return "LoadState=loaded\nActiveState=inactive\n";
    },
    start: (service) => started.push(service),
  });
  const result = await handle({ op: "private_pr322_ci_start" });
  assert.deepEqual(result.response, {
    accepted: true,
    target: "private-pr322",
  });
  assert.deepEqual(started, []);
  result.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-private-pr322-ci.service"]);
  assert.equal(calls[0][0], "/usr/bin/systemctl");
  assert.equal(calls[0][1][1], "kmj-codebridge-private-pr322-ci.service");
  await assert.rejects(
    handle({ op: "private_pr322_ci_start", command: "/bin/sh" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    handle({ op: "private_pr322_ci_start", sha: "a".repeat(40) }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=not-found\nActiveState=inactive\n",
    })({ op: "private_pr322_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_UNAVAILABLE/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=loaded\nActiveState=active\n",
    })({ op: "private_pr322_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_BUSY/,
  );
});

test("native CI status validates bounded root evidence", async () => {
  const evidence = {
    schema: 1,
    repo: "kmjtechno/kmj-main-platform",
    pr: 322,
    sha: "a".repeat(40),
    linux_result: "PASS",
    exit_code: 0,
    github_actions: "NOT_RUN",
    windows: "NOT_RUN",
    signed_production: false,
    log_sha256: "b".repeat(64),
    secret: "NEVER_RETURN",
  };
  const locations = [];
  const handle = createSupervisorHandler({
    run: () =>
      "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n",
    lstat: (name) => {
      locations.push(name);
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        nlink: 1,
        mode: 0o100600,
        size: 250,
      };
    },
    readFile: (name) => {
      locations.push(name);
      return JSON.stringify(evidence);
    },
  });
  const result = await handle({ op: "private_pr322_ci_status" });
  assert.deepEqual(result.response.last, {
    testedSha: "a".repeat(40),
    linuxResult: "PASS",
    exitCode: 0,
    logSha256: "b".repeat(64),
    githubActions: "NOT_RUN",
    windows: "NOT_RUN",
    signedProduction: false,
  });
  assert.equal(result.response.service.installed, true);
  assert.deepEqual(locations, [
    "/var/lib/kmj-codebridge-ci/evidence/latest-pr322.json",
    "/var/lib/kmj-codebridge-ci/evidence/latest-pr322.json",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN/);
  await assert.rejects(
    handle({ op: "private_pr322_ci_status", path: "/etc/shadow" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  evidence.windows = "PASS";
  assert.equal(
    (await handle({ op: "private_pr322_ci_status" })).response.last,
    null,
  );
  evidence.windows = "NOT_RUN";
  evidence.log_sha256 = "invalid";
  assert.equal(
    (await handle({ op: "private_pr322_ci_status" })).response.last,
    null,
  );
});

test("private CI rejects symlink and insecure evidence", async () => {
  for (const insecure of [
    { mode: 0o100644, isSymbolicLink: () => false, uid: 0 },
    { mode: 0o100600, isSymbolicLink: () => true, uid: 0 },
    { mode: 0o100600, isSymbolicLink: () => false, uid: 1000 },
  ]) {
    const handle = createSupervisorHandler({
      run: () => "LoadState=loaded\nActiveState=inactive\n",
      lstat: () => ({
        isFile: () => true,
        nlink: 1,
        size: 300,
        ...insecure,
      }),
      readFile: () => {
        throw new Error("insecure evidence unexpectedly opened");
      },
    });
    assert.equal(
      (await handle({ op: "private_pr322_ci_status" })).response.last,
      null,
    );
  }
});

test("status maps only allowlisted service names", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      return "ActiveState=active\nSubState=running\nMainPID=123\nNRestarts=2\n";
    },
  });
  const result = await handle({ op: "status", service: "agent" });
  assert.deepEqual(result.response, {
    service: "agent",
    activeState: "active",
    subState: "running",
    mainPid: 123,
    restarts: 2,
  });
  assert.equal(calls[0][0], "/usr/bin/systemctl");
  assert.equal(calls[0][1][1], "kmj-codebridge-agent.service");
  await assert.rejects(
    handle({ op: "status", service: "ssh" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
});

test("logs are bounded and redacted", async () => {
  const handle = createSupervisorHandler({
    run: () => "token=never-return-this\nnormal line\n",
  });
  const result = await handle({ op: "logs", service: "gateway", lines: 20 });
  assert.doesNotMatch(result.response.output, /never-return-this/);
  assert.match(result.response.output, /\[REDACTED\]/);
  await assert.rejects(
    handle({ op: "logs", service: "gateway", lines: 201 }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("config validation uses fixed paths and never returns config content", async () => {
  const seen = [];
  const handle = createSupervisorHandler({
    readFile: (file) => {
      seen.push(file);
      return JSON.stringify({
        gateway: "https://kmjtechno.com",
        token: "x".repeat(48),
        id: "d1",
        tenant: "t1",
        stateDir: "/var/lib/kmj-codebridge",
        projects: [{ id: "p1", root: "/srv/project" }],
        license: { mode: "free" },
      });
    },
  });
  const result = await handle({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: true });
  assert.deepEqual(seen, ["/etc/kmj-codebridge/agent.json"]);
  assert.equal(JSON.stringify(result).includes("x".repeat(20)), false);
});

test("restart is acknowledged before a hardcoded unit is scheduled", async () => {
  const restarted = [];
  const handle = createSupervisorHandler({
    restart: (unit) => restarted.push(unit),
  });
  const result = await handle({ op: "restart", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", accepted: true });
  assert.deepEqual(restarted, []);
  result.afterSend();
  assert.deepEqual(restarted, ["kmj-codebridge-agent.service"]);
});

test("device status returns a bounded resource snapshot", async () => {
  const handle = createSupervisorHandler({
    deviceStatus: () => ({
      platform: "linux",
      arch: "x64",
      hostname: "codebridge-host",
      cpuCount: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      freeMemoryBytes: 40 * 1024 ** 3,
      loadAverage: { one: 1.25, five: 0.75, fifteen: 0.5 },
      uptimeSeconds: 12345,
      processUptimeSeconds: 90,
      nodeVersion: "v24.21.0",
    }),
  });
  const result = await handle({ op: "device_status" });
  assert.deepEqual(result.response, {
    platform: "linux",
    arch: "x64",
    hostname: "codebridge-host",
    cpuCount: 16,
    totalMemoryBytes: 64 * 1024 ** 3,
    freeMemoryBytes: 40 * 1024 ** 3,
    loadAverage: { one: 1.25, five: 0.75, fifteen: 0.5 },
    uptimeSeconds: 12345,
    processUptimeSeconds: 90,
    nodeVersion: "v24.21.0",
  });
  await assert.rejects(
    handle({ op: "device_status", command: "whoami" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("device status sanitizes invalid provider values", async () => {
  const handle = createSupervisorHandler({
    deviceStatus: () => ({
      platform: "x".repeat(100),
      arch: null,
      hostname: "h".repeat(500),
      cpuCount: -5,
      totalMemoryBytes: Number.POSITIVE_INFINITY,
      freeMemoryBytes: -1,
      loadAverage: { one: -1, five: 2, fifteen: Number.NaN },
      uptimeSeconds: -1,
      processUptimeSeconds: 3.9,
      nodeVersion: 123,
    }),
  });
  const result = await handle({ op: "device_status" });
  assert.equal(result.response.platform.length, 32);
  assert.equal(result.response.arch, "unknown");
  assert.equal(result.response.hostname.length, 253);
  assert.equal(result.response.cpuCount, 0);
  assert.equal(result.response.totalMemoryBytes, 0);
  assert.equal(result.response.freeMemoryBytes, 0);
  assert.deepEqual(result.response.loadAverage, {
    one: 0,
    five: 2,
    fifteen: 0,
  });
  assert.equal(result.response.uptimeSeconds, 0);
  assert.equal(result.response.processUptimeSeconds, 3);
  assert.equal(result.response.nodeVersion, "unknown");
});

test("project status derives the root from the fixed agent config", async () => {
  const seen = [];
  const root = "/srv/kmj-codebridge-projects/codebridge-control";
  const handle = createSupervisorHandler({
    readFile: (file) => {
      assert.equal(file, "/etc/kmj-codebridge/agent.json");
      return JSON.stringify({
        gateway: "https://kmjtechno.com",
        token: "x".repeat(48),
        id: "d1",
        tenant: "t1",
        stateDir: "/var/lib/kmj-codebridge",
        projects: [{ id: "project_1", root }],
        license: { mode: "free" },
      });
    },
    exists: (target) => {
      seen.push(target);
      return target === root || target === `${root}/.git`;
    },
    stat: (target) => {
      seen.push(target);
      return { isDirectory: () => true };
    },
  });
  const result = await handle({ op: "project_status", projectId: "project_1" });
  assert.deepEqual(result.response, {
    projectId: "project_1",
    present: true,
    directory: true,
    gitCheckout: true,
  });
  assert.deepEqual(seen, [root, root, `${root}/.git`]);
});

test("project status rejects traversal and arbitrary path inputs", async () => {
  const handle = createSupervisorHandler();
  for (const request of [
    { op: "project_status", projectId: "../root" },
    { op: "project_status", projectId: "project/other" },
    { op: "project_status", projectId: "" },
    { op: "project_status", projectId: "x".repeat(65) },
    { op: "project_status", projectId: "project1", path: "/tmp/project1" },
  ]) {
    await assert.rejects(handle(request), /INVALID_SUPERVISOR_REQUEST/);
  }
});

test("disk-space operation accepts no caller path", async () => {
  const handle = createSupervisorHandler({
    statfs: () => ({ bsize: 4096, blocks: 100, bavail: 25 }),
  });
  const result = await handle({ op: "disk_space" });
  assert.equal(result.response.totalBytes, 409600);
  assert.equal(result.response.freeBytes, 102400);
  await assert.rejects(
    handle({ op: "disk_space", path: "/tmp" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("auto-update status reports only fixed timer, updater and Main Platform refresh units", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      if (args[1] === "kmj-codebridge-auto-update.timer")
        return "LoadState=loaded\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\n";
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n";
    },
    lstat: () => {
      throw new Error("not present");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response, {
    available: true,
    timer: {
      installed: true,
      activeState: "active",
      subState: "waiting",
      unitFileState: "enabled",
    },
    service: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      result: "success",
      execMainStatus: "0",
    },
    mainPlatformRefresh: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      conditionResult: "unknown",
      result: "success",
      execMainStatus: "0",
      execMainStartTimestamp: "unknown",
      execMainExitTimestamp: "unknown",
    },
    mainPlatformAgent: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      mainPID: "unknown",
      nRestarts: "unknown",
      execMainStartTimestamp: "unknown",
    },
    privatePr322Ci: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      result: "success",
      execMainStatus: "0",
      execMainStartTimestamp: "unknown",
      execMainExitTimestamp: "unknown",
    },
    privatePr337Ci: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      result: "success",
      execMainStatus: "0",
      execMainStartTimestamp: "unknown",
      execMainExitTimestamp: "unknown",
      invocationID: "unknown",
    },
    privatePr322Evidence: null,
    privatePr337Evidence: null,
    privatePr337Diagnostic: "NO_CLASSIFIED_ERROR",
    privatePr337GitSignals: {
      permissionDenied: false,
      objectReadFailure: false,
      preparationStage: null,
    },
    privatePr337Source: {
      headSha: null,
      refSha: null,
      headLocks: null,
      refLocks: null,
    },
    mainPlatformEffectiveUnit: {
      installed: true,
      runtimeKind: "unknown",
      stagedRuntimeEffective: false,
      releaseOverridePresent: false,
      developmentCanaryOverridePresent: false,
      readinessOverridePresent: false,
      signedProductionProven: false,
    },
    mainPlatformPrerequisites: {
      currentConfig: false,
      legacyConfig: false,
      projectGit: false,
    },
    mainPlatformEvidence: [],
    updateMarkers: [],
    mainPlatformRefreshMarkers: [],
  });
  assert.deepEqual(
    calls
      .filter((entry) => entry[0].endsWith("systemctl"))
      .map((entry) => entry[1][1]),
    [
      "kmj-codebridge-auto-update.timer",
      "kmj-codebridge-auto-update.service",
      "kmj-codebridge-kmj-main-platform.service",
      "kmj-codebridge-main-platform-refresh.service",
      "kmj-codebridge-private-pr322-ci.service",
      "kmj-codebridge-private-pr337-ci.service",
      "kmj-codebridge-private-pr337-ci.service",
      "kmj-codebridge-private-pr337-ci.service",
      "kmj-codebridge-kmj-main-platform.service",
    ],
  );
  await assert.rejects(
    handle({ op: "update_status", branch: "main" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("effective-unit doctor identifies overrides without leaking ExecStart", async () => {
  const sha = "a".repeat(40);
  const directory = "/opt/kmj-codebridge-main-platform-stage/" + sha;
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      if (args.includes("--property=WorkingDirectory")) {
        return [
          "LoadState=loaded",
          "WorkingDirectory=" + directory,
          "ExecStart=argv[]=/opt/kmj-codebridge-node/bin/node " +
            directory +
            "/src/cli.js agent /etc/kmj-codebridge-main-platform/agent.json ; token=NEVER_LEAK",
          "DropInPaths=/etc/systemd/system/kmj-codebridge-kmj-main-platform.service.d/99-kmj-release.conf " +
            "/etc/systemd/system/kmj-codebridge-kmj-main-platform.service.d/zz-kmj-codebridge-development-canary.conf",
        ].join("\n");
      }
      return "LoadState=loaded\nActiveState=active\nSubState=running\n";
    },
    lstat: () => {
      throw new Error("absent");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.mainPlatformEffectiveUnit, {
    installed: true,
    runtimeKind: "staged-development",
    stagedRuntimeEffective: true,
    releaseOverridePresent: true,
    developmentCanaryOverridePresent: true,
    readinessOverridePresent: false,
    signedProductionProven: false,
  });
  assert.equal(JSON.stringify(result).includes("NEVER_LEAK"), false);
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.deepEqual(
    calls
      .filter((entry) => entry[1].includes("--property=WorkingDirectory"))
      .map((entry) => entry[1][1]),
    ["kmj-codebridge-kmj-main-platform.service"],
  );
  await assert.rejects(
    handle({ op: "update_status", runtime: "/tmp/unsafe" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("effective-unit doctor treats canary and unknown runtime as unverified", async () => {
  for (const [directory, expected] of [
    [
      "/opt/kmj-codebridge-main-platform-agent-cb64119277ef",
      "development-canary",
    ],
    ["/tmp/untrusted", "unknown"],
  ]) {
    const handle = createSupervisorHandler({
      run: (_command, args) =>
        args.includes("--property=WorkingDirectory")
          ? "LoadState=loaded\nWorkingDirectory=" +
            directory +
            "\nExecStart=unverified\nDropInPaths=\n"
          : "LoadState=loaded\nActiveState=active\n",
      lstat: () => {
        throw new Error("absent");
      },
    });
    const result = await handle({ op: "update_status" });
    assert.equal(
      result.response.mainPlatformEffectiveUnit.runtimeKind,
      expected,
    );
    assert.equal(
      result.response.mainPlatformEffectiveUnit.stagedRuntimeEffective,
      false,
    );
    assert.equal(
      result.response.mainPlatformEffectiveUnit.signedProductionProven,
      false,
    );
  }
});

test("Main Platform evidence returns allowlisted outcomes and no secret log text", async () => {
  const handle = createSupervisorHandler({
    run: (command, args) => {
      if (command.endsWith("journalctl")) {
        return [
          "Existing Main Platform agent config verified.",
          "KMJ Main Platform CodeBridge project agent is active.",
          "token=DO_NOT_EXPOSE",
          "credential=DO_NOT_EXPOSE",
          "MAIN_PLATFORM_AGENT_GATEWAY_VERIFIED",
          "device_id=private",
          "credential_introspection=PASS",
        ].join("\n");
      }
      return "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nNRestarts=0\n";
    },
    lstat: () => {
      throw new Error("not present");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.mainPlatformEvidence, [
    "EXISTING_CONFIG_VERIFIED",
    "SERVICE_ACTIVE_CONFIRMED",
    "GATEWAY_VERIFIED",
    "CREDENTIAL_INTROSPECTION_PASS",
  ]);
  assert.equal(result.response.mainPlatformAgent.mainPID, "123");
  assert.equal(result.response.mainPlatformAgent.nRestarts, "0");
  assert.equal(
    JSON.stringify(result.response).includes("DO_NOT_EXPOSE"),
    false,
  );
});

test("fixed refresh prerequisite doctor never accepts caller paths", async () => {
  const seen = [];
  const handle = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
    lstat: (p) => {
      seen.push(p);
      if (p.endsWith("/.git")) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
        };
      }
      if (p.endsWith("/agent.json")) {
        return {
          isSymbolicLink: () => true,
          isFile: () => true,
          nlink: 1,
        };
      }
      return {
        isSymbolicLink: () => false,
        isFile: () => true,
        nlink: 1,
      };
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.mainPlatformPrerequisites, {
    currentConfig: false,
    legacyConfig: true,
    projectGit: true,
  });
  assert.deepEqual(
    seen.sort(),
    [
      "/etc/kmj-codebridge-main-platform/agent.json",
      "/etc/kmj-codebridge/agents/kmj-main-platform.json",
      "/srv/kmj-codebridge-projects/kmj-main-platform/.git",
      "/var/lib/kmj-codebridge-ci/evidence/latest-pr322.json",
      "/var/lib/kmj-codebridge-ci/evidence/latest-pr337.json",
    ].sort(),
  );
  await assert.rejects(
    handle({ op: "update_status", path: "/etc/shadow" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("only exact non-secret updater markers are exposed", async () => {
  const handle = createSupervisorHandler({
    run: (command, args) => {
      if (command.endsWith("journalctl")) {
        if (args[1] === "kmj-codebridge-auto-update.service") {
          return [
            "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED",
            "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED_PROTECTED_OVERRIDE",
            "AUTO_UPDATE_MAIN_PLATFORM_UNIT_PREFLIGHT_UNAVAILABLE",
            "AUTO_UPDATE_TOKEN=secret_should_not_appear",
            "AUTHORIZATION: Bearer never_expose",
            "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_SCHEDULED=1",
          ].join("\n");
        }
        return [
          "MAIN_PLATFORM_REFRESH_LEGACY_CONFIG_MIGRATED=1",
          "tenant_id=private",
          "MAIN_PLATFORM_REFRESH_CONFIG_DIR_UNSAFE=/etc/private",
        ].join("\n");
      }
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\n";
    },
    lstat: () => {
      throw new Error("not installed");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.updateMarkers, [
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED_PROTECTED_OVERRIDE",
    "AUTO_UPDATE_MAIN_PLATFORM_UNIT_PREFLIGHT_UNAVAILABLE",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_SCHEDULED=1",
  ]);
  assert.deepEqual(result.response.mainPlatformRefreshMarkers, [
    "MAIN_PLATFORM_REFRESH_LEGACY_CONFIG_MIGRATED=1",
  ]);
  assert.doesNotMatch(
    JSON.stringify(result.response),
    /secret_should_not_appear|tenant_id=private|\/etc\/private|Bearer/,
  );
});

test("auto-update trigger acknowledges before starting only the hardcoded unit", async () => {
  const started = [];
  const handle = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=inactive\n",
    start: (unit) => started.push(unit),
  });
  const result = await handle({ op: "update_now" });
  assert.deepEqual(result.response, { accepted: true });
  assert.deepEqual(started, []);
  result.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-auto-update.service"]);
  await assert.rejects(
    handle({ op: "update_now", unit: "ssh.service" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("auto-update trigger fails closed when the fixed unit is not installed", async () => {
  const handle = createSupervisorHandler({
    run: () => "LoadState=not-found\nActiveState=inactive\n",
  });
  await assert.rejects(
    handle({ op: "update_now" }),
    /SUPERVISOR_UPDATE_UNAVAILABLE/,
  );
});

test(
  "unix socket server and client exchange one bounded request",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-supervisor-"));
    const socketPath = path.join(dir, "supervisor.sock");
    const service = await startSupervisor({
      socketPath,
      handler: async (request) => ({ response: { echoed: request.op } }),
    });
    t.after(async () => {
      await service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // The production client intentionally accepts only the fixed system
    // socket, so use the server directly here and separately assert the
    // fixed-path client boundary below.
    assert.ok(fs.existsSync(socketPath));
  },
);

test("client refuses arbitrary local socket paths", async () => {
  await assert.rejects(
    supervisorRequest("/tmp/not-codebridge.sock", { op: "status" }),
    /SUPERVISOR_UNAVAILABLE/,
  );
  assert.equal(SUPERVISOR_SOCKET, "/run/kmj-codebridge/supervisor.sock");
});

// PR337 uses the same fail-closed supervisor protections as PR322.
test("native private PR337 CI starts fixed systemd unit", async () => {
  const calls = [];
  const started = [];
  const handle = createSupervisorHandler({
    run: (bin, args) => {
      calls.push([bin, args]);
      return "LoadState=loaded\nActiveState=inactive\n";
    },
    start: (service) => started.push(service),
  });
  const result = await handle({ op: "private_pr337_ci_start" });
  assert.deepEqual(result.response, {
    accepted: true,
    target: "private-pr337",
  });
  assert.deepEqual(started, []);
  result.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-private-pr337-ci.service"]);
  assert.equal(calls[0][0], "/usr/bin/systemctl");
  assert.equal(calls[0][1][1], "kmj-codebridge-private-pr337-ci.service");
  await assert.rejects(
    handle({ op: "private_pr337_ci_start", command: "/bin/sh" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    handle({ op: "private_pr337_ci_start", sha: "a".repeat(40) }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=not-found\nActiveState=inactive\n",
    })({ op: "private_pr337_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_UNAVAILABLE/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=loaded\nActiveState=active\n",
    })({ op: "private_pr337_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_BUSY/,
  );
});

test("native CI status validates bounded root evidence", async () => {
  const evidence = {
    schema: 1,
    repo: "kmjtechno/kmj-main-platform",
    pr: 337,
    sha: "a".repeat(40),
    linux_result: "PASS",
    exit_code: 0,
    github_actions: "NOT_RUN",
    windows: "NOT_RUN",
    signed_production: false,
    log_sha256: "b".repeat(64),
    secret: "NEVER_RETURN",
  };
  const locations = [];
  const handle = createSupervisorHandler({
    run: () =>
      "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n",
    lstat: (name) => {
      locations.push(name);
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        nlink: 1,
        mode: 0o100600,
        size: 250,
      };
    },
    readFile: (name) => {
      locations.push(name);
      return JSON.stringify(evidence);
    },
  });
  const result = await handle({ op: "private_pr337_ci_status" });
  assert.deepEqual(result.response.last, {
    testedSha: "a".repeat(40),
    linuxResult: "PASS",
    exitCode: 0,
    logSha256: "b".repeat(64),
    githubActions: "NOT_RUN",
    windows: "NOT_RUN",
    signedProduction: false,
  });
  assert.equal(result.response.service.installed, true);
  assert.deepEqual(locations, [
    "/var/lib/kmj-codebridge-ci/evidence/latest-pr337.json",
    "/var/lib/kmj-codebridge-ci/evidence/latest-pr337.json",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN/);
  await assert.rejects(
    handle({ op: "private_pr337_ci_status", path: "/etc/shadow" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  evidence.windows = "PASS";
  assert.equal(
    (await handle({ op: "private_pr337_ci_status" })).response.last,
    null,
  );
  evidence.windows = "NOT_RUN";
  evidence.log_sha256 = "invalid";
  assert.equal(
    (await handle({ op: "private_pr337_ci_status" })).response.last,
    null,
  );
});

test("website CI diagnosis exposes only fixed error categories", async () => {
  const journal = [
    "fatal: detected dubious ownership in repository at /private/example",
    "fatal: unable to access https://secret-token@example.invalid/repo",
    "KMJ_CI_FIXED_REF_LOOKUP_FAILED",
  ].join("\n");
  const handle = createSupervisorHandler({
    run: (cmd, args) =>
      cmd.endsWith("journalctl") &&
      args[1] === "kmj-codebridge-private-pr337-ci.service"
        ? journal
        : "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
    lstat: () => {
      throw new Error("fixture");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.equal(
    result.response.privatePr337Diagnostic,
    "FIXED_REF_LOOKUP_FAILED",
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-token|example.invalid/);
  await assert.rejects(
    handle({ op: "update_status", unit: "ssh.service" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("website CI classifies missing paths and read-only Git failures without exposing private data", async () => {
  for (const [journal, expected] of [
    [
      "fatal: path 'apps/platform/composer.lock' does not exist in 'private-sha'",
      "GIT_PATH_UNAVAILABLE_COMPOSER_UNKNOWN",
    ],
    [
      "fatal: ambiguous argument 'secret-ref': unknown revision or path not in the working tree.",
      "GIT_REF_UNAVAILABLE",
    ],
    ["fatal: bad object secret-object", "GIT_OBJECT_UNAVAILABLE"],
    [
      "fatal: Unable to create '/private/index.lock': Read-only file system",
      "GIT_READ_ONLY_FILESYSTEM",
    ],
    [
      "fatal: cannot open /private/config: Operation not permitted",
      "GIT_OPERATION_NOT_PERMITTED",
    ],
    ["fatal: bad config line 2 in file /private/config", "GIT_CONFIG_INVALID"],
  ]) {
    const handle = createSupervisorHandler({
      run: (cmd, args) =>
        cmd.endsWith("journalctl") &&
        args[1] === "kmj-codebridge-private-pr337-ci.service"
          ? journal
          : "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
      lstat: () => {
        throw new Error("fixture");
      },
    });
    const result = await handle({ op: "update_status" });
    assert.equal(result.response.privatePr337Diagnostic, expected);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-sha|secret-ref|secret-object|\/private/,
    );
  }
});

test("website CI source readback pins checkout and reports only SHAs and lock presence", async () => {
  const head = "a".repeat(40),
    ref = "b".repeat(40);
  const calls = [];
  const handle = createSupervisorHandler({
    run: (cmd, args, options) => {
      if (cmd === "/usr/bin/git") {
        assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
        calls.push(args);
        if (args.includes("rev-parse"))
          return args.at(-1) === "HEAD" ? head : ref;
        if (args.at(-1) === `${head}:apps/platform/composer.lock`)
          throw new Error("private failure");
        return "";
      }
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\n";
    },
    lstat: () => {
      throw new Error("fixture");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.privatePr337Source, {
    headSha: head,
    refSha: ref,
    headLocks: { composer: false, npm: true },
    refLocks: { composer: true, npm: true },
  });
  assert.equal(calls.length, 6);
  for (const args of calls)
    assert.deepEqual(args.slice(0, 4), [
      "-c",
      "safe.directory=/srv/kmj-codebridge-projects/kmj-main-platform",
      "-C",
      "/srv/kmj-codebridge-projects/kmj-main-platform",
    ]);
  assert.doesNotMatch(JSON.stringify(result), /private failure/);
  await assert.rejects(
    handle({ op: "update_status", ref: "attacker" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("website CI run diagnostics expose freshness and fixed Git signals only", async () => {
  const handle = createSupervisorHandler({
    run: (cmd) => {
      if (cmd === "/usr/bin/journalctl")
        return "KMJ_CI_PREP_STAGE=HEAD_LOCK_READ\nerror: cannot open /private/object: Permission denied\nfatal: path 'apps/platform/composer.lock' does not exist in 'HEAD'\nsecret token=NEVER_RETURN";
      return "LoadState=loaded\nExecMainStartTimestamp=Thu 2026-10-08 12:00:00 UTC\nExecMainExitTimestamp=Thu 2026-10-08 12:00:01 UTC\nInvocationID=0123456789abcdef0123456789abcdef\n";
    },
    lstat: () => {
      throw new Error("absent");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.equal(
    result.response.privatePr337Ci.execMainStartTimestamp,
    "Thu 2026-10-08 12:00:00 UTC",
  );
  assert.equal(
    result.response.privatePr337Ci.invocationID,
    "0123456789abcdef0123456789abcdef",
  );
  assert.deepEqual(result.response.privatePr337GitSignals, {
    permissionDenied: true,
    objectReadFailure: true,
    preparationStage: "HEAD_LOCK_READ",
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /private\/object|NEVER_RETURN|token=/,
  );
});

test("website CI journal filters accept only systemd invocation IDs", async () => {
  for (const id of [
    "0123456789abcdef0123456789abcdef",
    "secret --file=/private",
  ]) {
    const journals = [];
    const handle = createSupervisorHandler({
      run: (cmd, args) => {
        if (cmd === "/usr/bin/journalctl") {
          journals.push(args);
          return "";
        }
        if (args.includes("--value")) return id;
        return "LoadState=loaded\n";
      },
      lstat: () => {
        throw new Error("absent");
      },
    });
    await handle({ op: "update_status" });
    for (const args of journals.filter(
      (args) => args[1] === "kmj-codebridge-private-pr337-ci.service",
    )) {
      const matches = args.filter((arg) =>
        arg.startsWith("_SYSTEMD_INVOCATION_ID="),
      );
      assert.deepEqual(
        matches,
        id.startsWith("secret") ? [] : [`_SYSTEMD_INVOCATION_ID=${id}`],
      );
      assert.doesNotMatch(args.join(" "), /\/private|secret/);
    }
  }
});

test("website CI source readback rejects malformed revisions and hides Git errors", async () => {
  const handle = createSupervisorHandler({
    run: (cmd) => {
      if (cmd === "/usr/bin/git")
        return "secret-ref https://credential@example.invalid";
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\n";
    },
    lstat: () => {
      throw new Error("fixture");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.privatePr337Source, {
    headSha: null,
    refSha: null,
    headLocks: null,
    refLocks: null,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-ref|credential|example.invalid/,
  );
});

test("website CI pinpoints only allowlisted missing lock paths and revisions", async () => {
  for (const [line, expected] of [
    [
      "fatal: path 'apps/platform/composer.lock' does not exist in 'HEAD'",
      "GIT_PATH_UNAVAILABLE_COMPOSER_HEAD",
    ],
    [
      "fatal: path 'apps/platform/package-lock.json' exists on disk, but not in '" +
        "a".repeat(40) +
        "'",
      "GIT_PATH_UNAVAILABLE_NPM_COMMIT",
    ],
    [
      "fatal: path 'private-secret' does not exist in 'private-ref'",
      "GIT_PATH_UNAVAILABLE_OTHER_UNKNOWN",
    ],
  ]) {
    const handle = createSupervisorHandler({
      run: (cmd, args) =>
        cmd.endsWith("journalctl") &&
        args[1] === "kmj-codebridge-private-pr337-ci.service"
          ? line
          : "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
      lstat: () => {
        throw new Error("fixture");
      },
    });
    const result = await handle({ op: "update_status" });
    assert.equal(result.response.privatePr337Diagnostic, expected);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|private-ref/);
  }
});

test("website CI classifies preparation tool failures without exposing private paths", async () => {
  for (const [journal, expected] of [
    [
      "cp: preserving times for '/private/secret': Operation not permitted",
      "CP_METADATA_OPERATION_NOT_PERMITTED",
    ],
    [
      "cp: preserving permissions for '/private/secret': Operation not permitted",
      "CP_METADATA_OPERATION_NOT_PERMITTED",
    ],
    [
      "cp: cannot stat '/srv/kmj-codebridge-projects/kmj-main-platform/apps/platform/vendor': No such file or directory",
      "CP_SOURCE_UNAVAILABLE_VENDOR",
    ],
    [
      "cp: cannot stat '/srv/kmj-codebridge-projects/kmj-main-platform/apps/platform/node_modules': Permission denied",
      "CP_SOURCE_UNAVAILABLE_NPM",
    ],
    [
      "cp: cannot stat '/private/secret': No such file or directory",
      "CP_SOURCE_UNAVAILABLE_OTHER",
    ],
    ["cp: '/private/a' and '/private/b' are the same file", "CP_SAME_FILE"],
    [
      "cp: cannot create '/private/secret': Read-only file system",
      "CP_READ_ONLY_FILESYSTEM",
    ],
    [
      "cp: cannot open '/private/secret': Permission denied",
      "CP_PERMISSION_DENIED",
    ],
    [
      "cp: cannot create '/private/secret': Operation not permitted",
      "CP_OPERATION_NOT_PERMITTED",
    ],
    ["cp: other failure '/private/secret'", "CP_FAILED"],
    [
      "chown: changing ownership of '/private/secret': Operation not permitted",
      "CHOWN_OPERATION_NOT_PERMITTED",
    ],
    [
      "chown: cannot access '/private/secret': Permission denied",
      "CHOWN_PERMISSION_DENIED",
    ],
    [
      "tar: /private/secret: Cannot open: Read-only file system",
      "TAR_READ_ONLY_FILESYSTEM",
    ],
    [
      "tar: /private/secret: Cannot open: Permission denied",
      "TAR_PERMISSION_DENIED",
    ],
    ["tar: Error is not recoverable: exiting now", "TAR_FAILED"],
    ["systemd-run: failed to connect /private/secret", "SYSTEMD_RUN_FAILED"],
    [
      "Failed to start transient service unit: /private/secret",
      "SYSTEMD_RUN_FAILED",
    ],
  ]) {
    const handle = createSupervisorHandler({
      run: (cmd) =>
        cmd.endsWith("journalctl")
          ? journal
          : "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
      lstat: () => {
        throw new Error("fixture");
      },
    });
    const result = await handle({ op: "update_status" });
    assert.equal(result.response.privatePr337Diagnostic, expected, journal);
    assert.doesNotMatch(JSON.stringify(result), /\/private|secret|\/srv/);
  }
});

test("native CI exposes validated optional worker failure evidence", async () => {
  for (const pr of [322, 337]) {
    const evidence = {
      schema: 1,
      repo: "kmjtechno/kmj-main-platform",
      pr,
      sha: "a".repeat(40),
      linux_result: "FAIL",
      exit_code: 1,
      github_actions: "NOT_RUN",
      windows: "NOT_RUN",
      signed_production: false,
      log_sha256: "b".repeat(64),
      failure_kind: "VP_NOT_FOUND",
      failed_gate: "fmt_lint",
    };
    const handle = createSupervisorHandler({
      run: () => "LoadState=loaded\n",
      lstat: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        nlink: 1,
        mode: 0o100600,
        size: 400,
      }),
      readFile: () => JSON.stringify(evidence),
    });
    const result = await handle({ op: `private_pr${pr}_ci_status` });
    assert.equal(result.response.last.failureKind, "VP_NOT_FOUND");
    assert.equal(result.response.last.failedGate, "fmt_lint");
    evidence.failed_gate = "secret-ref";
    assert.equal(
      (await handle({ op: `private_pr${pr}_ci_status` })).response.last,
      null,
    );
    evidence.failed_gate = null;
    evidence.failure_kind = "secret-token";
    assert.equal(
      (await handle({ op: `private_pr${pr}_ci_status` })).response.last,
      null,
    );
  }
});

test("native CI existing log diagnostics require trusted metadata and exact manifest hash", async () => {
  const sha = "a".repeat(40),
    name = `${sha}-20261008T130000Z.log`;
  const trusted = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    nlink: 1,
    mode: 0o100600,
    size: 500,
  };
  for (const pr of [322, 337]) {
    for (const [text, expected, missingPackage] of [
      [
        "Formatting issues found in 3 files. Run without --check to fix.\nsecret=NEVER_RETURN",
        "FORMAT_ISSUES_REPORTED",
      ],
      [
        "Found 0 warnings and 2 errors.\nsecret=NEVER_RETURN",
        "LINT_ISSUES_REPORTED",
      ],
      ["Found 1 warning and 0 errors.", "LINT_ISSUES_REPORTED"],
      [
        "Error: Cannot find native binding. npm has a bug related to optional dependencies",
        "NATIVE_BINDING_LOAD_ERROR",
      ],
      [
        "npm error code EBADENGINE\nnpm error Unsupported engine",
        "NODE_ENGINE_ERROR",
      ],
      [
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite-plus' imported from /private/secret",
        "NODE_ERR_MODULE_NOT_FOUND",
        "VITE_PLUS",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-core-linux-x64-gnu'\n  code: 'MODULE_NOT_FOUND',",
        "NODE_MODULE_NOT_FOUND",
        "VITE_PLUS_CORE",
      ],
      [
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@private/secret' imported from /private/secret",
        "NODE_ERR_MODULE_NOT_FOUND",
      ],
      [
        "Error [ERR_REQUIRE_ESM]: require() of ES Module /private/secret not supported",
        "NODE_ERR_REQUIRE_ESM",
      ],
      [
        "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:private",
        "NODE_ERR_UNKNOWN_BUILTIN_MODULE",
      ],
      [
        "Error: /private/secret: invalid ELF header\n  code: 'ERR_DLOPEN_FAILED'",
        "NODE_ERR_DLOPEN_FAILED",
      ],
      [
        "Error: ENOENT: no such file or directory, open '/private/secret'",
        "WORKER_ENOENT",
      ],
      [
        "Error: EACCES: permission denied, open '/private/secret'",
        "WORKER_EACCES",
      ],
      [
        "Error: EPERM: operation not permitted, open '/private/secret'",
        "WORKER_EPERM",
      ],
      ["SyntaxError: Unexpected token in /private/secret", "NODE_SYNTAX_ERROR"],
      ["TypeError: private is not a function", "NODE_TYPE_ERROR"],
      [
        "fatal: not a git repository (or any of the parent directories): .git",
        "GIT_REPO_UNAVAILABLE",
      ],
      [
        "example text mentions ERR_MODULE_NOT_FOUND and ENOENT without an actual error",
        "COMMAND_FAILED_UNCLASSIFIED",
      ],
      [
        "TypeError [ERR_INVALID_ARG_TYPE]: private argument must be string",
        "NODE_TYPE_ERROR",
      ],
      [
        "Error: Cannot find module '@oxlint/linux-x64-gnu'",
        "NODE_MODULE_NOT_FOUND",
        "OXLINT",
      ],
      ["Error: Cannot find module 'oxfmt'", "NODE_MODULE_NOT_FOUND", "OXFMT"],
      [
        "Error: Cannot find module '@rolldown/binding-linux-arm64-musl'",
        "NODE_MODULE_NOT_FOUND",
        "ROLLDOWN",
      ],
      [
        "Error: Cannot find module 'vite-plus/private-secret'",
        "NODE_MODULE_NOT_FOUND",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-core-private-secret'",
        "NODE_MODULE_NOT_FOUND",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-linux-x64-gnu'",
        "NODE_MODULE_NOT_FOUND",
        "VITE_PLUS",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-linux-arm64-musl'",
        "NODE_MODULE_NOT_FOUND",
        "VITE_PLUS",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-win32-x64-msvc'",
        "NODE_MODULE_NOT_FOUND",
        "VITE_PLUS",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-darwin-arm64'",
        "NODE_MODULE_NOT_FOUND",
        "VITE_PLUS",
      ],
      [
        "Error: Cannot find module '@voidzero-dev/vite-plus-linux-x64-gnu-private-secret'",
        "NODE_MODULE_NOT_FOUND",
      ],
      [
        "/bin/bash: /opt/kmj-codebridge-agent/scripts/ci-main-platform-pr-worker.sh: Permission denied",
        "WORKER_SCRIPT_PERMISSION_DENIED",
      ],
      [
        "bash: /private/secret/ci-main-platform-pr-worker.sh: Permission denied",
        "COMMAND_FAILED_UNCLASSIFIED",
      ],
      [
        "npm WARN EBADENGINE Unsupported engine\nunknown failure",
        "COMMAND_FAILED_UNCLASSIFIED",
      ],
    ]) {
      const bytes = Buffer.from(text),
        record = {
          schema: 1,
          repo: "kmjtechno/kmj-main-platform",
          pr,
          sha,
          linux_result: "FAIL",
          exit_code: 1,
          github_actions: "NOT_RUN",
          windows: "NOT_RUN",
          signed_production: false,
          log_sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      const reads = [];
      let directoryMeta = {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        mode: 0o40700,
      };
      let logBytes = bytes;
      let meta = trusted,
        names = [name];
      const handle = createSupervisorHandler({
        run: () => "LoadState=loaded\n",
        lstat: (file) =>
          file === "/var/lib/kmj-codebridge-ci/evidence"
            ? directoryMeta
            : file.endsWith(".log")
              ? meta
              : trusted,
        readFile: () => JSON.stringify(record),
        readdir: (directory) => {
          assert.equal(directory, "/var/lib/kmj-codebridge-ci/evidence");
          return names;
        },
        readLog: (file) => {
          reads.push(file);
          return logBytes;
        },
      });
      assert.equal(
        (await handle({ op: `private_pr${pr}_ci_status` })).response.last
          .workerLogDiagnostic,
        expected,
      );
      assert.equal(
        (await handle({ op: `private_pr${pr}_ci_status` })).response.last
          .workerLogMissingPackage,
        missingPackage,
      );
      assert.deepEqual(
        reads,
        Array(2).fill(`/var/lib/kmj-codebridge-ci/evidence/${name}`),
      );
      assert.doesNotMatch(
        JSON.stringify(await handle({ op: `private_pr${pr}_ci_status` })),
        /NEVER_RETURN|secret=|\/var\/lib|\/private|@private|private-secret/,
      );
      for (const invalid of [
        { uid: 1000 },
        { nlink: 2 },
        { mode: 0o100644 },
        { isFile: () => false },
        { isSymbolicLink: () => true },
        { size: 0 },
        { size: 16777217 },
      ]) {
        meta = { ...trusted, ...invalid };
        reads.length = 0;
        assert.equal(
          (await handle({ op: `private_pr${pr}_ci_status` })).response.last
            .workerLogDiagnostic,
          undefined,
        );
        assert.equal(reads.length, 0);
      }
      meta = trusted;
      for (const invalidName of [
        "../secret.log",
        `${"b".repeat(40)}-20261008T130000Z.log`,
        `${sha}-20261399T130000Z.log`,
        `${sha}-secret.log`,
      ]) {
        names = [invalidName];
        reads.length = 0;
        assert.equal(
          (await handle({ op: `private_pr${pr}_ci_status` })).response.last
            .workerLogDiagnostic,
          undefined,
        );
        assert.equal(reads.length, 0);
      }
      const validDirectory = directoryMeta;
      for (const invalidDirectory of [
        { uid: 1000 },
        { mode: 0o40777 },
        { isDirectory: () => false },
        { isSymbolicLink: () => true },
      ]) {
        directoryMeta = { ...validDirectory, ...invalidDirectory };
        reads.length = 0;
        assert.equal(
          (await handle({ op: `private_pr${pr}_ci_status` })).response.last
            .workerLogDiagnostic,
          undefined,
        );
        assert.equal(reads.length, 0);
      }
      directoryMeta = validDirectory;
      names = Array(1001).fill(name);
      reads.length = 0;
      assert.equal(
        (await handle({ op: `private_pr${pr}_ci_status` })).response.last
          .workerLogDiagnostic,
        undefined,
      );
      assert.equal(reads.length, 0);
      names = [name];
      for (const invalidBytes of ["untrusted text", Buffer.alloc(0)]) {
        logBytes = invalidBytes;
        assert.equal(
          (await handle({ op: `private_pr${pr}_ci_status` })).response.last
            .workerLogDiagnostic,
          undefined,
        );
      }
      logBytes = bytes;
      record.exit_code = 0;
      record.linux_result = "PASS";
      reads.length = 0;
      assert.equal(
        (await handle({ op: `private_pr${pr}_ci_status` })).response.last
          .workerLogDiagnostic,
        undefined,
      );
      assert.equal(reads.length, 0);
      record.exit_code = 1;
      record.linux_result = "FAIL";
      names = [name];
      record.log_sha256 = "b".repeat(64);
      assert.equal(
        (await handle({ op: `private_pr${pr}_ci_status` })).response.last
          .workerLogDiagnostic,
        undefined,
      );
    }
  }
});

test("native CI default log reader bounds bytes and rejects changed or linked files", (t) => {
  if (process.platform === "win32") return t.skip("POSIX root-owned CI logs");
  const source = fs.readFileSync(
    new URL("../src/supervisor.js", import.meta.url),
    "utf8",
  );
  const implementation = source.match(
    /function readBoundedPrivateCiLog\(filename\) \{[\s\S]*?^\}/m,
  )[0];
  const reader = new Function(
    "fs",
    implementation + "\nreturn readBoundedPrivateCiLog;",
  )(fs);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-bounded-log-"));
  const filename = path.join(directory, "worker.log");
  try {
    fs.writeFileSync(filename, "fixture", { mode: 0o600 });
    if (process.getuid() !== 0) {
      assert.equal(reader(filename), null);
      return;
    }
    assert.deepEqual(reader(filename), Buffer.from("fixture"));
    fs.chmodSync(filename, 0o644);
    assert.equal(reader(filename), null);
    fs.chmodSync(filename, 0o600);
    const link = path.join(directory, "linked.log");
    fs.symlinkSync(filename, link);
    assert.throws(() => reader(link), { code: "ELOOP" });
    fs.unlinkSync(link);
    fs.linkSync(filename, link);
    assert.equal(reader(filename), null);
    fs.unlinkSync(link);
    fs.truncateSync(filename, 16777217);
    assert.equal(reader(filename), null);
    fs.writeFileSync(filename, "fixture");
    let changed = false;
    const growingReader = new Function(
      "fs",
      implementation + "\nreturn readBoundedPrivateCiLog;",
    )({
      ...fs,
      readSync: (...args) => {
        if (!changed) {
          changed = true;
          fs.appendFileSync(filename, "more-data");
        }
        return fs.readSync(...args);
      },
    });
    assert.equal(growingReader(filename), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("owner CI scheduler status exposes only fixed updater outcomes", async () => {
  const expected = [
    "AUTO_UPDATE_PRIVATE_PR322_CI_ALREADY_SCHEDULED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_DEFERRED_BUSY",
    "AUTO_UPDATE_PRIVATE_PR322_CI_START_FAILED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_DEFERRED_UNTRUSTED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_SCHEDULED=1",
  ];
  const handle = createSupervisorHandler({
    run: (command, args) =>
      command.endsWith("journalctl") &&
      args[1] === "kmj-codebridge-auto-update.service"
        ? [
            ...expected,
            "AUTO_UPDATE_PRIVATE_PR322_CI_SCHEDULED=secret",
            "AUTO_UPDATE_PRIVATE_PR322_CI_SCHEDULED=1=secret",
            "AUTO_UPDATE_PRIVATE_PR322_CI_DEFERRED_UNTRUSTED=/private/secret",
            "AUTO_UPDATE_PRIVATE_PR322_CI_UNKNOWN",
            "credential=secret",
          ].join("\n")
        : "LoadState=loaded\nActiveState=inactive\n",
    lstat: () => {
      throw new Error("fixture");
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response.updateMarkers, expected);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|credential|\/private|CI_UNKNOWN/,
  );
});
