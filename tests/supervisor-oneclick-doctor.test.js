import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const windows = "scripts/windows/P520-SUPERVISOR-ONECLICK-DOCTOR.ps1";
const elite = "scripts/production/owner_oneclick_elite_dev_supervisor.py";

test("Windows one-click doctor is read-only, bounded and checks HMAC before hardware", () => {
  const source = fs.readFileSync(windows, "utf8");
  assert.match(source, /PIPE_RESPONSE_OVERSIZED/);
  assert.match(source, /PIPE_RESPONSE_TIMEOUT/);
  assert.match(source, /TASK_ARGUMENTS_MISMATCH/);
  assert.match(source, /TOKEN_ACL_UNSAFE_PRINCIPAL/);
  assert.match(source, /SUPERVISOR_UNAUTHENTICATED/);
  assert.match(source, /P520_HARDWARE_RPC=PASS_LOCAL_ONLY/);
  for (const marker of [
    "TASK_RUNTIME_REVISION_INVALID",
    "TASK_ARGUMENTS_MISMATCH",
    "P520_SETUP=REMOTE_AGENT_READBACK_REQUIRED",
    "Remove-Variable token",
  ]) {
    assert.equal(source.split(marker).length, 2, marker);
  }
  assert.doesNotMatch(
    source,
    /(?:Start|Stop|Register|Unregister|Enable|Disable)-ScheduledTask/,
  );
  assert.ok(
    source.indexOf("NEGATIVE_HMAC_CHECK_FAILED") <
      source.indexOf("HARDWARE_STATUS_FAILED"),
  );
});

test(
  "Windows one-click doctor parses under actual Windows PowerShell",
  { skip: process.platform !== "win32" },
  () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" +
          windows +
          "',[ref]$t,[ref]$e);if($e.Count){$e | ForEach-Object { [Console]::Error.WriteLine($_.ErrorId + ' at line ' + $_.Extent.StartLineNumber) };exit 2}",
      ],
      { timeout: 15000, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "Elite one-click entrypoint rejects unapproved arguments without host mutations",
  { skip: process.platform === "win32" },
  () => {
    for (const args of [["--apply"], ["--apply", "--force"], ["--restart"]]) {
      const result = spawnSync("python3", ["-I", "-B", elite, ...args], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 2);
      assert.match(result.stdout, /ONECLICK_BLOCKER=ONECLICK_ARGUMENTS_DENIED/);
      assert.match(result.stdout, /ONECLICK_SETUP=BLOCKED_NO_LIVE_CREDIT/);
    }
  },
);
