import test from "node:test";
import assert from "node:assert/strict";
import { agentSchema } from "../src/config.js";
import {
  COMMAND_PRESET_IDS,
  expandCommandPresets,
} from "../src/command-presets.js";

const base = {
  gateway: "https://gateway.example.test",
  token: "x".repeat(32),
  id: "device1",
  tenant: "tenant1",
  stateDir: "/tmp/codebridge-state",
  projects: [
    {
      id: "project1",
      root: "/tmp/project",
      writable: true,
      gates: {},
      commands: {},
    },
  ],
  license: { mode: "free" },
};

test("command presets are fixed, bounded and never expose a shell profile", () => {
  assert.deepEqual(COMMAND_PRESET_IDS, [
    "node-standard",
    "python-standard",
    "cargo-standard",
    "cmake-standard",
    "go-standard",
  ]);
  const commands = expandCommandPresets(COMMAND_PRESET_IDS);
  assert.ok(Object.keys(commands).length >= 8);
  for (const profile of Object.values(commands)) {
    assert.ok(["build", "write", "network"].includes(profile.category));
    assert.ok(
      !["sh", "bash", "cmd", "powershell", "pwsh"].includes(profile.command),
    );
    assert.ok(Object.keys(profile.variants).length > 0);
    for (const variant of Object.values(profile.variants)) {
      assert.ok(variant.args.length <= 32);
      assert.ok(variant.timeoutMs <= 300000);
    }
  }
});

test("agent config expands only explicitly selected command presets", () => {
  const parsed = agentSchema.parse({
    ...base,
    projects: [{ ...base.projects[0], commandPresets: ["node-standard"] }],
  });
  const project = parsed.projects[0];
  assert.deepEqual(project.commandPresets, ["node-standard"]);
  assert.deepEqual(Object.keys(project.commands), [
    "node_deps",
    "node_verify",
    "node_format",
    "node_dev",
  ]);
  assert.equal(project.commands.node_deps.command, "npm");
  assert.deepEqual(project.commands.node_verify.variants.typecheck.args, [
    "run",
    "typecheck",
  ]);
});

test("explicit administrator commands override a preset by exact profile id", () => {
  const parsed = agentSchema.parse({
    ...base,
    projects: [
      {
        ...base.projects[0],
        commandPresets: ["node-standard"],
        commands: {
          node_verify: {
            category: "build",
            description: "Administrator-specific verification.",
            command: "node",
            variants: {
              verify: { args: ["scripts/verify.mjs"], timeoutMs: 120000 },
            },
          },
        },
      },
    ],
  });
  assert.equal(parsed.projects[0].commands.node_verify.command, "node");
  assert.deepEqual(
    Object.keys(parsed.projects[0].commands.node_verify.variants),
    ["verify"],
  );
  assert.ok(parsed.projects[0].commands.node_deps);
});

test("unknown command presets fail closed", () => {
  assert.throws(
    () =>
      agentSchema.parse({
        ...base,
        projects: [{ ...base.projects[0], commandPresets: ["raw-shell"] }],
      }),
    /Invalid enum value|Invalid option/,
  );
});

test("CMake profiles require explicit project opt-in and never advertise install or deploy", () => {
  const defaultProject = agentSchema.parse(base).projects[0];
  assert.deepEqual(defaultProject.commands, {});

  const enabled = agentSchema.parse({
    ...base,
    projects: [{ ...base.projects[0], commandPresets: ["cmake-standard"] }],
  }).projects[0];
  assert.deepEqual(Object.keys(enabled.commands), [
    "cmake_configure",
    "cmake_build",
    "cmake_test",
  ]);
  assert.deepEqual(enabled.commands.cmake_configure.variants.default.args, [
    "-S",
    ".",
    "-B",
    ".kmj-codebridge-build",
  ]);
  assert.deepEqual(enabled.commands.cmake_build.variants.release.args, [
    "--build",
    ".kmj-codebridge-build",
    "--config",
    "Release",
    "--parallel",
    "2",
  ]);
  assert.deepEqual(enabled.commands.cmake_test.variants.debug.args, [
    "--test-dir",
    ".kmj-codebridge-build",
    "--output-on-failure",
    "-C",
    "Debug",
    "--parallel",
    "2",
  ]);
  for (const profile of Object.values(enabled.commands)) {
    assert.equal(profile.category, "build");
    assert.ok(["cmake", "ctest"].includes(profile.command));
    assert.ok(
      Object.keys(profile.variants).every((name) =>
        ["default", "debug", "release"].includes(name),
      ),
    );
    for (const variant of Object.values(profile.variants)) {
      assert.ok(variant.timeoutMs <= 300000);
      assert.ok(!variant.args.some((x) => /[;&|]/.test(x)));
      assert.equal(variant.args.at(-1) !== "install", true);
    }
  }
  assert.equal(enabled.commands.cmake_build.variants.deploy, undefined);
});
