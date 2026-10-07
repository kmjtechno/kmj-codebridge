import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync("scripts/auto-update-development.sh", "utf8");

test("development auto updater is shell-valid on Linux", (t) => {
  if (process.platform === "win32") {
    t.skip("bash syntax check runs on Linux CI");
    return;
  }
  const checked = spawnSync(
    "bash",
    ["-n", "scripts/auto-update-development.sh"],
    { encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr);
});

test("development auto updater is pinned to the canonical repository and fast-forward only", () => {
  assert.match(
    script,
    /REPO="https:\/\/github\.com\/kmjtechno\/kmj-codebridge\.git"/,
  );
  assert.match(script, /refs\/heads\/\$BRANCH/);
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /AUTO_UPDATE_NON_FAST_FORWARD/);
  assert.match(script, /AUTO_UPDATE_ORIGIN_MISMATCH/);
});

test("development auto updater preserves project enrollment and defers active jobs", () => {
  assert.match(script, /AUTO_UPDATE_DEFERRED_ACTIVE_JOB/);
  assert.match(script, /j\.state==="running"\|\|j\.state==="queued"/);
  assert.match(script, /--project "\$PROJECT_ROOT"/);
  assert.match(script, /--project-id "\$PROJECT_ID"/);
  assert.match(script, /--device "\$DEVICE"/);
  assert.match(script, /--service-user "\$SERVICE_USER"/);
  assert.match(script, /--ref "\$remote"/);
  assert.match(script, /c\.gateway/);
  assert.match(script, /GATEWAY="\$\{cfg\[4\]\}"/);
  assert.match(script, /CODEBRIDGE_GATEWAY="\$GATEWAY"/);
});

test("development auto updater refreshes an existing Main Platform enrollment without caller input", () => {
  assert.match(
    script,
    /MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh\\.service"/,
  );
  assert.match(
    script,
    /-f \\/etc\\/kmj-codebridge-main-platform\\/agent\\.json/,
  );
  assert.match(
    script,
    /-d \\/srv\\/kmj-codebridge-projects\\/kmj-main-platform\\/\\.git/,
  );
  assert.match(
    script,
    /systemctl start --no-block "\\$MAIN_PLATFORM_REFRESH_SERVICE"/,
  );
  assert.doesNotMatch(script, /CODEBRIDGE_AGENT_TOKEN/);
});

test("development auto updater refuses dirty runtime and does not accept caller repository URLs", () => {
  assert.match(script, /AUTO_UPDATE_DIRTY_RUNTIME/);
  assert.doesNotMatch(script, /CODEBRIDGE_UPDATE_REPO/);
  assert.doesNotMatch(script, /curl\s+[^\n]*\|\s*(?:sh|bash)/);
});

test("VPS installer provisions a bounded auto-update timer", () => {
  const installer = fs.readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(installer, /kmj-codebridge-auto-update\.service/);
  assert.match(installer, /kmj-codebridge-auto-update\.timer/);
  assert.match(installer, /OnBootSec=5min/);
  assert.match(installer, /OnUnitActiveSec=1h/);
  assert.match(installer, /RandomizedDelaySec=10min/);
  assert.match(installer, /Persistent=true/);
  assert.match(installer, /CODEBRIDGE_AUTO_UPDATE_MODE:-development/);
  assert.match(installer, /systemctl enable --now "\$AUTO_UPDATE_TIMER"/);
});
