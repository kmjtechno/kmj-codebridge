#!/usr/bin/env node
// Guarded, parameterized cutover of the production CodeBridge gateway to an
// exact, already-staged source commit. Replaces the one-time, replay-unsafe
// operator utility with a reviewable controller:
//
//   * dry-run by default: --apply is required to change anything;
//   * pinned: the target must be a full SHA whose staged checkout is clean,
//     at exactly that commit, with dependencies installed;
//   * explicit consent that no jobs are in flight (--confirm-no-active-jobs),
//     because pending gateway jobs live in memory and a restart drops them;
//   * backs up the unit and previous drop-in, switches only the systemd
//     drop-in (no Nginx, DNS, OAuth, agent or credential change);
//   * verifies through direct, local-Nginx and public URLs that the full tool
//     catalog is served AND every origin reports exactly the target commit;
//   * rolls back automatically and verifies the rollback.
//
// It only ever talks to systemd, loopback and the public MCP endpoint; it
// never prints configuration contents or tokens.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_TOOLS,
  parseServerCommit,
  parseToolCatalog,
  verifyCriticalToolSchemas,
} from "./verify-public-mcp-catalog.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_NAME = /^[A-Za-z0-9_.@-]{1,96}$/;
const DROPIN = "99-kmj-pinned-runtime.conf";
const MIN_TOOLS = 100;

export const DEFAULTS = Object.freeze({
  unit: "kmj-codebridge-gateway-stage.service",
  serviceUser: "kmjcode",
  expectHostname: "kmj-elite",
  candidates: "/opt/kmj-codebridge-candidates",
  systemDir: "/etc/systemd/system",
  backupRoot: "/var/backups/kmj-codebridge",
  lockFile: "/run/lock/kmj-codebridge-gateway-cutover.lock",
  procRoot: "/proc",
  port: 18787,
  publicHost: "kmjtechno.com",
});

export class CutoverError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const check = (ok, code) => {
  if (!ok) throw new CutoverError(code);
};

export function parseArgs(argv) {
  const options = { ...DEFAULTS, apply: false, confirmNoActiveJobs: false };
  const value = (i) => {
    check(i + 1 < argv.length, "OPTION_VALUE_MISSING");
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--confirm-no-active-jobs")
      options.confirmNoActiveJobs = true;
    else if (arg === "--target-sha") options.targetSha = argv[++i];
    else if (arg === "--unit") options.unit = value(i++);
    else if (arg === "--service-user") options.serviceUser = value(i++);
    else if (arg === "--expect-hostname") options.expectHostname = value(i++);
    else if (arg === "--candidates") options.candidates = value(i++);
    else if (arg === "--port") options.port = Number(value(i++));
    else throw new CutoverError("UNKNOWN_OPTION");
  }
  return options;
}

export function validateOptions(options) {
  check(FULL_SHA.test(options.targetSha ?? ""), "TARGET_SHA_INVALID");
  check(SAFE_NAME.test(options.unit), "UNIT_INVALID");
  check(SAFE_NAME.test(options.serviceUser), "SERVICE_USER_INVALID");
  check(SAFE_NAME.test(options.expectHostname), "HOSTNAME_INVALID");
  check(
    Number.isInteger(options.port) &&
      options.port >= 1024 &&
      options.port <= 65535,
    "PORT_INVALID",
  );
  for (const key of ["candidates", "systemDir", "backupRoot", "lockFile"])
    check(SAFE_PATH.test(options[key]), "PATH_INVALID");
}

// The controller replaces its own drop-in wholesale, so it only does so when
// the existing file contains nothing but the lines this controller (or the
// one-time utility it supersedes) writes. Any other setting an operator added
// would otherwise be discarded silently.
const DROPIN_LINES = [
  /^\[Service\]$/,
  /^WorkingDirectory=\/[A-Za-z0-9_./-]+$/,
  /^Environment=CODEBRIDGE_SOURCE_COMMIT=[0-9a-f]{7,40}$/,
  /^ExecStart=$/,
  /^ExecStart=\/[A-Za-z0-9_./-]+ \/[A-Za-z0-9_./-]+ gateway \/[A-Za-z0-9_./-]+$/,
];
export function recognizedDropIn(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines[0] === "[Service]" &&
    lines.every((line) => DROPIN_LINES.some((pattern) => pattern.test(line)))
  );
}

export function dropInContent({ target, sha, node, config }) {
  return (
    "[Service]\n" +
    `WorkingDirectory=${target}\n` +
    `Environment=CODEBRIDGE_SOURCE_COMMIT=${sha}\n` +
    "ExecStart=\n" +
    `ExecStart=${node} ${target}/src/cli.js gateway ${config}\n`
  );
}

export function realDeps() {
  return {
    run(argv, { input, timeoutMs = 30000, cwd } = {}) {
      try {
        return execFileSync(argv[0], argv.slice(1), {
          input,
          cwd,
          timeout: timeoutMs,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          maxBuffer: 2 * 1024 * 1024,
        }).trim();
      } catch {
        throw new CutoverError("COMMAND_FAILED:" + path.basename(argv[0]));
      }
    },
    platform: () => process.platform,
    uid: () => process.getuid?.(),
    hostname: () => os.hostname(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pid: () => process.pid,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    },
    // A dropped SSH session (SIGHUP) must not abandon a half-applied cutover,
    // and Ctrl-C / SIGTERM must lead to a verified rollback, not a bare exit.
    // JS handlers only run between awaits, so each blocking step finishes first.
    installSignalGuards() {
      process.on("SIGHUP", () => {});
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => {
          interrupted = true;
        });
    },
    interrupted: () => interrupted,
  };
}
let interrupted = false;

const RPC = (method, id) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gateway-cutover", version: "1.0.0" },
  },
});

// One origin's view: tool names plus the commit it reports. All through the
// same curl path so tests exercise exactly what production would run.
function probe(deps, url, { resolveLocal = false, publicHost }) {
  const call = (body) => {
    const args = ["curl", "-fsS", "--max-time", "15", "--connect-timeout", "4"];
    if (resolveLocal) args.push("--resolve", `${publicHost}:443:127.0.0.1`);
    args.push(
      "-H",
      `Host: ${publicHost}`,
      "-H",
      "Content-Type: application/json",
      "-H",
      "Accept: application/json, text/event-stream",
      "--data-binary",
      "@-",
      url,
    );
    return deps.run(args, { input: body, timeoutMs: 20000 });
  };
  const catalog = parseToolCatalog(call(RPC("tools/list", 1)));
  const commit = parseServerCommit(call(INIT));
  return { tools: catalog.names, catalog, commit };
}

// Git reads `.git/config` of repositories owned by the service user, and that
// account serves network traffic. Running git as root there would let a
// planted `core.fsmonitor` (or similar) execute as root at the next cutover, so
// every git query goes through the unprivileged service user.
const gitIn = (deps, asService, root, ...args) =>
  deps.run(
    asService(["git", "-c", `safe.directory=${root}`, "-C", root, ...args]),
  );

function inspect(options, deps) {
  const { unit, procRoot } = options;
  const show = (key) =>
    deps.run(["systemctl", "show", unit, "-p", key, "--value"]);
  // The gateway host is Linux/systemd; never attempt this anywhere else.
  check(deps.platform() === "linux", "UNSUPPORTED_PLATFORM");
  check(deps.uid() === 0, "ROOT_REQUIRED");
  check(
    deps.hostname().toLowerCase() === options.expectHostname.toLowerCase(),
    "UNEXPECTED_HOST",
  );
  const pid = Number(show("MainPID") || "0");
  check(pid > 0 && show("ActiveState") === "active", "GATEWAY_NOT_RUNNING");
  check(show("User") === options.serviceUser, "WRONG_SERVICE_USER");

  const cmdline = fs
    .readFileSync(path.join(procRoot, String(pid), "cmdline"))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  check(cmdline.length === 4 && cmdline[2] === "gateway", "UNEXPECTED_ARGS");
  const config = cmdline[3];
  const node = fs.realpathSync(path.join(procRoot, String(pid), "exe"));
  const currentRoot = fs.realpathSync(path.join(procRoot, String(pid), "cwd"));
  for (const p of [config, node, currentRoot, options.candidates])
    check(SAFE_PATH.test(p), "UNSUPPORTED_PATH_CHARACTERS");
  const stat = fs.statSync(config);
  check(stat.isFile() && (stat.mode & 0o077) === 0, "CONFIG_NOT_PRIVATE");
  check(deps.run([node, "--version"]).startsWith("v24."), "NODE_MAJOR");

  const home = deps
    .run(["getent", "passwd", options.serviceUser])
    .split(":")[5];
  check(SAFE_PATH.test(home ?? ""), "SERVICE_HOME_INVALID");
  const asService = (argv) => [
    "runuser",
    "-u",
    options.serviceUser,
    "--",
    "env",
    "-i",
    `HOME=${home}`,
    `PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    ...argv,
  ];
  const git = (root, ...args) => gitIn(deps, asService, root, ...args);

  const target = path.join(options.candidates, options.targetSha);
  check(SAFE_PATH.test(target), "UNSUPPORTED_PATH_CHARACTERS");
  check(fs.existsSync(target), "CANDIDATE_MISSING");
  check(fs.realpathSync(target) !== currentRoot, "ALREADY_RUNNING_TARGET");
  check(
    git(target, "rev-parse", "HEAD") === options.targetSha,
    "CANDIDATE_SHA_MISMATCH",
  );
  check(!git(target, "status", "--porcelain"), "CANDIDATE_DIRTY");
  check(
    fs.existsSync(path.join(target, "node_modules", "zod")),
    "DEPENDENCIES_MISSING",
  );
  const currentCommit = git(currentRoot, "rev-parse", "HEAD");

  // The staged build must accept the live private config before we touch
  // anything: validate it as the service user, inside the candidate.
  const validate =
    'import fs from "node:fs"; import {gatewaySchema} from "./src/config.js";' +
    'const c=gatewaySchema.parse(JSON.parse(fs.readFileSync(process.argv[1],"utf8")));' +
    `if(c.host!=="127.0.0.1"||c.port!==${options.port}||!c.allowedHosts.includes("${options.publicHost}"))process.exit(4);` +
    'console.log("CONFIG_VALID");';
  check(
    deps.run(
      [
        "runuser",
        "-u",
        options.serviceUser,
        "--",
        "env",
        "-i",
        `HOME=${home}`,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        node,
        "--input-type=module",
        "-e",
        validate,
        config,
      ],
      { cwd: target },
    ) === "CONFIG_VALID",
    "CANDIDATE_REJECTS_CONFIG",
  );

  const existingDropIn = path.join(
    options.systemDir,
    `${options.unit}.d`,
    DROPIN,
  );
  if (fs.existsSync(existingDropIn))
    check(
      recognizedDropIn(fs.readFileSync(existingDropIn, "utf8")),
      "DROPIN_UNRECOGNIZED",
    );

  // "Clean checkout at the right SHA" does not mean "tested". Run the same
  // gates the operator is told to run, as the unprivileged service user, and
  // make sure they left the tree clean. npm ci is an operator prerequisite
  // (it needs network); missing dependencies make these gates fail.
  for (const [name, argv, timeoutMs] of [
    ["check", ["npm", "run", "check"], 300000],
    ["test", ["npm", "test"], 900000],
    ["scan_secrets", ["npm", "run", "scan:secrets"], 300000],
  ]) {
    try {
      // Tests and the secret scanner invoke git in child processes. Trust
      // only this verified candidate, only for the lifetime of this gate.
      deps.run(
        asService([
          "GIT_CONFIG_COUNT=1",
          "GIT_CONFIG_KEY_0=safe.directory",
          `GIT_CONFIG_VALUE_0=${target}`,
          ...argv,
        ]),
        { cwd: target, timeoutMs },
      );
    } catch {
      throw new CutoverError(`CANDIDATE_GATE_FAILED:${name}`);
    }
  }
  check(!git(target, "status", "--porcelain"), "CANDIDATE_DIRTY_AFTER_GATES");

  const before = probe(deps, `http://127.0.0.1:${options.port}/mcp`, options);
  check(before.tools.size > 0, "BASELINE_CATALOG_EMPTY");
  const unitFile = show("FragmentPath");
  check(SAFE_PATH.test(unitFile) && fs.existsSync(unitFile), "UNIT_FILE");
  return {
    pid,
    node,
    config,
    target,
    currentRoot,
    currentCommit,
    unitFile,
    beforeCount: before.tools.size,
    // Older gateways (pre-#332) report no commit; then null skips that check.
    beforeServerCommit: before.commit,
    git,
  };
}

function verifyServing(options, deps) {
  const urls = [
    ["DIRECT", `http://127.0.0.1:${options.port}/mcp`, false],
    ["LOCAL_NGINX", `https://${options.publicHost}/mcp`, true],
    ["PUBLIC", `https://${options.publicHost}/mcp`, false],
  ];
  for (const [label, url, resolveLocal] of urls) {
    const seen = probe(deps, url, { ...options, resolveLocal });
    check(seen.tools.size >= MIN_TOOLS, `${label}_CATALOG_INCOMPLETE`);
    check(
      REQUIRED_TOOLS.every((name) => seen.tools.has(name)),
      `${label}_TOOLS_MISSING`,
    );
    // Count and tool names are insufficient: a stale gateway can expose a
    // tool with missing lease-fencing or coordination schema properties.
    // Check all three post-cutover origins; rollback uses the original catalog.
    try {
      verifyCriticalToolSchemas(seen.catalog);
    } catch {
      throw new CutoverError(`${label}_CRITICAL_SCHEMA_INVALID`);
    }
    check(seen.commit === options.targetSha, `${label}_COMMIT_MISMATCH`);
  }
}

const atomicWrite = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
};

async function rollback(options, deps, ctx, dropIn, previous, restarted) {
  if (previous === null) fs.rmSync(dropIn, { force: true });
  else atomicWrite(dropIn, previous);
  deps.run(["systemctl", "daemon-reload"], { timeoutMs: 40000 });
  // Only restart if a restart was actually attempted. A failure before that
  // point must not cause an outage (and drop in-memory jobs) for nothing; the
  // assertions below then prove the untouched original is still serving.
  if (restarted)
    deps.run(["systemctl", "restart", options.unit], { timeoutMs: 90000 });
  const show = (key) =>
    deps.run(["systemctl", "show", options.unit, "-p", key, "--value"]);
  for (let trial = 0; trial < 10; trial++) {
    try {
      // A healthy-looking catalog is not proof the ORIGINAL code is back: assert
      // the active process, its runtime directory, its source commit and, when
      // the baseline reported one, the commit the gateway itself reports.
      check(show("ActiveState") === "active", "ROLLBACK_INACTIVE");
      const pid = Number(show("MainPID") || "0");
      check(pid > 0, "ROLLBACK_NO_PID");
      const cwd = fs.realpathSync(
        path.join(options.procRoot, String(pid), "cwd"),
      );
      check(cwd === fs.realpathSync(ctx.currentRoot), "ROLLBACK_WRONG_RUNTIME");
      check(
        ctx.git(cwd, "rev-parse", "HEAD") === ctx.currentCommit,
        "ROLLBACK_WRONG_SOURCE",
      );
      const seen = probe(deps, `http://127.0.0.1:${options.port}/mcp`, options);
      check(seen.tools.size >= ctx.beforeCount, "ROLLBACK_CATALOG_SMALLER");
      if (ctx.beforeServerCommit !== null)
        check(
          seen.commit === ctx.beforeServerCommit,
          "ROLLBACK_COMMIT_MISMATCH",
        );
      return;
    } catch (error) {
      if (trial === 9) throw error;
      await deps.sleep(2000);
    }
  }
}

// Returns an ordered list of [KEY, value] result lines. Throws only for
// problems found before any change was made.
export async function runCutover(options, deps = realDeps()) {
  validateOptions(options);
  const out = [];
  const say = (key, value) => out.push([key, String(value)]);
  const ctx = inspect(options, deps);
  say("PREFLIGHT", "PASS");
  say(
    "CANDIDATE_GATES",
    "PASS_CHECK_TEST_SCAN_SECRETS_AS_" + options.serviceUser,
  );
  say("FROM_COMMIT", ctx.currentCommit);
  say("TARGET_SHA", options.targetSha);
  say("BASELINE_TOOLS", ctx.beforeCount);
  if (!options.apply) {
    say("MODE", "DRY_RUN");
    say("RESULT", "DRY_RUN_OK_NOTHING_CHANGED");
    return { ok: true, out };
  }
  check(options.confirmNoActiveJobs, "ACTIVE_JOBS_NOT_CONFIRMED");

  let lock;
  try {
    // O_EXCL: never follows a planted symlink and never shares a lock.
    lock = fs.openSync(options.lockFile, "wx", 0o600);
  } catch {
    // Tell "another run is active" from "a crash left this behind". A stale
    // lock is never removed automatically: a killed run may have left the
    // service in an unknown state, which a human must check first.
    let holder = NaN;
    try {
      holder = Number(fs.readFileSync(options.lockFile, "utf8").trim());
    } catch {}
    throw new CutoverError(
      Number.isInteger(holder) && holder > 0 && deps.pidAlive(holder)
        ? "CUTOVER_LOCKED"
        : "CUTOVER_LOCK_STALE",
    );
  }
  fs.writeSync(lock, `${deps.pid()}\n`);
  deps.installSignalGuards?.();
  const dropIn = path.join(options.systemDir, `${options.unit}.d`, DROPIN);
  try {
    const previous = fs.existsSync(dropIn)
      ? fs.readFileSync(dropIn, "utf8")
      : null;
    const stamp = new Date(deps.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const backup = path.join(options.backupRoot, stamp);
    // The final directory is created exclusively so an existing backup is
    // never silently overwritten; the unit may carry secrets in Environment=,
    // so the copy is owner-only as well.
    fs.mkdirSync(options.backupRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(backup, { mode: 0o700 });
    fs.copyFileSync(ctx.unitFile, path.join(backup, "original.service"));
    fs.chmodSync(path.join(backup, "original.service"), 0o600);
    if (previous !== null)
      fs.writeFileSync(path.join(backup, "previous-dropin.conf"), previous, {
        mode: 0o600,
      });
    fs.writeFileSync(
      path.join(backup, "plan.json"),
      JSON.stringify({ from: ctx.currentCommit, to: options.targetSha }) + "\n",
      { mode: 0o600 },
    );
    say("BACKUP", backup);

    let restarted = false;
    try {
      atomicWrite(
        dropIn,
        dropInContent({
          target: ctx.target,
          sha: options.targetSha,
          node: ctx.node,
          config: ctx.config,
        }),
      );
      deps.run(["systemctl", "daemon-reload"], { timeoutMs: 40000 });
      say("CUTOVER", "STARTING");
      check(!deps.interrupted?.(), "INTERRUPTED");
      restarted = true;
      deps.run(["systemctl", "restart", options.unit], { timeoutMs: 90000 });
      const show = (key) =>
        deps.run(["systemctl", "show", options.unit, "-p", key, "--value"]);
      check(show("ActiveState") === "active", "GATEWAY_FAILED_RESTART");
      const newPid = Number(show("MainPID") || "0");
      check(newPid > 0 && newPid !== ctx.pid, "GATEWAY_PID_NOT_CHANGED");
      check(
        fs.realpathSync(path.join(options.procRoot, String(newPid), "cwd")) ===
          fs.realpathSync(ctx.target),
        "RUNTIME_CWD_WRONG",
      );
      for (let trial = 0; trial < 10; trial++) {
        try {
          check(!deps.interrupted?.(), "INTERRUPTED");
          verifyServing(options, deps);
          break;
        } catch (error) {
          if (trial === 9 || error.code === "INTERRUPTED") throw error;
          await deps.sleep(2000);
        }
      }
      say("CUTOVER", "PASS");
      say("NEW_PID", newPid);
      say("COMMIT_ASSERT", "PASS");
      // The restart briefly disconnects every device agent. Agents reconnect
      // on their own, but this controller has no agent credentials, so it can
      // not prove that: confirm with an authenticated client afterwards.
      say("AGENT_RECONNECT", "NOT_VERIFIED_USE_AUTHENTICATED_CLIENT");
      say("RESULT", "PASS");
      return { ok: true, out };
    } catch (error) {
      say("CUTOVER", "FAIL");
      say("FAILURE", error.code ?? "UNEXPECTED_ERROR");
      say("ROLLBACK", "STARTING");
      try {
        await rollback(options, deps, ctx, dropIn, previous, restarted);
        say("ROLLBACK_ASSERT", "PID_RUNTIME_SOURCE_CATALOG_COMMIT");
        say("ROLLBACK", "PASS");
      } catch {
        say("ROLLBACK", "FAIL_MANUAL_RECOVERY_REQUIRED");
      }
      say("RESULT", "FAIL");
      return { ok: false, out };
    }
  } finally {
    fs.closeSync(lock);
    fs.rmSync(options.lockFile, { force: true });
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error("RESULT=FAIL\nERROR=" + (error.code ?? "BAD_ARGS"));
    process.exit(2);
  }
  try {
    const { ok, out } = await runCutover(options);
    for (const [key, value] of out) console.log(`${key}=${value}`);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.log("RESULT=FAIL");
    console.log("ERROR=" + (error.code ?? "UNEXPECTED_ERROR"));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
