import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const linux = fs.readFileSync("scripts/one-click-linux-device.sh", "utf8");
const linuxEntry = fs.readFileSync("KMJ-ONE-CLICK.sh", "utf8");
const windows = fs.readFileSync("KMJ-ONE-CLICK.cmd", "utf8");
const windowsStage = fs.readFileSync(
  "scripts/windows/ONE-CLICK-ISOLATED-DEVICE.ps1",
  "utf8",
);
const windowsEntry = fs.readFileSync(
  "scripts/windows/CONNECT-ANY-DEVICE.cmd",
  "utf8",
);
const windowsWizard = fs.readFileSync(
  "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1",
  "utf8",
);

test("universal device entry reuses approved browser pairing rather than a P520-only installer", () => {
  assert.match(windows, /scripts\\windows\\ONE-CLICK-ISOLATED-DEVICE\.ps1/);
  assert.match(windowsEntry, /ONE-CLICK-ANY-DEVICE\.ps1/);
  assert.match(windowsWizard, /OWNER_BROWSER_APPROVAL_REQUIRED/);
  assert.match(windowsWizard, /EXISTING_PROJECT_AGENT_AUTO_SELECTED/);
  assert.match(linuxEntry, /scripts\/one-click-linux-device\.sh/);
  assert.match(linux, /scripts\/install-vps\.sh/);
  assert.match(linux, /NEW_OWNER_BROWSER_PAIRING/);
  assert.doesNotMatch(
    windows,
    /P520-OWNER-DISABLED-RESUME|ONE-CLICK-P520-ACTIVATE|Enable-ScheduledTask|sc\.exe|schtasks|git reset|git clean/i,
  );
});

test("Windows clean runtime staging is exact-head, isolated and non-destructive", () => {
  assert.match(windowsStage, /SOURCE_ORIGIN_INVALID/);
  assert.match(windowsStage, /ENTRY_SOURCE_MODIFIED/);
  assert.match(windowsStage, /STAGED_SHA_MISMATCH/);
  assert.match(windowsStage, /STAGED_RUNTIME_DIRTY/);
  assert.match(windowsStage, /hash-object/);
  assert.match(windowsStage, /--no-checkout --quiet/);
  assert.match(windowsStage, /checkout --quiet --detach \$sha/);
  assert.match(windowsStage, /ci --omit=dev --ignore-scripts/);
  assert.match(windowsStage, /ONE-CLICK-ANY-DEVICE\.ps1/);
  assert.doesNotMatch(
    windowsStage,
    /git\s+reset|git\s+clean|Stop-Process|Enable-ScheduledTask|Start-ScheduledTask|Set-Content|agent\.json\.proposed/,
  );
});

test("Linux universal path preserves existing enrollment and never overwrites a running agent", () => {
  assert.match(linux, /EXISTING_ACTIVE_NO_MUTATION/);
  assert.match(linux, /EXISTING_AGENT_INACTIVE_REPAIR_REVIEW_REQUIRED/);
  assert.match(linux, /EXISTING_ENROLLMENT_SCOPE_MISMATCH/);
  assert.match(linux, /PREEXISTING_SERVICE_WITHOUT_CONFIG/);
  assert.match(linux, /UNTRUSTED_CODEBRIDGE_ORIGIN/);
  assert.match(linux, /SOURCE_TRACKED_CHANGES/);
  assert.match(linux, /--ref "\$head"/);
  assert.match(linux, /CHECK_AUTHENTICATED_CONNECTION_OVERVIEW/);
  assert.doesNotMatch(
    linux,
    /rm -rf|git\s+reset|git\s+clean|cat\s+["']?\$cfg|systemctl\s+stop|systemctl\s+restart|curl.*\|\s*(sudo\s+)?bash/,
  );
});

test(
  "Linux universal launcher validates syntax and selftest without modifying host",
  { skip: process.platform === "win32" },
  () => {
    for (const script of [
      "KMJ-ONE-CLICK.sh",
      "scripts/one-click-linux-device.sh",
    ]) {
      const check = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
    }
    const check = spawnSync(
      "bash",
      ["scripts/one-click-linux-device.sh", "--self-test"],
      { encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /KMJ_UNIVERSAL_LINUX_SELFTEST=PASS/);
  },
);

test(
  "Linux existing-agent scope checker compiles and restricts gateways to HTTPS or loopback",
  { skip: process.platform === "win32" },
  () => {
    const block = linux.match(
      /python3 - "\$cfg" "\$project" "\$project_id" <<'PY'\n([\s\S]*?)\nPY/,
    );
    assert.ok(block, "missing embedded config scope verifier");
    assert.match(block[1], /127\.0\.0\.1/);
    assert.match(block[1], /not isinstance\(c\.get\("token"\),str\)/);
    const checked = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<config-verifier>', 'exec')"],
      { input: block[1], encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
  },
);

test(
  "Windows universal pairing native selftest passes before any owner enrollment",
  { skip: process.platform !== "win32" },
  () => {
    const check = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1",
        "-SelfTest",
      ],
      { encoding: "utf8" },
    );
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /KMJ_UNIVERSAL_SELFTEST=PASS/);
    const stage = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        "scripts/windows/ONE-CLICK-ISOLATED-DEVICE.ps1",
        "-SelfTest",
      ],
      { encoding: "utf8" },
    );
    assert.equal(stage.status, 0, stage.stderr || stage.stdout);
    assert.match(stage.stdout, /KMJ_UNIVERSAL_WINDOWS_STAGE_SELFTEST=PASS/);
  },
);
