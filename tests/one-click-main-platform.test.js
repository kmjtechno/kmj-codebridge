import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const oneClick = fs.readFileSync("scripts/one-click-main-platform.sh", "utf8");
const setup = fs.readFileSync("scripts/setup-main-platform-agent.sh");

test("Main Platform one-click script is shell-valid on Linux", (t) => {
  if (process.platform === "win32") {
    t.skip("bash syntax check runs on Linux CI");
    return;
  }
  const checked = spawnSync(
    "bash",
    ["-n", "scripts/one-click-main-platform.sh"],
    { encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr);
});

test("one-click bootstrap executes only a hash-verified immutable setup script", () => {
  const revision = /SETUP_REVISION='([a-f0-9]{40})'/.exec(oneClick)?.[1];
  const expectedHash = /SETUP_SHA256='([a-f0-9]{64})'/.exec(oneClick)?.[1];
  assert.ok(revision);
  assert.ok(expectedHash);
  assert.equal(createHash("sha256").update(setup).digest("hex"), expectedHash);
  assert.match(
    oneClick,
    /raw\.githubusercontent\.com\/kmjtechno\/kmj-codebridge\/\$SETUP_REVISION\/scripts\/setup-main-platform-agent\.sh/,
  );
  assert.match(oneClick, /sha256sum -c -/);
  assert.match(oneClick, /--proto '=https'/);
  assert.match(oneClick, /--tlsv1\.2/);
  assert.doesNotMatch(oneClick, /curl[^\n]*\|[^\n]*bash/);

  const download = oneClick.indexOf("curl -fsSL");
  const verify = oneClick.indexOf("sha256sum -c -");
  const execute = oneClick.indexOf('bash "$SETUP_SCRIPT"');
  assert.ok(download >= 0 && download < verify && verify < execute);
});

test("one-click setup preserves enrollment and limits GitHub authorization", () => {
  assert.match(oneClick, /read_only=true/);
  assert.match(oneClick, /GH_CONFIG_DIR=.*mktemp/);
  assert.match(oneClick, /cleanup_gh/);
  assert.match(oneClick, /Preserving unexpected target at:/);
  assert.match(oneClick, /repo_ok/);
  assert.doesNotMatch(oneClick, /CODEBRIDGE_AGENT_TOKEN/);
  assert.doesNotMatch(oneClick, /github.*token/i);
});
