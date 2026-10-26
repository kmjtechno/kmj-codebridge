#!/usr/bin/env node
// KMJ TECHNO — Home Office Calibration Pro: PowerShell-free existing-agent
// reconnect. NO re-pair, downloads, execution-policy change or credential copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEVICE = "kmj-homeoffice-desktop-5fvjmet";
const PROJECT = "kmj-calibration-pro";
const ORIGIN = "https://kmjtechno.com";
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GIT_ORIGINS = new Set([
  "https://github.com/kmjtechno/kmj-codebridge.git",
  "https://github.com/kmjtechno/kmj-codebridge",
  "git@github.com:kmjtechno/kmj-codebridge.git",
]);
const PROJECT_ORIGINS = new Set([
  "https://github.com/kmjtechno/kmj-calibration-pro.git",
  "https://github.com/kmjtechno/kmj-calibration-pro",
  "git@github.com:kmjtechno/kmj-calibration-pro.git",
]);

export function privatePath(p) {
  return typeof p === "string" && /(^|[\\/])private[\\/]/i.test(p);
}

export function approvedScope(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  if (
    c.id !== DEVICE ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(c.tenant ?? "") ||
    ![ORIGIN, ORIGIN + "/"].includes(c.gateway) ||
    !privatePath(c.stateDir) ||
    !path.isAbsolute(c.stateDir) ||
    !Array.isArray(c.projects) ||
    c.projects.length !== 1 ||
    c.projects[0]?.id !== PROJECT ||
    !path.isAbsolute(c.projects[0]?.root)
  ) return false;
  const inline = typeof c.token === "string" && c.token.length > 0;
  const external = typeof c.gatewayTokenFile === "string";
  if (inline === external) return false;
  if (inline) return c.token.length >= 32 && c.token.length <= 8192;
  return privatePath(c.gatewayTokenFile) && path.isAbsolute(c.gatewayTokenFile);
}

export function lockPid(text) {
  try {
    if (typeof text !== "string" || text.length > 2048) return null;
    const clean = text.trim();
    const value = /^[1-9]\d*$/.test(clean)
      ? Number(clean)
      : JSON.parse(clean)?.pid;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function deny(code) {
  if (!/^[A-Z][A-Z0-9_]{2,90}$/.test(code)) code = "LOCAL_CHECK_FAILED";
  console.error("CALIBRATION_RECONNECT=BLOCKED_" + code);
  process.exitCode = 2;
}

function ordinary(p, kind) {
  const absolute = path.resolve(p);
  let cursor = absolute;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw Error("REPARSE_PATH");
    if (cursor === absolute) {
      if (kind === "file" && (!stat.isFile() || stat.size > 262144)) {
        throw Error("PRIVATE_FILE_TYPE_OR_SIZE");
      }
      if (kind === "directory" && !stat.isDirectory()) {
        throw Error("DIRECTORY_TYPE");
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

function git(cwd, ...args) {
  const r = spawnSync("git.exe", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 12000,
    maxBuffer: 65536,
    shell: false,
  });
  if (r.error || r.status !== 0) throw Error("GIT_NOT_VERIFIED");
  return r.stdout.trim();
}

function originCheck(root, allowed, requireClean = false) {
  ordinary(root, "directory");
  const actualRoot = git(root, "rev-parse", "--show-toplevel");
  if (path.normalize(actualRoot).toLowerCase() !== path.normalize(root).toLowerCase()) {
    throw Error("GIT_ROOT_MISMATCH");
  }
  if (!allowed.has(git(root, "remote", "get-url", "origin"))) {
    throw Error("UNTRUSTED_GIT_ORIGIN");
  }
  if (!/^[a-f0-9]{40}$/.test(git(root, "rev-parse", "HEAD"))) {
    throw Error("RUNTIME_COMMIT_NOT_PINNED");
  }
  if (requireClean && git(root, "status", "--porcelain", "--untracked-files=no")) {
    throw Error("RUNTIME_DIRTY");
  }
}

function scanKnownPrivateFiles() {
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? "", "KMJ-CodeBridge", "private"),
    "D:\\KMJ-HyperSpeed\\private",
    "E:\\KMJ\\private",
    "E:\\KMJ\\CodeBridge-HomeOffice\\private",
  ];
  const seen = new Set();
  const matches = [];
  let entries = 0;
  for (const root of roots) {
    if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) continue;
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (++entries > 750) throw Error("PRIVATE_SCAN_LIMIT");
      ordinary(dir, "directory");
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const child = path.join(dir, item.name);
        if (item.isDirectory() && depth < 4) stack.push([child, depth + 1]);
        if (!item.isFile() || item.name.toLowerCase() !== "agent.json") continue;
        if (!privatePath(child)) continue;
        ordinary(child, "file");
        const normalized = child.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        let candidate;
        try {
          candidate = JSON.parse(fs.readFileSync(child, "utf8"));
        } catch {
          throw Error("PRIVATE_CONFIG_CORRUPT");
        }
        if (candidate?.id === DEVICE) {
          if (!approvedScope(candidate)) throw Error("PRIVATE_DEVICE_SCOPE_MISMATCH");
          matches.push({ file: child, config: candidate });
        }
      }
    }
  }
  if (matches.length > 1) throw Error("MULTIPLE_HOME_OFFICE_ENROLLMENTS");
  return matches[0] ?? null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

function existingLock(state) {
  const lock = path.join(state, "agent.lock");
  if (!fs.existsSync(lock)) return null;
  ordinary(lock, "file");
  const pid = lockPid(fs.readFileSync(lock, "utf8"));
  if (pid === null) throw Error("UNKNOWN_AGENT_LOCK_OWNER");
  return alive(pid) ? pid : null;
}

async function protectedGateway() {
  let response;
  try {
    response = await fetch(ORIGIN + "/agent/health", {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw Error("PUBLIC_GATEWAY_NETWORK");
  }
  // Anonymous challenge: never send a token or read response data.
  if (response.status !== 401) throw Error("PUBLIC_GATEWAY_NOT_AUTH_PROTECTED");
}

function freshHeartbeat(state, launchedAfter) {
  const file = path.join(state, "connection.json");
  if (!fs.existsSync(file)) return false;
  ordinary(file, "file");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const time = Date.parse(record?.connectedAt);
  return Number.isFinite(time) &&
    time >= launchedAfter - 2000 &&
    time <= Date.now() + 10000;
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check-only")) {
    throw Error("ARGUMENTS_INVALID");
  }
  if (process.platform !== "win32" || process.env.OS !== "Windows_NT") {
    throw Error("WINDOWS_REQUIRED");
  }
  if ((process.env.COMPUTERNAME ?? "").toLowerCase() !== "desktop-5fvjmet") {
    throw Error("WRONG_DEVICE");
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw Error("NODE24_REQUIRED");
  }
  originCheck(ROOT, GIT_ORIGINS, true);
  ordinary(path.join(ROOT, "src", "cli.js"), "file");
  ordinary(path.join(ROOT, "node_modules", "zod", "package.json"), "file");

  const found = scanKnownPrivateFiles();
  if (!found) {
    console.log("CALIBRATION_RECONNECT=EXISTING_ENROLLMENT_NOT_FOUND");
    console.log("NEXT=OWNER_APPROVED_PAIR_AFTER_MAIN_PLATFORM_FIX_LIVE");
    process.exitCode = 3;
    return;
  }
  const { file, config } = found;
  const state = ordinary(config.stateDir, "directory");
  const root = ordinary(config.projects[0].root, "directory");
  originCheck(root, PROJECT_ORIGINS);
  if (config.gatewayTokenFile) ordinary(config.gatewayTokenFile, "file");
  const lockedPid = existingLock(state);
  if (lockedPid !== null) {
    console.log("CALIBRATION_RECONNECT=PROCESS_EXISTS_ACCOUNT_READY_UNVERIFIED");
    console.log("NEXT=CHECK_CODEBRIDGE_CONNECTION_OVERVIEW");
    return;
  }

  await protectedGateway();
  console.log("PUBLIC_AGENT_AUTH_CHALLENGE=PASS");
  if (process.argv[2] === "--check-only") {
    console.log("CALIBRATION_RECONNECT=CHECK_ONLY_NO_CHANGES");
    return;
  }

  // The ONLY launched executable is the installed, clean, authorized Node
  // CodeBridge agent. No PowerShell, shell evaluation, task registration,
  // credential writes, process termination or project source modification.
  const since = Date.now();
  const child = spawn(process.execPath, [
    path.join(ROOT, "src", "cli.js"), "agent", file,
  ], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw Error("AGENT_START_FAILED");
  }
  child.unref();
  for (let n = 0; n < 40; n++) {
    await delay(1000);
    if (!alive(child.pid)) throw Error("AGENT_EXITED_BEFORE_HEARTBEAT");
    if (freshHeartbeat(state, since)) {
      console.log("CALIBRATION_RECONNECT=LOCAL_AUTHENTICATED_HEARTBEAT");
      console.log("ACCOUNT_SIDE_READY=VERIFY_CODEBRIDGE_CONNECTION_OVERVIEW");
      console.log("ENROLLMENT_AND_PROJECT_FILES=UNCHANGED");
      return;
    }
  }
  throw Error("AUTHENTICATED_HEARTBEAT_TIMEOUT");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Only allow bounded internal error codes, never paths, credentials,
    // stack traces, private filenames, HTTP bodies or local agent logs.
    deny(error?.message ?? "LOCAL_CHECK_FAILED");
  });
}
