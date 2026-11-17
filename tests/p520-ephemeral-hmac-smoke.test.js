import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const smoke = fs.readFileSync(
  "scripts/windows/P520-SUPERVISOR-EPHEMERAL-HMAC-SMOKE-20261117.mjs",
  "utf8",
);

test("P520 isolated HMAC smoke fail-closes and does not enable tasks", () => {
  assert.match(smoke, /b652b29beafb9b14e42b0078bfb9571fef5b3271/);
  assert.match(smoke, /runWindowsSupervisorCli\(configFile\)/);
  assert.match(smoke, /"SUPERVISOR_UNAUTHENTICATED"/);
  assert.match(smoke, /P520_HMAC_AUTHENTICATED_STATUS=PASS/);
  assert.match(smoke, /P520_HMAC_AUTHENTICATED_CONFIG=PASS/);
  assert.match(smoke, /P520_NO_RESTART_CAPABILITY=PASS/);
  assert.match(smoke, /if \(server\) await server\.close\(\)/);
  assert.match(smoke, /"restartTask" in \(config\.agent \?\? \{\}\)/);
  assert.doesNotMatch(
    smoke,
    /Start-ScheduledTask|Enable-ScheduledTask|Restart-Service|Restart-Computer|child_process|execFile|spawn\(/,
  );
  assert.doesNotMatch(
    smoke,
    /agent\.json\.proposed|writeFile|rmSync|unlinkSync/,
  );
});
