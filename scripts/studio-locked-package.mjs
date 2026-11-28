import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateStudioLane } from "./studio-exact-head-qa.mjs";

const SHA = /^[a-f0-9]{40}$/;

export function planStudioPackaging({ powershell, qt, sha }) {
  if (!SHA.test(sha)) throw Error("STUDIO_PACKAGE_SHA_REQUIRED");
  const prefix = ["-NoProfile", "-NonInteractive", "-File"];
  return [
    {
      name: "acceptance",
      command: powershell,
      args: [
        ...prefix,
        "scripts/verify_locked_release.ps1",
        "-ExpectedSha",
        sha,
        "-QtRoot",
        qt,
        "-Generator",
        "Visual Studio 18 2026",
      ],
    },
    {
      name: "candidate",
      command: powershell,
      args: [
        ...prefix,
        "scripts/package_windows_release.ps1",
        "-ExpectedSha",
        sha,
      ],
    },
  ];
}

function ordinary(file) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()
  )
    throw Error("STUDIO_PACKAGE_UNSAFE_FILE");
}

function main() {
  if (process.platform !== "win32" || process.argv.length !== 6)
    throw Error("STUDIO_PACKAGE_SCOPE");
  const [state, git, powershell, qt] = process.argv.slice(2);
  if (![state, git, powershell, qt].every((p) => path.isAbsolute(p)))
    throw Error("STUDIO_PACKAGE_SCOPE");
  ordinary(git);
  ordinary(powershell);
  ordinary(path.join(qt, "bin", "Qt6Core.dll"));
  const { cwd } = validateStudioLane({ cwd: process.cwd(), state });
  const gitRead = (...args) => {
    const result = spawnSync(git, args, {
      cwd,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 262144,
    });
    if (result.error || result.status !== 0)
      throw Error("STUDIO_PACKAGE_GIT_CHECK_FAILED");
    return result.stdout.trim();
  };
  const sha = gitRead("rev-parse", "HEAD");
  if (
    !SHA.test(sha) ||
    gitRead("rev-parse", "--abbrev-ref", "HEAD") !== "HEAD" ||
    gitRead("status", "--porcelain", "--untracked-files=all")
  )
    throw Error("STUDIO_PACKAGE_CLEAN_DETACHED_HEAD_REQUIRED");

  // Use only tracked, ordinary scripts from the reviewed detached source.
  // Missing historical source blocks packaging instead of borrowing local edits.
  for (const relative of [
    "build.ps1",
    "scripts/verify_locked_release.ps1",
    "scripts/package_windows_release.ps1",
  ]) {
    ordinary(path.join(cwd, relative));
    gitRead("ls-files", "--error-unmatch", "--", relative);
  }
  for (const dir of ["build", "dist", "artifacts"]) {
    if (fs.existsSync(path.join(cwd, dir)))
      throw Error("STUDIO_PACKAGE_OUTPUT_COLLISION");
  }
  for (const stage of planStudioPackaging({ powershell, qt, sha })) {
    if (
      gitRead("rev-parse", "HEAD") !== sha ||
      gitRead("status", "--porcelain", "--untracked-files=no")
    )
      throw Error("STUDIO_PACKAGE_SOURCE_CHANGED");
    const result = spawnSync(stage.command, stage.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    if (result.error || result.signal || result.status !== 0)
      throw Error("STUDIO_PACKAGE_STAGE_FAILED");
    console.log("STUDIO_PACKAGE_STAGE_PASS=" + stage.name);
  }
  if (
    gitRead("rev-parse", "HEAD") !== sha ||
    gitRead("status", "--porcelain", "--untracked-files=no")
  )
    throw Error("STUDIO_PACKAGE_SOURCE_CHANGED");
  console.log("EXACT_SOURCE_SHA=" + sha);
  console.log("BUILD_CANDIDATE=PASS");
  console.log("CALIBRATION_RELEASE_APPROVED=NO");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch {
    console.error("STUDIO_PACKAGE=BLOCKED");
    process.exitCode = 1;
  }
}
