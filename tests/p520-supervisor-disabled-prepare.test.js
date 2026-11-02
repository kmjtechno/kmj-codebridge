import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL(
    "../scripts/windows/P520-SUPERVISOR-DISABLED-PREPARE.ps1",
    import.meta.url,
  ),
);

test("disabled P520 preparation demands pinned agent, Git release, tools, installer", () => {
  const source = fs.readFileSync(script, "utf8");
  for (const required of [
    "AgentConfigSha256",
    "SupervisorConfigSha256",
    "RuntimeEntrySha256",
    "NodeExeSha256",
    "GitExeSha256",
    "ExpectedRuntimeGitSha",
    "InstallerSha256",
    "ConfirmDisabledPreparation",
    "Get-ScheduledTask -ErrorAction Stop",
    "TASK_NAME_COLLISION",
    "RUNTIME_GIT_SHA_MISMATCH",
    "RUNTIME_GIT_ORIGIN_MISMATCH",
    "RUNTIME_CHECKOUT_DIRTY",
    "PINNED_ARTIFACT_MISMATCH",
    "EXISTING_SUPERVISOR_BINDING",
    "REPARSE_",
    "TASK_NOT_DISABLED",
    "OWNER_PROTECTED_ROOT_NOT_PROVISIONED",
    "OUTSIDE_PROTECTED_P520_ROOT_",
    "PROTECTED_UNAPPROVED_WRITER_",
    "PROTECTED_OWNER_NOT_ADMIN_",
  ]) {
    assert.ok(source.includes(required), "Missing protection " + required);
  }
  assert.match(source, /P520_PREPARE_AI_OWNER_WITNESS' 'NOT_ESTABLISHED'/);
  assert.match(source, /P520_LOCAL_AI_ACTIVATION' 'NOT_ATTEMPTED'/);
  assert.match(source, /KMJ-CodeBridge-Supervisor-P520/);
  assert.match(source, /RUNTIME_GIT_SHA_PIN_INVALID/);
  assert.equal(
    (source.match(/P520_LOCAL_AI_ACTIVATION' 'NOT_ATTEMPTED'/g) ?? []).length,
    1,
    "duplicated preparation block",
  );
  assert.doesNotMatch(source, /KMJ-CodeBridge-Supervisor-P720/i);
  assert.doesNotMatch(source, /bootstrap-p720-supervisor/i);
  assert.doesNotMatch(source, /\bRestart-Service\b/i);
  assert.doesNotMatch(source, /\bStart-ScheduledTask\b/i);
  assert.doesNotMatch(source, /\bEnable-ScheduledTask\b/i);
  assert.doesNotMatch(source, /git\s+reset\b/i);
  assert.doesNotMatch(source, /git\s+clean\b/i);
});

test("shared installer registers task disabled atomically, without enabled interval", () => {
  const installer = fileURLToPath(
    new URL(
      "../scripts/windows/install-windows-supervisor.ps1",
      import.meta.url,
    ),
  );
  const source = fs.readFileSync(installer, "utf8");
  assert.match(source, /New-ScheduledTaskSettingsSet[^\n]*-Disable/);
  assert.match(source, /SUPERVISOR_TASK_NOT_DISABLED_AT_REGISTRATION/);
  assert.doesNotMatch(source, /^\s*Disable-ScheduledTask\b/m);
});

test("the installer is unreachable until explicit Apply and confirmation", () => {
  const source = fs.readFileSync(script, "utf8");
  const dryRun = source.indexOf("if(-not $Apply) {");
  const confirm = source.indexOf("if(-not $ConfirmDisabledPreparation)");
  const installerCall = source.indexOf("& $installer @installerParams");
  assert.ok(dryRun > 0);
  assert.ok(confirm > dryRun);
  assert.ok(installerCall > confirm);
  assert.match(source.slice(dryRun, confirm), /exit 0/);
  assert.match(source.slice(confirm, installerCall), /Administrator/);
});

test(
  "hosted non-P520 Windows runner cannot prepare a Supervisor task",
  { skip: process.platform !== "win32" },
  () => {
    const pin = "0".repeat(64);
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        script,
        "-AgentConfig",
        "C:\\unavailable\\agent.json",
        "-SupervisorConfig",
        "C:\\unavailable\\supervisor.json",
        "-RuntimeDir",
        "C:\\unavailable\\runtime",
        "-BackupRoot",
        "C:\\unavailable\\backups",
        "-ServiceAccount",
        "KMJ",
        "-AgentConfigSha256",
        pin,
        "-SupervisorConfigSha256",
        pin,
        "-RuntimeEntrySha256",
        pin,
        "-NodeExeSha256",
        pin,
        "-GitExeSha256",
        pin,
        "-ExpectedRuntimeGitSha",
        "0".repeat(40),
        "-InstallerSha256",
        pin,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stdout, /P520_PREPARE_RESULT=BLOCKED_WRONG_P520/);
    assert.match(run.stdout, /P520_PREPARE_EXISTING_AGENTS=UNTOUCHED/);
  },
);
