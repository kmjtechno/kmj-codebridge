import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { agentSchema } from "../src/config.js";
import { createDispatcher } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import {
  validApprovedScriptPath,
  verifyApprovedPowerShellScript,
  approvedPowerShellInvocation,
} from "../src/windows-powershell-profile.js";

const digest = (content) => createHash("sha256").update(content).digest("hex");

const base = {
  gateway: "https://gateway.example.test",
  token: "x".repeat(32),
  id: "device1",
  tenant: "tenant1",
  stateDir: "/tmp/agent-state",
  license: { mode: "free" },
  projects: [
    {
      id: "project1",
      root: "/tmp/project",
      writable: true,
      gates: {},
      commands: {
        approved_windows_qa: {
          category: "build",
          command: "powershell.exe",
          variants: {
            run: {
              args: ["-Mode", "Inspect"],
              timeoutMs: 20000,
              powershellScript: {
                path: "scripts/approved-qa.ps1",
                sha256: "a".repeat(64),
              },
            },
          },
        },
      },
    },
  ],
};

test("admin schema keeps a SHA-pinned PowerShell script without adding shell tools", () => {
  const parsed = agentSchema.parse(base);
  const variant = parsed.projects[0].commands.approved_windows_qa.variants.run;
  assert.equal(variant.powershellScript.path, "scripts/approved-qa.ps1");
  assert.equal(variant.powershellScript.sha256, "a".repeat(64));
  const wrong = structuredClone(base);
  wrong.projects[0].commands.approved_windows_qa.command = "cmd.exe";
  assert.throws(() => agentSchema.parse(wrong), /PowerShell script profiles/);
  const inspect = structuredClone(base);
  inspect.projects[0].commands.approved_windows_qa.category = "inspect";
  assert.throws(() => agentSchema.parse(inspect), /PowerShell script profiles/);
  const noHash = structuredClone(base);
  noHash.projects[0].commands.approved_windows_qa.variants.run.powershellScript.sha256 =
    "not-a-digest";
  assert.throws(() => agentSchema.parse(noHash));
});

test("PowerShell script selection refuses traversal, UNC, alternate streams and mixed slashes", () => {
  for (const safe of ["scripts/build.ps1", "tools/windows/codebridge-test.ps1"])
    assert.equal(validApprovedScriptPath(safe), true);
  for (const unsafe of [
    "../outside.ps1",
    "scripts/../outside.ps1",
    "./dev.ps1",
    "C:/windows/system32/x.ps1",
    "\\\\server\\share\\evil.ps1",
    "scripts\\other.ps1",
    "scripts/malicious.ps1:stream",
    "file.ps1",
    "scripts/run.ps1/extra",
    "scripts/$env.ps1",
    "scripts/.ps1/../evil.ps1",
  ])
    assert.equal(validApprovedScriptPath(unsafe), false, unsafe);
});

test("script bytes, hardlinks, and symlink paths are verified fail-closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-powershell-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  const file = path.join(root, "scripts", "qa.ps1");
  const bytes = "Write-Output 'SAFE'\n";
  fs.writeFileSync(file, bytes);
  const spec = { path: "scripts/qa.ps1", sha256: digest(bytes) };
  assert.equal(verifyApprovedPowerShellScript(root, spec), file);
  assert.throws(
    () =>
      verifyApprovedPowerShellScript(root, { ...spec, sha256: "0".repeat(64) }),
    /POWERSHELL_SCRIPT_HASH_MISMATCH/,
  );
  fs.writeFileSync(file, "Write-Output 'MODIFIED'\n");
  assert.throws(
    () => verifyApprovedPowerShellScript(root, spec),
    /POWERSHELL_SCRIPT_HASH_MISMATCH/,
  );
  fs.writeFileSync(file, bytes);
  const hardlink = path.join(root, "scripts", "qa-hardlink.ps1");
  fs.linkSync(file, hardlink);
  assert.throws(
    () => verifyApprovedPowerShellScript(root, spec),
    /POWERSHELL_UNTRUSTED_FILE/,
  );
  fs.unlinkSync(hardlink);
  const external = path.join(root, "external.ps1");
  fs.writeFileSync(external, bytes);
  fs.unlinkSync(file);
  try {
    fs.symlinkSync(external, file, "file");
  } catch {
    return;
  }
  assert.throws(
    () => verifyApprovedPowerShellScript(root, spec),
    /POWERSHELL_SCRIPT_PATH_UNSAFE/,
  );
});

test("PowerShell profile cannot execute on Linux or with a changed executable", () => {
  assert.throws(
    () =>
      approvedPowerShellInvocation({
        cwd: "/tmp",
        profile: base.projects[0].commands.approved_windows_qa,
        variant: base.projects[0].commands.approved_windows_qa.variants.run,
        platform: "linux",
      }),
    /POWERSHELL_WINDOWS_ONLY/,
  );
  assert.equal(
    approvedPowerShellInvocation({
      cwd: "/tmp",
      profile: { command: "node" },
      variant: { args: [] },
      platform: "linux",
    }),
    null,
  );
});

async function finished(runner, jobId) {
  for (let i = 0; i < 180; i++) {
    const job = runner.get(jobId, "project1");
    if (!["queued", "running"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("JOB_TIMED_OUT");
}

test("Windows CodeBridge IDE runs approved local PowerShell without modifying dirty checkout", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Native Windows functional test runs in windows-latest CI");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ps-ide-"));
  const root = path.join(home, "repo");
  const state = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "QA");
  git("config", "user.email", "qa@example.invalid");
  fs.mkdirSync(path.join(root, "scripts"));
  const approved = "Write-Output 'WINDOWS_IDE_POWERSHELL_PASS'\n";
  fs.writeFileSync(path.join(root, "scripts", "verify.ps1"), approved);
  git("add", ".");
  git("commit", "-qm", "approved powerShell QA");
  const head = git("rev-parse", "HEAD");
  const dirty = path.join(root, "owner-untracked.txt");
  fs.writeFileSync(dirty, "PRESERVE_ME");
  const runner = new JobRunner(path.join(state, "jobs"));
  t.after(async () => {
    await runner.close();
    fs.rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: state,
      projects: [
        {
          id: "project1",
          root,
          writable: true,
          commands: {
            local_windows_qa: {
              category: "build",
              command: "powershell.exe",
              variants: {
                verify: {
                  args: [],
                  timeoutMs: 20000,
                  powershellScript: {
                    path: "scripts/verify.ps1",
                    sha256: digest(approved),
                  },
                },
              },
            },
          },
        },
      ],
    },
    runner,
    () => ({ features: ["execute"], limits: { concurrent_jobs: 1 } }),
  );
  const job = await dispatch(
    "run_project_command",
    {
      device: "d1",
      project: "project1",
      command: "local_windows_qa",
      variant: "verify",
      requestKey: "windows-native-dev-qa",
    },
    ["execute"],
  );
  const final = await finished(runner, job.id);
  assert.equal(final.state, "succeeded", final.output);
  assert.equal(final.exitCode, 0);
  assert.match(final.output, /WINDOWS_IDE_POWERSHELL_PASS/);
  assert.ok(final.gate.endsWith("#" + head));
  const lanes = new WorktreeLanes(state).status("project1", root).lanes;
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].dirty, false);
  assert.equal(lanes[0].head, head);
  assert.equal(fs.readFileSync(dirty, "utf8"), "PRESERVE_ME");

  // A modified script in the prepared lane must not run with the old approval.
  fs.writeFileSync(
    path.join(lanes[0].path, "scripts", "verify.ps1"),
    "Write-Output 'EVIL'\n",
  );
  await assert.rejects(
    dispatch(
      "run_project_command",
      {
        device: "d1",
        project: "project1",
        command: "local_windows_qa",
        variant: "verify",
        requestKey: "windows-native-dev-tamper",
      },
      ["execute"],
    ),
    /WORKTREE_HAS_UNSAVED_WORK/,
  );
});
