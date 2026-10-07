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
  assert.match(
    refresh,
    /CONFIG_DIR="\/etc\/kmj-codebridge-main-platform"/,
  );
  assert.match(refresh, /CODEBRIDGE_RUNTIME="\$RUNTIME"/);
  assert.match(refresh, /bash "\$SETUP"/);
  assert.doesNotMatch(refresh, /enroll-device\.js/);
  assert.doesNotMatch(refresh, /CODEBRIDGE_AGENT_TOKEN/);
});

test("installer provisions a rollback-safe fixed Main Platform refresh unit", () => {
  assert.match(
    installer,
    /MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh\.service"/,
  );
  assert.match(
    installer,
    /ConditionPathExists=\/etc\/kmj-codebridge-main-platform\/agent\.json/,
  );
  assert.match(
    installer,
    /ConditionPathExists=\/srv\/kmj-codebridge-projects\/kmj-main-platform\/\.git/,
  );
  assert.match(
    installer,
    /ExecStart=\/bin\/bash \$INSTALL_DIR\/scripts\/refresh-main-platform-agent\.sh/,
  );
  assert.match(installer, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(
    installer,
    /ReadWritePaths=\/etc\/kmj-codebridge-main-platform \/etc\/systemd\/system \/var\/lib\/kmj-codebridge-kmj-main-platform \/srv\/kmj-codebridge-projects\/kmj-main-platform/,
  );
  assert.match(installer, /ROLLBACK_MAIN_PLATFORM_REFRESH/);
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
  assert.equal(definitions.supervisor_main_platform_refresh_status.access, "read");
  assert.equal(definitions.supervisor_main_platform_refresh.access, "execute");
  assert.deepEqual(
    Object.keys(definitions.supervisor_main_platform_refresh.input).sort(),
    ["device", "project"],
  );
});
