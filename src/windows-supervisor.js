import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { agentSchema } from "./config.js";
import { CodeBridgeError, fail, publicError } from "./errors.js";
import { redact } from "./jobs.js";
import {
  boundedDeviceStatus,
  classifySupervisorConfigError,
  defaultDeviceStatus,
} from "./supervisor.js";
import { runtimeRevision } from "./runtime-revision.js";

// Windows-native local supervisor.
//
// Differences from the Linux supervisor are deliberate and explicit:
//  - transport is a named pipe, never a Unix socket, and every connection must
//    pass an HMAC challenge-response using a secret from an ACL-restricted file;
//  - there is no systemd, journalctl, update timer or gateway control here. Any
//    operation that has no truthful Windows implementation is refused with a
//    fixed code instead of being routed anywhere;
//  - the caller never supplies an executable, argv, cwd, environment, service
//    name, task name or path. Those come only from the operator's config file.
//
// This module never starts itself. Activation is an operator step (see
// docs/WINDOWS-SUPERVISOR.md).

const SHA = /^[a-f0-9]{40}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PIPE_NAME = /^kmj-codebridge-supervisor-[a-z0-9-]{1,40}$/;
const MAX_REQUEST_BYTES = 8192;
const MAX_CONNECTIONS = 4;
const STAGES = ["configure", "build", "ctest"];
const WIN32_SYSTEM_DIR = "C:\\Windows\\System32";

export const WINDOWS_SUPERVISOR_OPS = Object.freeze([
  "status",
  "config_validate",
  "restart",
  "device_status",
  "disk_space",
  "project_status",
  "project_verify_prepare",
  "project_verify_stage",
  "project_verify_release",
]);

// Strict absolute-path check. For Windows it requires a drive letter
// (C:\ or C:/) or a UNC share (\\server\share); drive-relative (C:foo),
// rooted-without-drive (\foo), device/extended namespaces (\\.\ and \\?\),
// alternate data streams, wildcard/reserved characters, control characters
// and any ".." segment are refused. POSIX only needs an absolute path
// without traversal (used by tests on non-Windows hosts).
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH =
  /^\\\\[^\\/?.<>:"|*\s][^\\/?<>:"|*]*[\\/][^\\/?<>:"|*]+/;
export function isSafeAbsolutePath(value, pathLib = path.win32) {
  if (typeof value !== "string" || value.length < 3 || value.length > 260)
    return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return false;
  if (value.split(/[\\/]/).includes("..")) return false;
  if (pathLib === path.win32) {
    const unc = WINDOWS_UNC_PATH.test(value);
    if (!WINDOWS_DRIVE_PATH.test(value) && !unc) return false;
    // After the drive prefix a colon would be an alternate data stream.
    const rest = unc ? value : value.slice(2);
    if (/[<>:"|?*]/.test(rest.slice(unc ? 2 : 0))) return false;
    return pathLib.isAbsolute(value);
  }
  return pathLib.isAbsolute(value);
}

function absolutePath(pathLib) {
  return z
    .string()
    .refine(
      (value) => isSafeAbsolutePath(value, pathLib),
      "absolute path without traversal required",
    );
}

export function createWindowsSupervisorConfigSchema(pathLib = path.win32) {
  const abs = absolutePath(pathLib);
  return z
    .object({
      pipeName: z.string().regex(PIPE_NAME),
      tokenFile: abs,
      agent: z
        .object({
          installDir: abs,
          configPath: abs,
          restartTask: z.string().regex(TASK_NAME).optional(),
        })
        .strict(),
      projects: z
        .array(
          z
            .object({
              id: z.string().regex(PROJECT_ID),
              repoRoot: abs,
              worktreeRoot: abs,
              gitExe: abs,
              cmakeExe: abs,
              ctestExe: abs,
              qtPrefix: abs.optional(),
              generator: z.enum(["Ninja", "Visual Studio 17 2022"]),
              buildType: z.enum(["Release", "Debug"]).default("Release"),
              allowFetch: z.boolean().default(false),
              pathDirs: z.array(abs).max(8).default([]),
              stageTimeoutSeconds: z
                .number()
                .int()
                .min(30)
                .max(7200)
                .default(1800),
              maxLogBytes: z
                .number()
                .int()
                .min(65536)
                .max(4194304)
                .default(1048576),
            })
            .strict(),
        )
        .max(4)
        .default([]),
    })
    .strict();
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_SUPERVISOR_REQUEST");
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_SUPERVISOR_REQUEST");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Bounded child execution: fixed argv, no shell, hard timeout with process-tree
// kill, capped captured output. Returns a receipt-shaped object.
export function runBounded(
  exe,
  args,
  { cwd, env, timeoutMs, maxBytes, spawnImpl = spawn, killTree = () => {} },
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawnImpl(exe, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({
        exitCode: null,
        spawnFailed: true,
        timedOut: false,
        truncated: false,
        output: "",
        logSha256: sha256(""),
        durationMs: 0,
      });
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (chunk) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killTree(child.pid);
      } catch {}
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    let settled = false;
    const finish = (exitCode, spawnFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({
        exitCode,
        spawnFailed,
        timedOut,
        truncated,
        output: redact(raw),
        logSha256: sha256(raw),
        durationMs: Date.now() - started,
      });
    };
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code));
  });
}

export function createWindowsSupervisorHandler({
  config,
  pathLib = path.win32,
  runner = runBounded,
  readFile = (file) => fs.readFileSync(file, "utf8"),
  exists = (target) => fs.existsSync(target),
  mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }),
  writeFile = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 }),
  statfs = (target) => fs.statfsSync(target),
  deviceStatus = defaultDeviceStatus,
  revision = runtimeRevision,
  schtasksExe = `${WIN32_SYSTEM_DIR}\\schtasks.exe`,
  taskkillExe = `${WIN32_SYSTEM_DIR}\\taskkill.exe`,
  spawnImpl = spawn,
  env = process.env,
  now = () => new Date(),
} = {}) {
  let busy = false;

  const project = (id) => {
    if (typeof id !== "string" || !PROJECT_ID.test(id))
      fail("INVALID_SUPERVISOR_REQUEST");
    const found = config.projects.find((entry) => entry.id === id);
    if (!found) fail("SUPERVISOR_PROJECT_NOT_AUTHORIZED");
    return found;
  };

  const baseEnv = (p) => ({
    SystemRoot: env.SystemRoot ?? "C:\\Windows",
    windir: env.windir ?? env.SystemRoot ?? "C:\\Windows",
    TEMP: pathLib.join(p.worktreeRoot, "tmp"),
    TMP: pathLib.join(p.worktreeRoot, "tmp"),
    PATH: [...p.pathDirs, WIN32_SYSTEM_DIR].join(";"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });

  const exec = (p, exe, args, cwd, { timeoutMs, maxBytes } = {}) =>
    runner(exe, args, {
      cwd,
      env: baseEnv(p),
      timeoutMs: timeoutMs ?? 60000,
      maxBytes: maxBytes ?? 262144,
      spawnImpl,
      killTree: (pid) => {
        if (Number.isInteger(pid) && pid > 0)
          spawnImpl(taskkillExe, ["/PID", String(pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
      },
    });

  const git = (p, cwd, args, opts) =>
    exec(
      p,
      p.gitExe,
      ["--no-optional-locks", "-c", "core.hooksPath=NUL", ...args],
      cwd,
      opts,
    );

  const worktreeDir = (p, sha) =>
    pathLib.join(p.worktreeRoot, "wt", sha.slice(0, 12));

  const checkoutDigest = async (p) => {
    const r = await git(p, p.repoRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (r.exitCode !== 0 || r.truncated) return null;
    return { digest: sha256(r.output), dirty: r.output.length > 0 };
  };

  const withLock = async (fn) => {
    if (busy) fail("SUPERVISOR_BUSY");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  const agentTaskState = async () => {
    const task = config.agent.restartTask;
    if (!task) return { exists: false, state: "unknown" };
    const r = await runner(
      schtasksExe,
      ["/Query", "/TN", task, "/FO", "CSV", "/NH"],
      {
        env: { SystemRoot: env.SystemRoot ?? "C:\\Windows" },
        timeoutMs: 10000,
        maxBytes: 8192,
        spawnImpl,
      },
    );
    if (r.exitCode !== 0) return { exists: false, state: "unknown" };
    const columns = r.output.trim().split(/","/);
    const state = (columns[columns.length - 1] ?? "").replace(/"/g, "").trim();
    return { exists: true, state: state ? state.slice(0, 32) : "unknown" };
  };

  return async function handle(request) {
    exactKeys(request, ["op", "service", "projectId", "sha", "stage"]);
    if (typeof request.op !== "string") fail("INVALID_SUPERVISOR_REQUEST");

    if (request.op === "device_status") {
      exactKeys(request, ["op"]);
      return { response: boundedDeviceStatus(deviceStatus()) };
    }

    if (request.op === "status") {
      exactKeys(request, ["op", "service"]);
      if (request.service !== "agent") fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
      const task = await agentTaskState();
      const rev = revision(config.agent.installDir);
      return {
        response: {
          service: "agent",
          platform: "win32",
          supervisor: "windows-native",
          installed: exists(config.agent.installDir),
          runtime: rev ? { commit: rev.commit, source: rev.source } : null,
          state: task.state,
          restart: {
            supported: Boolean(config.agent.restartTask) && task.exists,
            mechanism: config.agent.restartTask ? "scheduled-task" : null,
          },
          // Truthful: no Windows updater exists yet; do not imply one.
          update: {
            supported: false,
            reason: "WINDOWS_UPDATE_NOT_IMPLEMENTED",
          },
        },
      };
    }

    if (request.op === "config_validate") {
      exactKeys(request, ["op", "service"]);
      if (request.service !== "agent") fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
      try {
        agentSchema.parse(JSON.parse(readFile(config.agent.configPath)));
        return { response: { service: "agent", valid: true } };
      } catch (error) {
        return {
          response: {
            service: "agent",
            valid: false,
            reason: classifySupervisorConfigError(error),
          },
        };
      }
    }

    if (request.op === "restart") {
      exactKeys(request, ["op", "service"]);
      if (request.service !== "agent") fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
      const task = await agentTaskState();
      if (!config.agent.restartTask || !task.exists)
        fail("SUPERVISOR_RESTART_UNAVAILABLE");
      const taskName = config.agent.restartTask;
      return {
        response: { service: "agent", accepted: true },
        afterSend: async () => {
          const opts = {
            env: { SystemRoot: env.SystemRoot ?? "C:\\Windows" },
            timeoutMs: 15000,
            maxBytes: 8192,
            spawnImpl,
          };
          await runner(schtasksExe, ["/End", "/TN", taskName], opts);
          await runner(schtasksExe, ["/Run", "/TN", taskName], opts);
        },
      };
    }

    if (request.op === "disk_space") {
      exactKeys(request, ["op"]);
      const target =
        config.projects[0]?.worktreeRoot ?? config.agent.installDir;
      if (!exists(target)) fail("SUPERVISOR_UNAVAILABLE");
      const stats = statfs(target);
      const blockSize = Number(stats.bsize);
      return {
        response: {
          target: pathLib.parse(target).root,
          totalBytes: Number(stats.blocks) * blockSize,
          freeBytes: Number(stats.bavail) * blockSize,
        },
      };
    }

    if (request.op === "project_status") {
      exactKeys(request, ["op", "projectId"]);
      const p = project(request.projectId);
      const present = exists(p.repoRoot);
      return {
        response: {
          projectId: p.id,
          present,
          directory: present,
          gitCheckout: present && exists(pathLib.join(p.repoRoot, ".git")),
          verification: {
            supported: true,
            stages: STAGES,
            allowFetch: p.allowFetch,
          },
        },
      };
    }

    if (request.op === "project_verify_prepare") {
      exactKeys(request, ["op", "projectId", "sha"]);
      const p = project(request.projectId);
      if (typeof request.sha !== "string" || !SHA.test(request.sha))
        fail("INVALID_SUPERVISOR_REQUEST");
      return await withLock(async () => {
        const before = await checkoutDigest(p);
        if (!before) fail("SUPERVISOR_GIT_FAILED");
        let have = await git(p, p.repoRoot, [
          "cat-file",
          "-e",
          `${request.sha}^{commit}`,
        ]);
        let fetched = false;
        if (have.exitCode !== 0 && p.allowFetch) {
          // Object database only; never touches the working tree or index.
          const f = await git(
            p,
            p.repoRoot,
            ["fetch", "--no-tags", "origin", request.sha],
            { timeoutMs: 300000 },
          );
          fetched = f.exitCode === 0;
          have = await git(p, p.repoRoot, [
            "cat-file",
            "-e",
            `${request.sha}^{commit}`,
          ]);
        }
        if (have.exitCode !== 0) fail("SUPERVISOR_SHA_NOT_AVAILABLE");
        const dir = worktreeDir(p, request.sha);
        mkdir(pathLib.join(p.worktreeRoot, "wt"));
        mkdir(pathLib.join(p.worktreeRoot, "tmp"));
        let reused = exists(dir);
        if (!reused) {
          const add = await git(p, p.repoRoot, [
            "worktree",
            "add",
            "--detach",
            dir,
            request.sha,
          ]);
          if (add.exitCode !== 0) fail("SUPERVISOR_WORKTREE_FAILED");
        }
        const head = await git(p, dir, ["rev-parse", "HEAD"]);
        if (head.exitCode !== 0 || head.output.trim() !== request.sha)
          fail("SUPERVISOR_WORKTREE_UNVERIFIED");
        const after = await checkoutDigest(p);
        return {
          response: {
            projectId: p.id,
            sha: request.sha,
            worktree: dir,
            reused,
            fetched,
            originalCheckout: {
              dirtyBefore: before.dirty,
              unchanged: Boolean(after && after.digest === before.digest),
            },
          },
        };
      });
    }

    if (request.op === "project_verify_stage") {
      exactKeys(request, ["op", "projectId", "sha", "stage"]);
      const p = project(request.projectId);
      if (
        typeof request.sha !== "string" ||
        !SHA.test(request.sha) ||
        !STAGES.includes(request.stage)
      )
        fail("INVALID_SUPERVISOR_REQUEST");
      return await withLock(async () => {
        const dir = worktreeDir(p, request.sha);
        if (!exists(dir)) fail("SUPERVISOR_WORKTREE_MISSING");
        const head = await git(p, dir, ["rev-parse", "HEAD"]);
        if (head.exitCode !== 0 || head.output.trim() !== request.sha)
          fail("SUPERVISOR_WORKTREE_UNVERIFIED");
        const buildDir = pathLib.join(dir, "build");
        let exe;
        let args;
        if (request.stage === "configure") {
          exe = p.cmakeExe;
          args = [
            "-S",
            dir,
            "-B",
            buildDir,
            "-G",
            p.generator,
            `-DCMAKE_BUILD_TYPE=${p.buildType}`,
          ];
          if (p.qtPrefix) args.push(`-DCMAKE_PREFIX_PATH=${p.qtPrefix}`);
        } else if (request.stage === "build") {
          exe = p.cmakeExe;
          args = ["--build", buildDir, "--config", p.buildType];
        } else {
          exe = p.ctestExe;
          args = [
            "--test-dir",
            buildDir,
            "-C",
            p.buildType,
            "--output-on-failure",
            "--timeout",
            "120",
          ];
        }
        const result = await exec(p, exe, args, dir, {
          timeoutMs: p.stageTimeoutSeconds * 1000,
          maxBytes: p.maxLogBytes,
        });
        const receipt = {
          schema: 1,
          projectId: p.id,
          sha: request.sha,
          stage: request.stage,
          exitCode: result.exitCode,
          passed:
            result.exitCode === 0 && !result.timedOut && !result.spawnFailed,
          timedOut: result.timedOut,
          spawnFailed: result.spawnFailed,
          logTruncated: result.truncated,
          durationMs: result.durationMs,
          logSha256: result.logSha256,
          at: now().toISOString(),
        };
        try {
          const dirReceipts = pathLib.join(p.worktreeRoot, "receipts");
          mkdir(dirReceipts);
          const body = JSON.stringify(receipt, null, 2);
          writeFile(
            pathLib.join(
              dirReceipts,
              `${request.sha.slice(0, 12)}-${request.stage}.json`,
            ),
            body,
          );
          receipt.receiptSha256 = sha256(body);
        } catch {
          receipt.receiptSha256 = null;
        }
        return {
          response: { ...receipt, logTail: result.output.slice(-4096) },
        };
      });
    }

    if (request.op === "project_verify_release") {
      exactKeys(request, ["op", "projectId", "sha"]);
      const p = project(request.projectId);
      if (typeof request.sha !== "string" || !SHA.test(request.sha))
        fail("INVALID_SUPERVISOR_REQUEST");
      return await withLock(async () => {
        const dir = worktreeDir(p, request.sha);
        if (!exists(dir)) fail("SUPERVISOR_WORKTREE_MISSING");
        const before = await checkoutDigest(p);
        // No --force: a worktree with unsaved changes is refused, not destroyed.
        const rm = await git(p, p.repoRoot, ["worktree", "remove", dir]);
        const after = await checkoutDigest(p);
        return {
          response: {
            released: rm.exitCode === 0 && !exists(dir),
            originalCheckout: {
              unchanged: Boolean(
                before && after && before.digest === after.digest,
              ),
            },
          },
        };
      });
    }

    fail("SUPERVISOR_OPERATION_NOT_ALLOWED");
  };
}

export function macFor(token, nonce, requestJson) {
  return createHmac("sha256", token)
    .update(`${nonce}\n${requestJson}`)
    .digest("hex");
}

// Token files must be private. On Windows this inspects the ACL through
// icacls (fixed executable, fixed argv) and refuses broad principals.
const BROAD_PRINCIPALS =
  /(^|\s|\\)(Everyone|Users|Authenticated Users|ANONYMOUS LOGON|INTERACTIVE|NETWORK)(:|\s)/i;
export async function verifyTokenFileAcl(
  tokenFile,
  {
    runner = runBounded,
    spawnImpl = spawn,
    env = process.env,
    platform = process.platform,
  } = {},
) {
  if (platform !== "win32") return { ok: false, reason: "NOT_WINDOWS" };
  const r = await runner(`${WIN32_SYSTEM_DIR}\\icacls.exe`, [tokenFile], {
    env: { SystemRoot: env.SystemRoot ?? "C:\\Windows" },
    timeoutMs: 10000,
    maxBytes: 16384,
    spawnImpl,
  });
  if (r.exitCode !== 0) return { ok: false, reason: "ICACLS_FAILED" };
  const entries = r.output.split(/\r?\n/).slice(0, 40).join("\n");
  if (BROAD_PRINCIPALS.test(entries))
    return { ok: false, reason: "TOKEN_ACL_TOO_BROAD" };
  return { ok: true };
}

export async function startWindowsSupervisor({
  pipePath,
  token,
  handler,
  idleMs = 5000,
}) {
  if (typeof token !== "string" || Buffer.byteLength(token) < 32)
    fail("SUPERVISOR_TOKEN_INVALID");
  if (typeof handler !== "function" || !pipePath)
    fail("SUPERVISOR_LISTENER_REQUIRED");
  let active = 0;
  const server = net.createServer((socket) => {
    if (active >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    active += 1;
    const nonce = randomBytes(16).toString("hex");
    let received = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(Math.max(500, idleMs), () => socket.destroy());
    socket.write(JSON.stringify({ nonce }) + "\n");
    socket.on("data", async (chunk) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      handled = true;
      socket.pause();
      try {
        const envelope = JSON.parse(
          received.subarray(0, newline).toString("utf8"),
        );
        if (
          !envelope ||
          typeof envelope.request !== "object" ||
          typeof envelope.mac !== "string" ||
          !/^[a-f0-9]{64}$/.test(envelope.mac)
        )
          fail("SUPERVISOR_UNAUTHENTICATED");
        const expected = Buffer.from(
          macFor(token, nonce, JSON.stringify(envelope.request)),
          "hex",
        );
        const given = Buffer.from(envelope.mac, "hex");
        if (
          expected.length !== given.length ||
          !timingSafeEqual(expected, given)
        )
          fail("SUPERVISOR_UNAUTHENTICATED");
        const { response, afterSend } = await handler(envelope.request);
        socket.end(
          JSON.stringify({ ok: true, result: response }) + "\n",
          () => {
            if (afterSend)
              setTimeout(
                () => Promise.resolve(afterSend()).catch(() => {}),
                750,
              ).unref?.();
          },
        );
      } catch (error) {
        const code =
          error instanceof CodeBridgeError
            ? publicError(error).error
            : "SUPERVISOR_REQUEST_FAILED";
        socket.end(JSON.stringify({ ok: false, error: code }) + "\n");
      }
    });
    socket.once("close", () => {
      active = Math.max(0, active - 1);
    });
    socket.once("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: pipePath }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}
