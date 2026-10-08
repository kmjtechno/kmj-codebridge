import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createSupervisorHandler } from "../src/supervisor.js";
import { definitions } from "../src/tools.js";

const refresh = fs.readFileSync(
  "scripts/refresh-main-platform-agent.sh",
  "utf8",
);
const installer = fs.readFileSync("scripts/install-vps.sh", "utf8");
const setup = fs.readFileSync("scripts/setup-main-platform-agent.sh", "utf8");

test("Main Platform refresh wrapper is fixed to an existing enrollment", (t) => {
  if (process.platform !== "win32") {
    const checked = spawnSync(
      "bash",
      ["-n", "scripts/refresh-main-platform-agent.sh"],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
  } else {
    t.diagnostic("bash syntax is covered on Linux CI");
  }
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_REQUIRES_EXISTING_ENROLLMENT/);
  assert.match(
    refresh,
    /PROJECT_ROOT="\/srv\/kmj-codebridge-projects\/kmj-main-platform"/,
  );
  assert.match(refresh, /CONFIG_DIR="\/etc\/kmj-codebridge-main-platform"/);
  assert.match(refresh, /CODEBRIDGE_RUNTIME="\$RUNTIME"/);
  assert.match(refresh, /stage-main-platform-runtime\.js/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_STAGE_READY=1/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_STAGE_FAILED/);
  assert.match(
    refresh,
    /CODEBRIDGE_RUNTIME="\$STAGED_RUNTIME"/,
  );
  assert.ok(refresh.includes("[a-f0-9]{40}"));

  assert.match(refresh, /bash "\$SETUP"/);
  assert.doesNotMatch(refresh, /enroll-device\.js/);
  assert.doesNotMatch(refresh, /CODEBRIDGE_AGENT_TOKEN/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_PROJECT_MISSING/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_RUNTIME_INVALID/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_REQUIRES_EXISTING_ENROLLMENT/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_UNSAFE_CONFIG/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_LEGACY_CONFIG_MIGRATED/);
  assert.match(refresh, /MAIN_PLATFORM_REFRESH_LEGACY_UNSAFE/);
  assert.match(refresh, /O_EXCL/);
  assert.match(refresh, /O_NOFOLLOW/);
  assert.match(refresh, /fs\.realpathSync\(c\.projects\[0\]\.root\)/);
  assert.match(refresh, /c\.stateDir !== process\.env\.STATE_DIR/);
  assert.doesNotMatch(refresh, /rm -rf "\$LEGACY_CONFIG"/);
});

test("installer provisions a rollback-safe fixed Main Platform refresh unit", () => {
  assert.match(
    installer,
    /MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh\.service"/,
  );
  assert.doesNotMatch(
    installer,
    /ConditionPathExists=\|\/etc\/kmj-codebridge-main-platform\/agent\.json/,
  );
  assert.doesNotMatch(
    installer,
    /ConditionPathExists=\|\/etc\/kmj-codebridge\/agents\/kmj-main-platform\.json/,
  );
  assert.doesNotMatch(
    installer,
    /ConditionPathExists=\/srv\/kmj-codebridge-projects\/kmj-main-platform\/\.git/,
  );
  assert.match(
    installer,
    /ExecStart=\/bin\/bash \$INSTALL_DIR\/scripts\/refresh-main-platform-agent\.sh/,
  );
  assert.match(installer, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(installer, /MAIN_PLATFORM_STAGE_ROOT=\/opt\/kmj-codebridge-main-platform-stage/);
  assert.match(installer, /MAIN_PLATFORM_STAGE_DIR_UNSAFE/);
  assert.match(
    installer,
    /ReadWritePaths=.*\/opt\/kmj-codebridge-main-platform-stage/,
  );

  assert.match(
    installer,
    /ReadWritePaths=\/etc\/kmj-codebridge-main-platform \/etc\/systemd\/system \/var\/lib\/kmj-codebridge-kmj-main-platform \/srv\/kmj-codebridge-projects\/kmj-main-platform/,
  );
  assert.match(installer, /ROLLBACK_MAIN_PLATFORM_REFRESH/);
});

test("existing Main Platform agent requires a bounded job-safe restart and rollback", (t) => {
  if (process.platform !== "win32") {
    const checked = spawnSync(
      "bash",
      ["-n", "scripts/setup-main-platform-agent.sh"],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
  } else {
    t.diagnostic("Bash parser verified by Linux CI");
  }
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_ACTIVE_JOB"));
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_JOURNAL_UNSAFE"));
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_STATE_MISMATCH"));
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_ARCHIVE_UNSAFE"));
  assert.ok(setup.includes('systemctl restart "$SERVICE"'));
  assert.ok(setup.includes('systemctl enable "$SERVICE"'));
  assert.ok(setup.includes("UNIT_BACKUP"));
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_FAILED_ROLLBACK_ATTEMPTED"));
  assert.ok(
    setup.includes("MAIN_PLATFORM_RUNTIME_NOT_ACCESSIBLE_TO_SERVICE_USER"),
  );
  assert.ok(setup.includes('runuser -u "$SERVICE_USER" -- test -x "$NODE"'));
  assert.ok(
    setup.includes(
      'runuser -u "$SERVICE_USER" -- test -r "$RUNTIME/src/cli.js"',
    ),
  );
  assert.ok(setup.includes("MAIN_PLATFORM_RESTART_EFFECTIVE_UNIT_CONFLICT"));
  assert.ok(
    setup.includes('systemctl show "$SERVICE" -p WorkingDirectory --value'),
  );
  assert.ok(setup.includes('systemctl show "$SERVICE" -p ExecStart --value'));
  assert.ok(setup.includes("MAIN_PLATFORM_AGENT_RESTARTED=1"));
  assert.doesNotMatch(setup, /systemctl enable --now "\$SERVICE"/);
});

test("Supervisor can start only the fixed Main Platform refresh unit", async () => {
  const started = [];
  const handle = createSupervisorHandler({
    run: () =>
      "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n",
    start: (unit) => started.push(unit),
  });
  const status = await handle({ op: "main_platform_refresh_status" });
  assert.equal(status.response.available, true);
  assert.equal(status.response.service.installed, true);

  const refreshRequest = await handle({ op: "main_platform_refresh" });
  assert.deepEqual(refreshRequest.response, { accepted: true });
  assert.deepEqual(started, []);
  refreshRequest.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-main-platform-refresh.service"]);

  await assert.rejects(
    handle({ op: "main_platform_refresh", service: "ssh.service" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("Main Platform refresh fails closed when its fixed unit is absent", async () => {
  const handle = createSupervisorHandler({
    run: () => "LoadState=not-found\nActiveState=inactive\nSubState=dead\n",
  });
  await assert.rejects(
    handle({ op: "main_platform_refresh" }),
    /SUPERVISOR_MAIN_PLATFORM_REFRESH_UNAVAILABLE/,
  );
});

test("MCP refresh controls preserve read versus execute policy", () => {
  assert.equal(
    definitions.supervisor_main_platform_refresh_status.access,
    "read",
  );
  assert.equal(definitions.supervisor_main_platform_refresh.access, "execute");
  assert.deepEqual(
    Object.keys(definitions.supervisor_main_platform_refresh.input).sort(),
    ["device", "project"],
  );
});
