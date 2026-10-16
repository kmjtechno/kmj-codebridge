import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

const install = fs.readFileSync(
  "scripts/windows/install-windows-supervisor.ps1",
  "utf8",
);
const rollback = fs.readFileSync(
  "scripts/windows/rollback-windows-supervisor.ps1",
  "utf8",
);

test("install script is dry-run by default and never activates the runtime", () => {
  assert.match(install, /\[switch\]\$Apply/);
  assert.match(install, /if \(-not \$Apply\)[\s\S]*return/);
  for (const forbidden of [
    /Start-ScheduledTask/i,
    /Start-Service/i,
    /Restart-Service/i,
    /Enable-ScheduledTask/i,
    /Invoke-Expression/i,
    /\biex\b/i,
    /-ExecutionPolicy\s+Bypass/i,
    /Set-Content\s+-LiteralPath\s+\$AgentConfig\b/,
  ])
    assert.doesNotMatch(install, forbidden, String(forbidden));
  assert.match(install, /Disable-ScheduledTask/);
  assert.match(install, /\.proposed/);
});

test("install script backs up with hashes and restricts the token ACL", () => {
  assert.match(install, /Get-FileHash -Algorithm SHA256/);
  assert.match(install, /manifest\.json/);
  assert.match(install, /icacls\.exe \$tokenFile \/inheritance:r/);
  assert.match(install, /Authenticated Users/);
});

test("rollback verifies the backup first and is dry-run by default", () => {
  assert.match(rollback, /\[switch\]\$Apply/);
  assert.ok(
    rollback.indexOf("Backup file changed or corrupt") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.match(rollback, /RestoreConfigs/);
  assert.doesNotMatch(rollback, /Remove-Item[^\n]*-Recurse/i);
  assert.doesNotMatch(rollback, /Start-ScheduledTask|Enable-ScheduledTask/i);
});

test("scripts are ASCII only so Windows PowerShell 5.1 parses them identically", () => {
  for (const text of [install, rollback]) assert.ok(!/[^\x00-\x7f]/.test(text));
});

test("installer refuses existing tasks, token ACL mutation, and stale agent proposals", () => {
  assert.match(install, /TASK_ALREADY_EXISTS/);
  assert.match(install, /TOKEN_ALREADY_EXISTS/);
  assert.match(install, /PROPOSED_AGENT_CONFIG_EXISTS/);
  assert.match(install, /AGENT_SUPERVISOR_ALREADY_CONFIGURED/);
  assert.match(install, /BACKUP_DESTINATION_EXISTS/);
  assert.doesNotMatch(install, /Register-ScheduledTask[^\n]*-Force/);
  assert.match(install, /taskName = \$TaskName/);
  assert.match(install, /tokenSha256 = \$null/);
  assert.match(install, /proposedSha256 = \$null/);
});

test("rollback refuses foreign tasks or changed installer-owned secrets and config", () => {
  assert.match(rollback, /ROLLBACK_MANIFEST_TASK_MISMATCH/);
  assert.match(rollback, /ROLLBACK_TASK_IDENTITY_MISMATCH/);
  assert.match(rollback, /ROLLBACK_TOKEN_CHANGED/);
  assert.match(rollback, /ROLLBACK_PROPOSED_CONFIG_CHANGED/);
  assert.ok(
    rollback.indexOf("ROLLBACK_TASK_IDENTITY_MISMATCH") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.ok(
    rollback.indexOf("ROLLBACK_TOKEN_CHANGED") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
  assert.ok(
    rollback.indexOf("ROLLBACK_PROPOSED_CONFIG_CHANGED") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
});

const bootstrap = fs.readFileSync(
  "scripts/windows/bootstrap-p720-supervisor.ps1",
  "utf8",
);
const launcher = fs.readFileSync(
  "scripts/windows/PREPARE-P720-SUPERVISOR.cmd",
  "utf8",
);

test("prepared Windows supervisor restarts after reboot but is not activated by install", () => {
  assert.match(install, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(install, /-Trigger \$trigger/);
  assert.match(install, /-RestartCount 3 -RestartInterval/);
  assert.match(install, /Disable-ScheduledTask/);
  assert.doesNotMatch(install, /Enable-ScheduledTask|Start-ScheduledTask/);
});

test("isolated P720 bootstrap uses immutable public source and refuses checkout mutation", () => {
  assert.match(bootstrap, /\$ExpectedSha = '[a-f0-9]{40}'/);
  assert.match(
    bootstrap,
    /https:\/\/github\.com\/kmjtechno\/kmj-codebridge\.git/,
  );
  assert.match(bootstrap, /--no-checkout --filter=blob:none/);
  assert.match(bootstrap, /checkout --detach \$ExpectedSha/);
  assert.match(bootstrap, /PINNED_SHA_MISMATCH/);
  assert.match(bootstrap, /UNTRUSTED_RUNTIME_ORIGIN/);
  assert.match(bootstrap, /--ignore-scripts/);
  assert.match(bootstrap, /ADMINISTRATOR_REQUIRED/);
  assert.match(bootstrap, /EXISTING_SUPERVISOR_TOKEN_REFUSED/);
  assert.match(bootstrap, /ACTIVE_AGENT=UNTOUCHED/);
  assert.match(bootstrap, /CINECORE_AGENT=UNTOUCHED/);
  assert.doesNotMatch(
    bootstrap,
    /Start-ScheduledTask|Enable-ScheduledTask|Restart-Service|git reset/i,
  );
  assert.match(launcher, /bootstrap-p720-supervisor\.ps1/);
});

test("Node JSON configurations are written without Windows PowerShell UTF-8 BOM", () => {
  for (const script of [bootstrap, install]) {
    assert.match(script, /UTF8Encoding\]::new\(\$false\)/);
  }
  assert.doesNotMatch(install, /\$proposed -Encoding UTF8/i);
  assert.doesNotMatch(bootstrap, /\$SupervisorConfig -Encoding UTF8/i);
});

test(
  "Windows PowerShell parses all bootstrap and supervisor scripts without executing them",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const paths = [
      "scripts/windows/install-windows-supervisor.ps1",
      "scripts/windows/rollback-windows-supervisor.ps1",
      "scripts/windows/bootstrap-p720-supervisor.ps1",
    ];
    const joined = paths.map((p) => "'" + p + "'").join(",");
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "foreach ($f in @(" + joined + ")) {",
      "  $tok = $null; $errors = $null;",
      "  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tok, [ref]$errors) | Out-Null;",
      "  if ($errors.Count -gt 0) { throw ($f + ': ' + $errors[0].Message) }",
      "}",
    ].join("\n");
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
);

// Activation must remain separate from preparation and refuse any guesswork.
const activation = fs.readFileSync(
  "scripts/windows/activate-p720-supervisor.ps1",
  "utf8",
);
const activator = fs.readFileSync(
  "scripts/windows/ACTIVATE-P720-SUPERVISOR.cmd",
  "utf8",
);
const health = fs.readFileSync(
  "scripts/windows/verify-p720-supervisor.mjs",
  "utf8",
);

test("activation validates pinned source, task identity, token, backups and HMAC", () => {
  for (const marker of [
    "PREPARED_SUPERVISOR_MANIFEST_NOT_UNIQUE",
    "TOKEN_CHANGED",
    "BACKUP_HASH_MISMATCH",
    "AGENT_PROPOSAL_CHANGED",
    "RUNTIME_SHA_MISMATCH",
    "RUNTIME_ORIGIN_MISMATCH",
    "TASK_IDENTITY_MISMATCH",
    "SUPERVISOR_HMAC_VERIFICATION_FAILED",
  ])
    assert.ok(activation.includes(marker), marker);
  assert.match(activation, /Enable-ScheduledTask/);
  assert.match(activation, /Start-ScheduledTask/);
  assert.match(activation, /Disable-ScheduledTask/);
  assert.match(activation, /SUPERVISOR_ACTIVATION_ROLLED_BACK/);
  assert.match(activator, /activate-p720-supervisor\.ps1/);
  assert.match(health, /windowsSupervisorRequest/);
  assert.match(health, /HMAC_STATUS=PASS/);
  assert.doesNotMatch(
    activation,
    /git reset|Restart-Service|Unregister-ScheduledTask/i,
  );
});

test("rollback refuses overwriting newer operator configuration", () => {
  assert.match(rollback, /RESTORE_TARGET_CHANGED/);
  assert.ok(
    rollback.indexOf("RESTORE_TARGET_CHANGED") <
      rollback.indexOf("Unregister-ScheduledTask"),
  );
});

test(
  "native Windows parser also accepts guarded activation script",
  {
    skip: process.platform !== "win32",
  },
  () => {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$tokens=$null; $errors=$null; " +
          "[System.Management.Automation.Language.Parser]::ParseFile(" +
          "'scripts/windows/activate-p720-supervisor.ps1'," +
          "[ref]$tokens,[ref]$errors) | Out-Null; " +
          "if($errors.Count -gt 0){throw $errors[0].Message}",
      ],
      { timeout: 20000, stdio: "pipe" },
    );
  },
);

test("all supervisor task operations are scoped to Task Scheduler root folder", () => {
  const rootPath = "-TaskPath '" + String.fromCharCode(92) + "'";
  for (const script of [install, rollback, activation]) {
    for (const match of script.matchAll(
      /(?:Get|Register|Start|Stop|Enable|Disable|Unregister)-ScheduledTask -TaskName \$TaskName/g,
    )) {
      const rest = script.slice(match.index, script.indexOf("\n", match.index));
      assert.ok(rest.includes(rootPath), rest);
    }
  }
});
