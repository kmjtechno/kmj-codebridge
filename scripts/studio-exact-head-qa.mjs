import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// First-party bounded job, invoked only through the exact-head Studio profile.
// The job runner owns the overall deadline and process-tree cancellation.
export function planStudioQa({ cmake, ctest, qt, build }) {
  return [
    {
      name: "configure",
      command: cmake,
      args: [
        "-S",
        ".",
        "-B",
        build,
        "-G",
        "Visual Studio 18 2026",
        "-A",
        "x64",
        "-DCMAKE_PREFIX_PATH=" + qt,
        "-DBUILD_TESTING=ON",
      ],
    },
    {
      name: "build",
      command: cmake,
      args: ["--build", build, "--config", "Release", "--parallel", "4"],
    },
    {
      name: "ctest",
      command: ctest,
      args: [
        "--test-dir",
        build,
        "-C",
        "Release",
        "--output-on-failure",
        "--no-tests=error",
        "-R",
        "^(desktop-smoke|independent-engine|media-control)$",
      ],
    },
  ];
}

function ordinary(p, directory) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()))
    throw new Error("STUDIO_QA_UNSAFE_PATH");
}

export function validateStudioLane({ cwd, state }) {
  const base = path.join(state, "isolated-worktrees", "kmj-calibration-studio");
  const realBase = fs.realpathSync(base);
  const realCwd = fs.realpathSync(cwd);
  ordinary(base, true);
  ordinary(cwd, true);
  if (
    realBase.toLowerCase() !== path.resolve(base).toLowerCase() ||
    realCwd.toLowerCase() !== path.resolve(cwd).toLowerCase() ||
    path.dirname(realCwd).toLowerCase() !== realBase.toLowerCase() ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(path.basename(realCwd))
  )
    throw new Error("STUDIO_QA_EXACT_LANE_REQUIRED");
  ordinary(path.join(realCwd, ".git"), false);
  ordinary(path.join(realCwd, "CMakeLists.txt"), false);
  const build = path.join(realCwd, ".kmj-codebridge-exact-build");
  // No reuse of an unknown output tree and no deletion of owner data.
  if (fs.existsSync(build)) throw new Error("STUDIO_QA_BUILD_EXISTS");
  return { cwd: realCwd, build };
}

function main() {
  if (process.platform !== "win32" || process.argv.length !== 6)
    throw new Error("STUDIO_QA_SCOPE");
  const [state, cmake, ctest, qt] = process.argv.slice(2);
  for (const value of [state, cmake, ctest, qt]) {
    if (!path.isAbsolute(value)) throw new Error("STUDIO_QA_SCOPE");
  }
  ordinary(cmake, false);
  ordinary(ctest, false);
  ordinary(path.join(qt, "bin", "Qt6Core.dll"), false);
  const { cwd, build } = validateStudioLane({ cwd: process.cwd(), state });
  const env = {
    ...process.env,
    PATH: path.join(qt, "bin") + path.delimiter + process.env.PATH,
  };
  for (const stage of planStudioQa({ cmake, ctest, qt, build })) {
    const result = spawnSync(stage.command, stage.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error("STUDIO_EXACT_QA_STAGE_FAILED=" + stage.name);
      process.exitCode = 1;
      return;
    }
    console.log("STUDIO_EXACT_QA_STAGE_PASS=" + stage.name);
  }
  console.log("STUDIO_EXACT_QA=PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error("STUDIO_EXACT_QA=BLOCKED");
    process.exitCode = 2;
  }
}
