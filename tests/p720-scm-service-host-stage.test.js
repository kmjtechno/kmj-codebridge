import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

const native = fs.readFileSync(
  "scripts/windows/native-service/P720AgentService.cs",
  "utf8",
);
const build = fs.readFileSync(
  "scripts/windows/BUILD-P720-AGENTSERVICE-STAGE.ps1",
  "utf8",
);
const fixture = fs.readFileSync(
  "scripts/windows/native-service/P720ChildLifecycleFixture.cs",
  "utf8",
);

test("P720 SCM host is a real ServiceBase type and blocks activation", () => {
  assert.match(native, /class P720AgentService : ServiceBase/);
  assert.match(native, /FixedServiceName = "KMJ-CodeBridge-P720-AgentService"/);
  assert.match(native, /protected override void OnStart\(string\[\] args\)/);
  assert.match(native, /throw new InvalidOperationException\(NotReadyCode\)/);
  assert.match(
    native,
    /KMJ_P720_SERVICE_HOST_ACTIVATION=BLOCKED_UNVERIFIED_TAKEOVER/,
  );
  assert.match(native, /ServiceBase\.Run\(new P720AgentService\(\)\)/);
  assert.match(native, /--self-test/);
  assert.doesNotMatch(
    native,
    /Process\.Start|ProcessStartInfo|TerminateProcess|CreateProcess|sc\.exe/i,
  );
  assert.doesNotMatch(native, /token|Bearer|password|Invoke-WebRequest/i);
});

test("SCM lifecycle fixture is isolated from any enrolled CodeBridge agent", () => {
  assert.match(native, /throw new InvalidOperationException\(NotReadyCode\)/);
  assert.match(native, /--lifecycle-self-test/);
  assert.match(native, /--lifecycle-timeout-self-test/);
  assert.match(native, /--fixture-child/);
  assert.match(fixture, /Arguments = "--fixture-child"/);
  assert.match(fixture, /Assembly\.GetExecutingAssembly\(\)\.Location/);
  assert.match(fixture, /RedirectStandardInput = true/);
  assert.match(fixture, /UseShellExecute = false/);
  assert.match(fixture, /ProcessStartInfo/);
  assert.match(fixture, /child\.WaitForExit\(expectTimeout \? 400 : 8000\)/);
  assert.match(fixture, /if \(!child\.HasExited\)/);
  assert.match(fixture, /KMJ_P720_CHILD_LIFECYCLE_GRACEFUL=PASS/);
  assert.match(fixture, /KMJ_P720_CHILD_LIFECYCLE_TIMEOUT_FENCED=PASS/);
  assert.doesNotMatch(
    fixture,
    /Process\.GetProcesses|node(?:\.exe)?|agent\.json|gatewayTokenFile/,
  );
  assert.doesNotMatch(
    fixture,
    /Stop-Process|taskkill|ServiceController|sc\.exe/i,
  );
  assert.match(build, /KMJ_P720_SCM_HOST_GRACEFUL_FIXTURE=PASS/);
  assert.match(build, /KMJ_P720_SCM_HOST_TIMEOUT_FIXTURE=PASS/);
  assert.ok(!/[^\x00-\x7f]/.test(fixture));
});

test("P720 SCM builder does not install services, change enrollment or touch current task", () => {
  assert.match(build, /param\(\[switch\]\$Build, \[string\]\$Destination\)/);
  assert.match(build, /Microsoft\.NET\\Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(build, /System\.ServiceProcess\.dll/);
  assert.match(build, /KMJ_P720_SCM_HOST_MODE=DRY_RUN/);
  assert.match(build, /KMJ_P720_SCM_HOST_MODE=BUILD_ONLY/);
  assert.match(build, /KMJ_P720_SCM_HOST_PRODUCTION_READY=NO/);
  assert.match(build, /kmj-p720-scm-stage-/);
  assert.doesNotMatch(
    build,
    /\b(?:New-Service|Set-Service|Start-Service|Stop-Service|Restart-Service|sc\.exe|Register-ScheduledTask|Enable-ScheduledTask|Stop-Process|Start-Process)\b/i,
  );
  assert.doesNotMatch(build, /agent\.json|supervisor\.token|Get-Credential/i);
  assert.ok(!/[^\x00-\x7f]/.test(build));
  assert.ok(!/[^\x00-\x7f]/.test(native));
});

test(
  "Windows host stages in a unique temporary directory and can be compiled with stock csc",
  { skip: process.platform !== "win32" },
  () => {
    const script = "scripts/windows/BUILD-P720-AGENTSERVICE-STAGE.ps1";
    const ps = "powershell.exe";
    const ast = [
      "$t=$null;$e=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "'" + script.replace(/\//g, "\\") + "',",
      "[ref]$t,[ref]$e)|Out-Null;",
      "if($e.Count -ne 0){exit 8};Write-Output 'HOST_AST=PASS'",
    ].join(" ");
    assert.match(
      execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", ast], {
        encoding: "utf8",
        timeout: 15000,
      }),
      /HOST_AST=PASS/,
    );
    const output = execFileSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Build",
      ],
      { encoding: "utf8", timeout: 90000 },
    );
    assert.match(output, /KMJ_P720_SCM_HOST_BUILD=PASS/);
    assert.match(output, /KMJ_P720_SCM_HOST_SELFTEST=PASS/);
    assert.match(output, /KMJ_P720_SCM_HOST_GRACEFUL_FIXTURE=PASS/);
    assert.match(output, /KMJ_P720_SCM_HOST_TIMEOUT_FIXTURE=PASS/);
    assert.match(output, /KMJ_P720_SCM_HOST_SERVICE_REGISTERED=NO/);
    assert.match(output, /KMJ_P720_SCM_HOST_SERVICE_STARTED=NO/);
    assert.match(output, /KMJ_P720_SCM_HOST_PRODUCTION_READY=NO/);
  },
);
