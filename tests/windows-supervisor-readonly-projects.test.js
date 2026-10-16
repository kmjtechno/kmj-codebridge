import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWindowsSupervisorConfigSchema,
  createWindowsSupervisorHandler,
} from "../src/windows-supervisor.js";

test("read-only CodeBridge status is truthful and never authorizes verification jobs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-ro-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const schema = createWindowsSupervisorConfigSchema(path);
  const config = schema.parse({
    pipeName: "kmj-codebridge-supervisor-test",
    tokenFile: path.join(root, "token"),
    agent: {
      installDir: path.join(root, "agent"),
      configPath: path.join(root, "agent.json"),
    },
    projects: [],
    readOnlyProjects: [{ id: "kmj-codebridge", repoRoot: repo }],
  });
  const calls = [];
  const handler = createWindowsSupervisorHandler({
    config,
    pathLib: path,
    exists: fs.existsSync,
    runner: async (...args) => {
      calls.push(args);
      throw Error("EXECUTION_NOT_PERMITTED");
    },
  });
  const value = (
    await handler({ op: "project_status", projectId: "kmj-codebridge" })
  ).response;
  assert.equal(value.projectId, "kmj-codebridge");
  assert.equal(value.present, true);
  assert.equal(value.gitCheckout, true);
  assert.deepEqual(value.verification, {
    supported: false,
    stages: [],
    allowFetch: false,
  });
  await assert.rejects(
    handler({
      op: "project_verify_prepare",
      projectId: "kmj-codebridge",
      sha: "a".repeat(40),
    }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    handler({
      op: "project_verify_stage",
      projectId: "kmj-codebridge",
      sha: "a".repeat(40),
      stage: "build",
    }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    handler({ op: "project_status", projectId: "unknown" }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
  assert.equal(calls.length, 0);
});

test("read-only project schema refuses extra command knobs, duplicate IDs and unsafe paths", () => {
  const schema = createWindowsSupervisorConfigSchema(path.win32);
  const config = {
    pipeName: "kmj-codebridge-supervisor-p720",
    tokenFile: "D:\\KMJ-HyperSpeed\\private\\p720-codebridge\\supervisor.token",
    agent: {
      installDir: "D:\\KMJ-HyperSpeed\\codebridge-releases\\some-release",
      configPath: "D:\\KMJ-HyperSpeed\\private\\p720-codebridge\\agent.json",
    },
    projects: [],
    readOnlyProjects: [
      {
        id: "kmj-codebridge",
        repoRoot: "D:\\KMJ-HyperSpeed\\projects\\kmj-codebridge",
      },
    ],
  };
  assert.equal(schema.safeParse(config).success, true);
  for (const bad of [
    {
      ...config,
      readOnlyProjects: [
        { ...config.readOnlyProjects[0], gitExe: "C:\\git.exe" },
      ],
    },
    {
      ...config,
      readOnlyProjects: [
        {
          ...config.readOnlyProjects[0],
          repoRoot: "D:\\KMJ-HyperSpeed\\..\\Windows",
        },
      ],
    },
    {
      ...config,
      readOnlyProjects: [{ ...config.readOnlyProjects[0], id: "invalid id" }],
    },
    {
      ...config,
      readOnlyProjects: [
        config.readOnlyProjects[0],
        config.readOnlyProjects[0],
      ],
    },
    { ...config, projects: [{ id: "kmj-codebridge" }] },
  ])
    assert.equal(schema.safeParse(bad).success, false);
});
