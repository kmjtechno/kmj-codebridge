import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync("scripts/auto-update-user.sh", "utf8");

test("rootless development updater is shell-valid on Linux", (t) => {
  if (process.platform === "win32") {
    t.skip("bash syntax check runs on Linux CI");
    return;
  }
  const checked = spawnSync("bash", ["-n", "scripts/auto-update-user.sh"], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test("rootless updater is canonical, fast-forward only and preserves config", () => {
  assert.match(
    script,
    /REPO="https:\/\/github\.com\/kmjtechno\/kmj-codebridge\.git"/,
  );
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /ROOTLESS_UPDATE_NON_FAST_FORWARD/);
  assert.match(script, /ROOTLESS_UPDATE_ORIGIN_MISMATCH/);
  assert.match(script, /ROOTLESS_UPDATE_DIRTY_RUNTIME/);
  assert.match(script, /agent\.json/);
});

test("rootless updater verifies before swap and rolls back failed reconnect", () => {
  assert.match(script, /"\$NPM" --prefix "\$NEW" run check/);
  assert.match(script, /"\$NPM" --prefix "\$NEW" test/);
  assert.match(script, /ROOTLESS_UPDATE_DEFERRED_ACTIVE_JOB/);
  assert.match(script, /ROOTLESS_UPDATE_PID_MISMATCH/);
  assert.match(script, /ROOTLESS_UPDATE_ROLLED_BACK/);
  assert.match(script, /connection\.json/);
  assert.match(script, /mv "\$ROLLBACK" "\$RUNTIME"/);
});

test("rootless updater never accepts an alternate repository from environment", () => {
  assert.doesNotMatch(script, /CODEBRIDGE_UPDATE_REPO/);
  assert.doesNotMatch(script, /curl\s+[^\n]*\|\s*(?:sh|bash)/);
});
