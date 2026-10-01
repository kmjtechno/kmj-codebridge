import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

test("VPS installer is shell-valid and never prints the agent credential", (t) => {
  if (process.platform === "win32") {
    t.skip("bash syntax check runs on Linux CI");
    return;
  }
  const script = fs.readFileSync("scripts/install-vps.sh", "utf8");
  const checked = spawnSync("bash", ["-n", "scripts/install-vps.sh"], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(script, /sha256sum -c/);
  assert.match(script, /NoNewPrivileges=true/);
  assert.match(script, /ProtectSystem=strict/);
  assert.doesNotMatch(script, /echo .*CODEBRIDGE_AGENT_TOKEN/);
  assert.doesNotMatch(script, /echo .*\$TOKEN/);
});

test("VPS installer defaults to the production HTTPS gateway and Node 24", () => {
  const script = fs.readFileSync("scripts/install-vps.sh", "utf8");
  assert.match(script, /https:\/\/kmjtechno\.com/);
  assert.match(script, /24\.21\.0/);
  assert.match(script, /nodejs\.org\/download\/release/);
});
