import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const repair = fs.readFileSync(
  "scripts/production/repair-node24-and-bootstrap-supervisor.sh",
  "utf8",
);
test("one-step supervisor Node repair is root and host gated", () => {
  assert.match(repair, /ROOT_AND_HOST_REQUIRED/);
  assert.match(repair, /OPT_NODE_UNSAFE_DO_NOT_OVERWRITE/);
  assert.match(repair, /UNSAFE_NODE_PARENT/);
  assert.match(repair, /NODE_CHECKSUM_FAILED/);
  assert.match(repair, /7d2aad1d64c380f332e6791347d84bac115d5279/);
  assert.match(repair, /KMJ_APPROVED_CODEBRIDGE_SHA/);
  assert.match(repair, /LIVE_MCP_VERIFICATION_STILL_REQUIRED/);
  assert.doesNotMatch(repair, /curl[^\n]*\|\s*(?:sudo\s+)?bash|apt-get\s+upgrade|npm\s+install\s+-g|sudoers|systemctl\s+restart/);
});
test("Node 24 v24.21.0 package SHA256 is pinned by architecture", () => {
  assert.match(repair, /fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6/);
  assert.match(repair, /6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2/);
  assert.match(repair, /sha256sum -c -/);
  assert.match(repair, /--no-same-owner --no-same-permissions/);
  assert.match(repair, /--detach "\$SHA"/);
});
test("root-only repair script passes bash syntax", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("bash", ["-n", "scripts/production/repair-node24-and-bootstrap-supervisor.sh"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
