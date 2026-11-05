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

test("privileged disabled preparation requires protected file ACLs before invoking installer", () => {
  const source = fs.readFileSync(script, "utf8");
  const applyGate = source.indexOf("if(-not $ConfirmDisabledPreparation)");
  const installerCall = source.indexOf("& $installer @installerParams");
  const protectedFile = source.indexOf("function Assert-ProtectedFileAcl(");
  assert.ok(protectedFile > 0);
  assert.match(source, /PROTECTED_FILE_OWNER_NOT_ADMIN_/);
  assert.match(source, /PROTECTED_FILE_UNAPPROVED_WRITER_/);
  assert.match(source, /PROTECTED_FILE_REPARSE_/);
  assert.match(source, /PROTECTED_FILE_MISSING_/);
  for (const guard of [
    "Assert-ProtectedFileAcl $PSCommandPath 'PREPARATION_SCRIPT'",
    "Assert-ProtectedFileAcl $installer 'INSTALLER'",
    "Assert-ProtectedFileAcl $SupervisorConfig 'SUPERVISOR_CONFIG_FILE'",
    "Assert-ProtectedFileAcl $cli 'RUNTIME_CLI_FILE'",
  ]) {
    const at = source.indexOf(guard);
    assert.ok(
      at > applyGate && at < installerCall,
      guard + " must guard Apply",
    );
  }
  assert.match(source, /\$sid -notin \$trustedWriters/);
  assert.match(
    source,
    /\$acl\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/,
  );
});

test("protected directory and installer ACL checks reject destructive ownership rights", () => {
  const source = fs.readFileSync(script, "utf8");
  const dirGuard = source.slice(
    source.indexOf("function Assert-ProtectedLocation("),
    source.indexOf("function Assert-ProtectedFileAcl("),
  );
  const fileGuard = source.slice(
    source.indexOf("function Assert-ProtectedFileAcl("),
    source.indexOf("function Assert-Hash("),
  );
  for (const part of [dirGuard, fileGuard]) {
    for (const right of [
      "DeleteSubdirectoriesAndFiles",
      "ChangePermissions",
      "TakeOwnership",
      "Delete",
      "Modify",
    ]) {
      assert.ok(
        part.includes("[Security.AccessControl.FileSystemRights]::" + right),
        "ACL must reject " + right,
      );
    }
    assert.match(part, /\$sid -notin \$trustedWriters/);
  }
});

test("protected P520 ancestors cannot be deleted or re-ACL'd by non-admin principals", () => {
  const source = fs.readFileSync(script, "utf8");
  const ancestor = source.slice(
    source.indexOf("function Assert-ProtectedAncestorDeleteGuard("),
    source.indexOf("function Assert-ProtectedLocation("),
  );
  const applyGuard = source.indexOf(
    "Assert-ProtectedAncestorDeleteGuard $base $tag",
  );
  const installerCall = source.indexOf("& $installer @installerParams");
  assert.ok(ancestor.length > 200, "ancestor ACL guard must exist");
  assert.ok(applyGuard > 0 && applyGuard < installerCall);
  for (const item of [
    "Delete",
    "DeleteSubdirectoriesAndFiles",
    "ChangePermissions",
    "TakeOwnership",
  ]) {
    assert.ok(
      ancestor.includes("[Security.AccessControl.FileSystemRights]::" + item),
      "ancestor must forbid " + item,
    );
  }
  assert.match(ancestor, /PROTECTED_ANCESTOR_DELETION_RIGHT_/);
  assert.match(ancestor, /PROTECTED_ANCESTOR_REPARSE_/);
  assert.match(ancestor, /PROTECTED_ANCESTOR_DEPTH_UNBOUNDED_/);
  assert.match(ancestor, /PropagationFlags\]::InheritOnly/);
  assert.match(ancestor, /\$sid -notin \$trustedWriters/);
  assert.match(ancestor, /Get-Acl -LiteralPath \$ancestor -ErrorAction Stop/);
});

test("shared installer locks an empty token before writing the first secret byte", () => {
  const installer = fileURLToPath(
    new URL(
      "../scripts/windows/install-windows-supervisor.ps1",
      import.meta.url,
    ),
  );
  const source = fs.readFileSync(installer, "utf8");
  const create = source.indexOf("[System.IO.FileMode]::CreateNew");
  const acl = source.indexOf("& icacls.exe $tokenFile /inheritance:r");
  // PR merge builds may include main's stronger SID-based ACL validation.
  // Either implementation must finish its last fail-closed check before write.
  const aclFailure = Math.max(
    source.indexOf("Token file ACL still contains a broad principal"),
    source.indexOf("SUPERVISOR_TOKEN_ACL_REQUIRED_PRINCIPAL_MISSING"),
  );
  const secretWrite = source.indexOf(
    "Set-Content -LiteralPath $tokenFile -Value $hex",
  );
  assert.ok(create > 0 && acl > create, "token must be empty when ACL is set");
  assert.ok(
    aclFailure > acl && secretWrite > aclFailure,
    `no secret bytes before ACL verification (create=${create}, acl=${acl}, verify=${aclFailure}, write=${secretWrite})`,
  );
  assert.ok(
    source.indexOf("$manifest.tokenCreatedByInstaller = $true") < secretWrite,
    "rollback manifest must record the empty created file",
  );
});

test("shared installer locks backup directory before copying agent credentials", () => {
  const installer = fileURLToPath(
    new URL(
      "../scripts/windows/install-windows-supervisor.ps1",
      import.meta.url,
    ),
  );
  const source = fs.readFileSync(installer, "utf8");
  const create = source.indexOf("New-Item -ItemType Directory -Path $backup");
  const lock = source.indexOf("& icacls.exe $backup /inheritance:r");
  const verify = source.indexOf("BACKUP_ACL_UNAPPROVED_READER");
  const copy = source.indexOf(
    "Copy-Item -LiteralPath $file -Destination $dest",
  );
  assert.ok(
    create > 0 && lock > create,
    "new empty backup root must be ACL-locked",
  );
  assert.ok(
    verify > lock && copy > verify,
    "backup credentials must be copied only after ACL verification",
  );
  assert.match(source, /BACKUP_ACL_LOCK_FAILED/);
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
