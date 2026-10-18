import test from "node:test";
import assert from "node:assert/strict";
import { agentSchema } from "../src/config.js";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMMAND_PRESET_IDS,
  commandRequiresIsolatedLane,
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
    "main-platform-ui-ci",
    "python-standard",
    "cargo-standard",
    "cmake-standard",
    "windows-visual-qa",
    "windows-python-trial-qa",
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

test("opt-in CMake profiles run actual isolated configure, build and CTest", (t) => {
  for (const executable of ["cmake", "ctest"]) {
    const probe = spawnSync(executable, ["--version"], {
      shell: false,
      timeout: 10000,
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0) {
      t.skip("CMAKE_OR_CTEST_NOT_INSTALLED");
      return;
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-cmake-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "CMakeLists.txt"),
    [
      "cmake_minimum_required(VERSION 3.20)",
      "project(KMJProfileSmoke LANGUAGES NONE)",
      "enable_testing()",
      "add_custom_target(kmj_smoke ALL",
      "  COMMAND ${CMAKE_COMMAND} -E echo KMJ_BUILD_PASS)",
      "add_test(NAME kmj_sanity",
      "  COMMAND ${CMAKE_COMMAND} -E echo KMJ_TEST_PASS)",
    ].join("\n"),
  );

  const commands = agentSchema.parse({
    ...base,
    projects: [{ ...base.projects[0], commandPresets: ["cmake-standard"] }],
  }).projects[0].commands;
  for (const [profile, variant] of [
    ["cmake_configure", "default"],
    ["cmake_build", "release"],
    ["cmake_test", "release"],
  ]) {
    const configured = commands[profile];
    const spec = configured.variants[variant];
    const stdout = execFileSync(configured.command, spec.args, {
      cwd: root,
      shell: false,
      timeout: Math.min(spec.timeoutMs, 120000),
      windowsHide: true,
      encoding: "utf8",
    });
    if (profile === "cmake_test") {
      assert.match(stdout, /100% tests passed/i);
      assert.match(stdout, /kmj_sanity/);
    }
  }
});

test("Windows visual QA preset is explicitly opt-in, scoped and never a general shell", () => {
  const normal = agentSchema.parse(base).projects[0];
  assert.equal(normal.commands.windows_visual_qa, undefined);
  const enabled = agentSchema.parse({
    ...base,
    projects: [{ ...base.projects[0], commandPresets: ["windows-visual-qa"] }],
  }).projects[0];
  const p = enabled.commands.windows_visual_qa;
  assert.equal(p.category, "build");
  assert.equal(p.command, "node");
  assert.deepEqual(Object.keys(p.variants), [
    "capture",
    "compare",
    "accessibility",
  ]);
  for (const [variant, config] of Object.entries(p.variants)) {
    assert.deepEqual(config.args, ["scripts/codebridge-ui-qa.mjs", variant]);
    assert.equal(config.timeoutMs, 120000);
    assert.ok(!config.args.some((arg) => /[;&|]/.test(arg)));
  }
  assert.equal(enabled.commands.node_dev, undefined);
  assert.equal(enabled.commands.windows_visual_qa.variants.shell, undefined);
  assert.equal(enabled.commands.windows_visual_qa.variants.deploy, undefined);
});

test("Windows Python trial QA is opt-in, project-scoped and cannot execute shells or installers", () => {
  const baseline = agentSchema.parse(base).projects[0];
  assert.equal(baseline.commands.windows_python_trial_qa, undefined);

  const enabled = agentSchema.parse({
    ...base,
    projects: [
      { ...base.projects[0], commandPresets: ["windows-python-trial-qa"] },
    ],
  }).projects[0];
  const profile = enabled.commands.windows_python_trial_qa;
  assert.equal(profile.category, "build");
  assert.equal(profile.command, "node");
  assert.deepEqual(Object.keys(profile.variants), ["doctor", "tests", "smoke"]);
  for (const [variant, spec] of Object.entries(profile.variants)) {
    assert.deepEqual(spec.args, [
      "scripts/codebridge-python-trial-qa.mjs",
      variant,
    ]);
    assert.ok(spec.timeoutMs <= 300000);
    assert.ok(spec.args.every((arg) => !/[;&|$\r\n]/.test(arg)));
  }
  assert.equal(profile.variants.install, undefined);
  assert.equal(profile.variants.deploy, undefined);
  assert.equal(profile.variants.shell, undefined);
  assert.equal(profile.variants.gui_launch, undefined);
  assert.equal(enabled.commands.node_dev, undefined);
});

test("jobArchiveMaxEntries defaults to the archive's own default and stays bounded (issue #186)", () => {
  const defaulted = agentSchema.parse(base);
  assert.equal(defaulted.jobArchiveMaxEntries, 100000);
  const configured = agentSchema.parse({ ...base, jobArchiveMaxEntries: 7 });
  assert.equal(configured.jobArchiveMaxEntries, 7);
  for (const bad of [0, -1, 1.5, 1000001, "100000"]) {
    assert.throws(() =>
      agentSchema.parse({ ...base, jobArchiveMaxEntries: bad }),
    );
  }
});

test("Main Platform zero-cost CI preset is explicit, fixed and deploy-free", () => {
  assert.equal(
    agentSchema.parse(base).projects[0].commands.main_platform_ui_ci,
    undefined,
  );
  const enabled = agentSchema.parse({
    ...base,
    projects: [
      { ...base.projects[0], commandPresets: ["main-platform-ui-ci"] },
    ],
  }).projects[0];
  const p = enabled.commands.main_platform_ui_ci;
  assert.equal(p.category, "build");
  assert.equal(p.command, "npm");
  assert.deepEqual(Object.keys(p.variants), ["check", "types", "build"]);
  for (const [variant, script] of [
    ["check", "check"],
    ["types", "types:check"],
    ["build", "build"],
  ]) {
    assert.deepEqual(p.variants[variant].args, [
      "--prefix",
      "apps/platform",
      "run",
      script,
    ]);
    assert.equal(p.variants[variant].timeoutMs, 300000);
  }
  assert.equal(p.variants.deploy, undefined);
  assert.equal(p.variants.payment, undefined);
  assert.equal(p.variants.migrate, undefined);
});

test("frontend CI cannot use shared checkout, other command profiles retain compatibility", () => {
  assert.equal(commandRequiresIsolatedLane("main_platform_ui_ci"), true);
  for (const other of [
    "node_verify",
    "cargo_verify",
    "cmake_build",
    "build_echo",
    "",
    null,
  ]) {
    assert.equal(commandRequiresIsolatedLane(other), false);
  }
  const toolsSource = fs.readFileSync(
    new URL("../src/tools.js", import.meta.url),
    "utf8",
  );
  assert.ok(toolsSource.includes('a.command === "main_platform_ui_ci"'));
  assert.ok(toolsSource.includes("worktreeLanes().prepareCurrentHead("));
  assert.ok(
    toolsSource.includes(
      'if (pinned && !selectedLaneId) fail("WORKTREE_LANE_REQUIRED")',
    ),
  );
});
