#!/usr/bin/env node
// One fixed development runtime source -> one immutable, unprivileged-readable
// stage. This is NOT a signed production release, license, or activation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE = "/opt/kmj-codebridge-agent";
const DESTINATION = "/opt/kmj-codebridge-main-platform-stage";
const safeSha = /^[a-f0-9]{40}$/;

function git(source, ...args) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function safeDirectory(directory, uid) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid ||
      (st.mode & 0o022) !== 0) {
    throw new Error("MAIN_PLATFORM_STAGE_SOURCE_UNSAFE");
  }
}

function inspectLinks(directory, base) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    const stat = fs.lstatSync(location);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(location);
      if (!target.startsWith(base + path.sep)) {
        throw new Error("MAIN_PLATFORM_STAGE_LINK_ESCAPE");
      }
    } else if (stat.isDirectory()) {
      inspectLinks(location, base);
    } else if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("MAIN_PLATFORM_STAGE_FILE_UNSAFE");
    }
  }
}

function readonly(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    const stat = fs.lstatSync(location);
    if (stat.isDirectory()) {
      readonly(location);
      fs.chmodSync(location, 0o555);
    } else if (stat.isFile()) {
      fs.chmodSync(location, (stat.mode & 0o111) !== 0 ? 0o555 : 0o444);
    }
  }
}

// Paths are injected only by local unit tests. The CLI below has NO arguments,
// path overrides, URL overrides, or user-controlled service names.
export function stageRuntime({ source = SOURCE, destination = DESTINATION,
  requireRoot = true } = {}) {
  if (requireRoot && (typeof process.getuid !== "function" ||
      process.getuid() !== 0)) {
    throw new Error("MAIN_PLATFORM_STAGE_REQUIRES_ROOT");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  safeDirectory(source, uid);
  if (fs.lstatSync(path.join(source, ".git")).isSymbolicLink()) {
    throw new Error("MAIN_PLATFORM_STAGE_GIT_UNSAFE");
  }
  const sha = git(source, "rev-parse", "HEAD");
  const upstream = git(source, "rev-parse", "refs/remotes/origin/main");
  if (!safeSha.test(sha) || sha !== upstream ||
      git(source, "status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("MAIN_PLATFORM_STAGE_REVISION_UNVERIFIED");
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (pkg.name !== "@kmjtechno/codebridge" ||
      typeof pkg.version !== "string" ||
      !fs.existsSync(path.join(source, "package-lock.json")) ||
      !fs.lstatSync(path.join(source, "node_modules")).isDirectory()) {
    throw new Error("MAIN_PLATFORM_STAGE_DEPENDENCIES_UNVERIFIED");
  }

  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { mode: 0o700 });
  }
  safeDirectory(destination, uid);
  const final = path.join(destination, sha);
  if (fs.existsSync(final)) {
    const stat = fs.lstatSync(final);
    const manifest = JSON.parse(fs.readFileSync(path.join(final, ".stage.json"), "utf8"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
        (stat.mode & 0o222) !== 0 || manifest.sha !== sha ||
        manifest.package !== "@kmjtechno/codebridge" ||
        !fs.lstatSync(path.join(final, "src/cli.js")).isFile()) {
      throw new Error("MAIN_PLATFORM_STAGE_EXISTING_UNSAFE");
    }
    fs.chmodSync(destination, 0o711);
    return { sha, directory: final, created: false };
  }

  const temporary = fs.mkdtempSync(path.join(destination, ".stage-"));
  try {
    const paths = execFileSync("git", ["-C", source, "ls-files", "-z"], {
      timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    }).toString("utf8").split("\0").filter(Boolean);
    if (!paths.includes("src/cli.js") || !paths.includes("package-lock.json") ||
        paths.length > 10000) {
      throw new Error("MAIN_PLATFORM_STAGE_TRACKED_PATHS_UNSAFE");
    }
    for (const relative of paths) {
      if (path.isAbsolute(relative) || relative.split("/").some(part =>
          part === "." || part === ".." || part === "")) {
        throw new Error("MAIN_PLATFORM_STAGE_PATH_TRAVERSAL");
      }
      const sourceFile = path.join(source, relative);
      const stat = fs.lstatSync(sourceFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("MAIN_PLATFORM_STAGE_TRACKED_FILE_UNSAFE");
      }
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(sourceFile, target, fs.constants.COPYFILE_EXCL);
    }
    fs.cpSync(path.join(source, "node_modules"), path.join(temporary, "node_modules"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    inspectLinks(temporary, temporary);
    const stagePkg = JSON.parse(fs.readFileSync(path.join(temporary, "package.json"), "utf8"));
    if (stagePkg.name !== pkg.name || stagePkg.version !== pkg.version) {
      throw new Error("MAIN_PLATFORM_STAGE_PACKAGE_MISMATCH");
    }
    const manifest = {
      sha, package: pkg.name, version: pkg.version,
      packageLockSha256: crypto.createHash("sha256").update(
        fs.readFileSync(path.join(temporary, "package-lock.json"))).digest("hex"),
    };
    fs.writeFileSync(path.join(temporary, ".stage.json"),
      JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
    readonly(temporary);
    fs.chmodSync(temporary, 0o555);
    fs.renameSync(temporary, final);
    fs.chmodSync(destination, 0o711);
    return { sha, directory: final, created: true };
  } catch (error) {
    // Only this caller-created temporary directory can be cleaned.
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    throw new Error("MAIN_PLATFORM_STAGE_ACCEPTS_NO_ARGUMENTS");
  }
  const stage = stageRuntime();
  process.stdout.write("MAIN_PLATFORM_RUNTIME_STAGED_SHA=" + stage.sha + "\n");
  process.stdout.write("MAIN_PLATFORM_RUNTIME_STAGE_PATH=" + stage.directory + "\n");
}
