import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWindowsSupervisorConfigSchema,
  createWindowsSupervisorHandler,
} from "../src/windows-supervisor.js";

const sha = "a".repeat(40);
const root = path.join(os.tmpdir(), "kmj-supervisor-omnidesk-test");
const repoRoot = path.join(root, "KMJ OmniDesk");
const worktreeRoot = path.join(root, "isolated");
const gitExe = path.join(root, "git");
const cargoExe = path.join(root, "cargo");

function configForRust() {
  return createWindowsSupervisorConfigSchema(path).parse({
    pipeName: "kmj-codebridge-supervisor-omnidesk",
    tokenFile: path.join(root, "supervisor.token"),
    agent: {
      installDir: path.join(root, "release"),
      configPath: path.join(root, "agent.json"),
    },
    projects: [],
    rustProjects: [
      {
        id: "kmj-omnidesk",
        repoRoot,
        worktreeRoot,
        gitExe,
        cargoExe,
        cargoHome: path.join(root, "cargo-home"),
        rustupHome: path.join(root, "rustup-home"),
        allowFetch: false,
      },
    ],
    readOnlyProjects: [],
  });
}

test("Rust project status authorizes only fixed Cargo QA stages", async () => {
  const config = configForRust();
  const called = [];
  const writes = [];
  const handler = createWindowsSupervisorHandler({
    config,
    pathLib: path,
    exists: () => true,
    mkdir: () => {},
    writeFile: (dest, content) => writes.push({ dest, content }),
    runner: async (exe, args, opts) => {
      called.push({ exe, args, opts });
      return {
        exitCode: 0,
        spawnFailed: false,
        timedOut: false,
        truncated: false,
        output: exe === gitExe ? sha + "\n" : "QA passed",
        logSha256: "b".repeat(64),
        durationMs: 2,
      };
    },
  });
  const status = (
    await handler({ op: "project_status", projectId: "kmj-omnidesk" })
  ).response;
  assert.deepEqual(status.verification, {
    supported: true,
    stages: ["fmt", "clippy", "test"],
    allowFetch: false,
  });
  for (const [stage, expected] of [
    ["fmt", ["fmt", "--all", "--", "--check"]],
    [
      "clippy",
      ["clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"],
    ],
    ["test", ["test", "--workspace", "--all-targets", "--all-features"]],
  ]) {
    const before = called.length;
    const receipt = (await handler({
      op: "project_verify_stage",
      projectId: "kmj-omnidesk",
      sha,
      stage,
    })).response;
    assert.equal(receipt.passed, true);
    assert.equal(receipt.stage, stage);
    const calls = called.slice(before);
    const cargo = calls.filter((c) => c.exe === cargoExe);
    assert.equal(cargo.length, 1);
    assert.deepEqual(cargo[0].args, expected);
    assert.equal(cargo[0].opts.cwd, path.join(worktreeRoot, "wt", sha.slice(0, 12)));
    assert.equal(cargo[0].opts.env.CARGO_HOME, path.join(root, "cargo-home"));
    assert.equal(cargo[0].opts.env.RUSTUP_HOME, path.join(root, "rustup-home"));
    assert.equal(cargo[0].opts.shell, undefined);
  }
  assert.equal(writes.length, 3);
  assert.equal(called.filter((c) => c.exe === cargoExe).length, 3);
  for (const stage of ["configure", "build", "ctest", "shell", "publish"]) {
    await assert.rejects(
      handler({ op: "project_verify_stage", projectId: "kmj-omnidesk", sha, stage }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  }
  assert.equal(called.filter((c) => c.exe === cargoExe).length, 3);
});

test("Rust Windows config remains operator-scoped and rejects extra execution knobs", () => {
  const schema = createWindowsSupervisorConfigSchema(path);
  const good = configForRust();
  assert.equal(good.rustProjects[0].allowFetch, false);
  const profile = good.rustProjects[0];
  for (const bad of [
    { ...good, rustProjects: [{ ...profile, command: "cmd.exe" }] },
    { ...good, rustProjects: [{ ...profile, args: ["/c", "whoami"] }] },
    { ...good, rustProjects: [{ ...profile, repoRoot: "../bad" }] },
    { ...good, rustProjects: [{ ...profile, cargoHome: "../bad" }] },
    { ...good, rustProjects: [{ ...profile, stageTimeoutSeconds: 7201 }] },
    { ...good, rustProjects: [{ ...profile, id: "kmj omnidesk" }] },
    { ...good, rustProjects: [profile, profile] },
    { ...good, readOnlyProjects: [{ id: profile.id, repoRoot }] },
  ]) {
    assert.equal(schema.safeParse(bad).success, false);
  }
});
