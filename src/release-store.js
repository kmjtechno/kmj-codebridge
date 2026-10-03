import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { releaseDirectoryName, releaseManifestSchema } from "./update.js";

const RELEASE_NAME =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$/;

function absoluteRoot(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(code);
  return path.resolve(value);
}

function ensureDirectory(target, mode = 0o755) {
  fs.mkdirSync(target, { recursive: true, mode });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UPDATE_RELEASE_ROOT_INVALID");
}

function safeReleaseName(name) {
  if (typeof name !== "string" || !RELEASE_NAME.test(name))
    fail("UPDATE_RELEASE_NAME_INVALID");
  return name;
}

function linkState(link, releases) {
  if (!fs.existsSync(link)) return null;
  const stat = fs.lstatSync(link);
  if (!stat.isSymbolicLink()) fail("UPDATE_RELEASE_LINK_INVALID");
  const target = fs.readlinkSync(link);
  const absolute = path.resolve(path.dirname(link), target);
  if (path.dirname(absolute) !== releases) fail("UPDATE_RELEASE_LINK_INVALID");
  const name = safeReleaseName(path.basename(absolute));
  const releaseStat = fs.lstatSync(absolute);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink())
    fail("UPDATE_RELEASE_LINK_INVALID");
  return name;
}

function atomicSymlink(link, releases, name) {
  if (process.platform === "win32") fail("UPDATE_ACTIVATION_UNSUPPORTED");
  safeReleaseName(name);
  const target = path.join(releases, name);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UPDATE_RELEASE_NOT_FOUND");

  if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink())
    fail("UPDATE_RELEASE_LINK_INVALID");

  const temp = `${link}.next-${process.pid}-${randomUUID()}`;
  try {
    fs.symlinkSync(path.relative(path.dirname(link), target), temp);
    fs.renameSync(temp, link);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export class ReleaseStore {
  constructor({ installRoot, stateDir, maxHistory = 50 }) {
    this.installRoot = absoluteRoot(installRoot, "UPDATE_RELEASE_ROOT_INVALID");
    this.stateDir = absoluteRoot(stateDir, "UPDATE_STATE_ROOT_INVALID");
    this.releases = path.join(this.installRoot, "releases");
    this.currentLink = path.join(this.installRoot, "current");
    this.previousLink = path.join(this.installRoot, "previous");
    this.historyFile = path.join(this.stateDir, "release-history.json");
    this.maxHistory = Math.max(5, Math.min(Number(maxHistory) || 50, 200));
    ensureDirectory(this.installRoot);
    ensureDirectory(this.releases);
    ensureDirectory(this.stateDir, 0o700);
  }

  staging(manifest) {
    releaseManifestSchema.parse(manifest);
    const name = releaseDirectoryName(manifest);
    const target = path.join(this.releases, name);
    if (fs.existsSync(target)) fail("UPDATE_RELEASE_EXISTS");
    const staging = path.join(
      this.releases,
      `.staging-${name}-${randomUUID()}`,
    );
    fs.mkdirSync(staging, { mode: 0o700 });
    return { name, staging, target };
  }

  finalize(manifest, staging) {
    releaseManifestSchema.parse(manifest);
    const name = releaseDirectoryName(manifest);
    const releases = this.releases;
    const expectedPrefix = path.join(releases, `.staging-${name}-`);
    const resolved = path.resolve(staging);
    if (
      !resolved.startsWith(expectedPrefix) ||
      path.dirname(resolved) !== releases
    )
      fail("UPDATE_STAGING_PATH_INVALID");

    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("UPDATE_STAGING_PATH_INVALID");

    const pkgPath = path.join(resolved, "package.json");
    const cliPath = path.join(resolved, "src", "cli.js");
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      fail("UPDATE_STAGED_RUNTIME_INVALID");
    }
    if (
      pkg.name !== "@kmjtechno/codebridge" ||
      pkg.version !== manifest.version ||
      !fs.existsSync(cliPath) ||
      !fs.lstatSync(cliPath).isFile()
    )
      fail("UPDATE_STAGED_RUNTIME_INVALID");

    const marker = {
      schema: 1,
      version: manifest.version,
      revision: manifest.revision,
      sha256: manifest.sha256,
    };
    fs.writeFileSync(
      path.join(resolved, ".codebridge-release.json"),
      JSON.stringify(marker) + "\n",
      { mode: 0o444, flag: "wx" },
    );

    const target = path.join(releases, name);
    if (fs.existsSync(target)) fail("UPDATE_RELEASE_EXISTS");
    fs.renameSync(resolved, target);
    return { name, target };
  }

  status() {
    return {
      current: linkState(this.currentLink, this.releases),
      previous: linkState(this.previousLink, this.releases),
      history: this.history().slice(-10),
    };
  }

  activate(name) {
    name = safeReleaseName(name);
    const current = linkState(this.currentLink, this.releases);
    if (current === name)
      return {
        changed: false,
        current,
        previous: linkState(this.previousLink, this.releases),
      };

    if (current) atomicSymlink(this.previousLink, this.releases, current);
    atomicSymlink(this.currentLink, this.releases, name);
    this.record("activate", name, current);
    return { changed: true, current: name, previous: current };
  }

  rollback() {
    const current = linkState(this.currentLink, this.releases);
    const previous = linkState(this.previousLink, this.releases);
    if (!previous) fail("UPDATE_ROLLBACK_UNAVAILABLE");
    atomicSymlink(this.currentLink, this.releases, previous);
    if (current) atomicSymlink(this.previousLink, this.releases, current);
    this.record("rollback", previous, current);
    return { current: previous, previous: current };
  }

  history() {
    if (!fs.existsSync(this.historyFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      if (
        !Array.isArray(data) ||
        data.length > this.maxHistory ||
        data.some(
          (entry) =>
            !entry ||
            !["activate", "rollback"].includes(entry.action) ||
            !RELEASE_NAME.test(entry.release) ||
            (entry.previous !== null && !RELEASE_NAME.test(entry.previous)) ||
            typeof entry.at !== "string",
        )
      )
        fail("UPDATE_HISTORY_INVALID");
      return data;
    } catch (error) {
      if (error?.code === "UPDATE_HISTORY_INVALID") throw error;
      fail("UPDATE_HISTORY_INVALID");
    }
  }

  record(action, release, previous) {
    const history = this.history();
    history.push({
      action,
      release: safeReleaseName(release),
      previous: previous === null ? null : safeReleaseName(previous),
      at: new Date().toISOString(),
    });
    while (history.length > this.maxHistory) history.shift();
    const temp = `${this.historyFile}.tmp-${process.pid}-${randomUUID()}`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(history) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.historyFile);
  }
}
