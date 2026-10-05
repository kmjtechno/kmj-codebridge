import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

test("project environment detects bounded stacks without executing project code", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-environment-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src-tauri"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "8.0.0" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "composer.json"),
    JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
  );
  for (const name of [
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "build.gradle",
    "Dockerfile",
    "pnpm-lock.yaml",
    "artisan",
    "vite.config.ts",
    "App.csproj",
  ])
    fs.writeFileSync(path.join(root, name), "");
  fs.writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "{}");

  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const runner = { maxConcurrent: 1 };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [
        {
          id: "p1",
          root,
          writable: true,
          gates: {},
          commands: {},
        },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );

  const result = await dispatch(
    "project_environment",
    { device: "d1", project: "p1" },
    ["read"],
  );

  assert.deepEqual(result, {
    device: "d1",
    project: "p1",
    stacks: ["docker", "dotnet", "go", "java", "node", "php", "python", "rust"],
    frameworks: ["laravel", "react", "tauri", "vite"],
    packageManagers: [
      "cargo",
      "composer",
      "docker",
      "go",
      "gradle",
      "pip",
      "pnpm",
    ],
    manifests: [
      "Cargo.toml",
      "Dockerfile",
      "build.gradle",
      "composer.json",
      "go.mod",
      "package.json",
      "pyproject.toml",
      "requirements.txt",
    ],
  });
});
