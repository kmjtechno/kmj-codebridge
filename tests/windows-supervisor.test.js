import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  challengeResponseRequest,
  windowsSupervisorRequest,
} from "../src/supervisor-client.js";
import {
  WINDOWS_SUPERVISOR_OPS,
  createWindowsSupervisorConfigSchema,
  createWindowsSupervisorHandler,
  isSafeAbsolutePath,
  macFor,
  runBounded,
  startWindowsSupervisor,
  verifyTokenFileAcl,
} from "../src/windows-supervisor.js";
import { runWindowsSupervisorCli } from "../src/windows-supervisor-cli.js";
import { agentSchema } from "../src/config.js";

const SHA = "a".repeat(40);
const TOKEN = "t".repeat(48);

// Fixtures use the platform's own path rules: on Windows they are real drive
// paths (os.tmpdir() under C:\\Users\\...), on POSIX they are POSIX paths. The
// strict Windows rules are exercised separately with path.win32 literals.
function nativeConfig(root, extra = {}) {
  return {
    pipeName: "kmj-codebridge-supervisor-test",
    tokenFile: path.join(root, "token"),
    agent: {
      installDir: path.join(root, "agent"),
      configPath: path.join(root, "agent.json"),
      ...extra.agent,
    },
    projects: [
      {
        id: "kmj-cinecore",
        repoRoot: path.join(root, "repo"),
        worktreeRoot: path.join(root, "wtroot"),
        gitExe: path.join(root, "bin", "git"),
        cmakeExe: path.join(root, "bin", "cmake"),
        ctestExe: path.join(root, "bin", "ctest"),
        qtPrefix: path.join(root, "qt"),
        generator: "Ninja",
        ...extra.project,
      },
    ],
  };
}

// A unique, platform-appropriate listening address: a real named pipe on
// Windows (Unix-socket paths are invalid there) and a Unix socket elsewhere.
function listenAddress(t) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  if (process.platform === "win32")
    return `\\\\.\\pipe\\kmj-codebridge-supervisor-test-${unique}`;
  return path.join(tmp(t), `s-${unique}.sock`);
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-ws-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeHandler(t, { runner, extra, exists, revision } = {}) {
  const root = tmp(t);
  const schema = createWindowsSupervisorConfigSchema(path);
  const config = schema.parse(nativeConfig(root, extra));
  const calls = [];
  const handler = createWindowsSupervisorHandler({
    config,
    pathLib: path,
    runner:
      runner ??
      (async (exe, args, opts) => {
        calls.push({ exe, args, cwd: opts.cwd });
        return {
          exitCode: 0,
          output: "",
          truncated: false,
          timedOut: false,
          logSha256: "x",
          durationMs: 1,
        };
      }),
    exists: exists ?? (() => true),
    mkdir: () => {},
    writeFile: () => {},
    revision: revision ?? (() => ({ commit: SHA, source: "release-marker" })),
    deviceStatus: () => ({ platform: "win32", arch: "x64", hostname: "P720" }),
    env: { SystemRoot: "C:\\Windows" },
  });
  return { handler, calls, config, root };
}

test("config schema rejects relative paths, traversal, bad pipe names and extra keys", (t) => {
  const schema = createWindowsSupervisorConfigSchema(path);
  const root = tmp(t);
  assert.ok(schema.safeParse(nativeConfig(root)).success);
  const bad = (mutate) => {
    const c = nativeConfig(root);
    mutate(c);
    return schema.safeParse(c).success;
  };
  assert.equal(
    bad((c) => (c.tokenFile = "relative/token")),
    false,
  );
  assert.equal(
    bad((c) => (c.agent.installDir = `${root}/../escape`)),
    false,
  );
  assert.equal(
    bad((c) => (c.pipeName = "other-name")),
    false,
  );
  assert.equal(
    bad((c) => (c.extra = true)),
    false,
  );
  assert.equal(
    bad((c) => (c.projects[0].shell = "cmd.exe")),
    false,
  );
  assert.equal(
    bad((c) => (c.agent.restartTask = "a b;calc")),
    false,
  );
  assert.equal(
    bad((c) => (c.projects[0].generator = "Unix Makefiles")),
    false,
  );
});

test("production Windows path rules accept drive and UNC paths and refuse traversal and namespaces", () => {
  const ok = [
    "D:\\KMJ-HyperSpeed\\private\\p720-cinecore\\agent.json",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:/Users/kmj/AppData/Local/Temp/kmj-ws-1/token",
    "\\\\fileserver\\share\\kmj\\repo",
  ];
  const bad = [
    "relative\\path",
    "D:drive-relative",
    "\\rooted-without-drive",
    "C:\\a\\..\\b",
    "C:/a/../b",
    "\\\\.\\pipe\\kmj-codebridge-supervisor-x",
    "\\\\?\\C:\\x",
    "C:\\file.txt:stream",
    "C:\\a*b",
    "C:\\a\u0000b",
    "\\\\server-only",
    "C:",
  ];
  for (const value of ok)
    assert.equal(isSafeAbsolutePath(value, path.win32), true, value);
  for (const value of bad)
    assert.equal(isSafeAbsolutePath(value, path.win32), false, value);
  assert.equal(isSafeAbsolutePath("/etc/../x", path.posix), false);
  assert.equal(isSafeAbsolutePath("/opt/kmj", path.posix), true);

  const schema = createWindowsSupervisorConfigSchema(path.win32);
  const config = {
    pipeName: "kmj-codebridge-supervisor-p720",
    tokenFile: "D:\\KMJ-HyperSpeed\\private\\p720-codebridge\\supervisor.token",
    agent: {
      installDir: "D:\\KMJ-HyperSpeed\\codebridge-releases\\current",
      configPath: "D:\\KMJ-HyperSpeed\\private\\p720-codebridge\\agent.json",
      restartTask: "KMJ-CodeBridge-Agent",
    },
    projects: [
      {
        id: "kmj-cinecore",
        repoRoot: "D:\\KMJ-CineCore",
        worktreeRoot: "D:\\KMJ-HyperSpeed\\verify\\cinecore",
        gitExe: "C:\\Program Files\\Git\\cmd\\git.exe",
        cmakeExe: "C:\\Program Files\\CMake\\bin\\cmake.exe",
        ctestExe: "C:\\Program Files\\CMake\\bin\\ctest.exe",
        qtPrefix: "C:\\Qt\\6.8.0\\msvc2022_64",
        generator: "Ninja",
      },
    ],
  };
  assert.ok(schema.safeParse(config).success);
  const traversal = structuredClone(config);
  traversal.projects[0].repoRoot = "D:\\KMJ-CineCore\\..\\Windows";
  assert.equal(schema.safeParse(traversal).success, false);
  const unc = structuredClone(config);
  unc.agent.installDir = "\\\\.\\pipe\\x";
  assert.equal(schema.safeParse(unc).success, false);
});

test("status is truthful: runtime SHA, no update support, restart only with a verified task", async (t) => {
  const calls = [];
  const { handler } = makeHandler(t, {
    extra: { agent: { restartTask: "KMJ-CodeBridge-Agent" } },
    runner: async (exe, args) => {
      calls.push([exe, ...args]);
      return {
        exitCode: 0,
        output: '"KMJ-CodeBridge-Agent","N/A","Running"\r\n',
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  const { response } = await handler({ op: "status", service: "agent" });
  assert.equal(response.platform, "win32");
  assert.equal(response.supervisor, "windows-native");
  assert.equal(response.runtime.commit, SHA);
  assert.equal(response.state, "Running");
  assert.equal(response.restart.supported, true);
  assert.equal(response.update.supported, false);
  assert.deepEqual(calls[0].slice(1), [
    "/Query",
    "/TN",
    "KMJ-CodeBridge-Agent",
    "/FO",
    "CSV",
    "/NH",
  ]);

  const none = makeHandler(t);
  const bare = (await none.handler({ op: "status", service: "agent" }))
    .response;
  assert.equal(bare.restart.supported, false);
  assert.equal(bare.state, "unknown");
});

test("status reports no runtime commit instead of guessing", async (t) => {
  const { handler } = makeHandler(t, { revision: () => null });
  const { response } = await handler({ op: "status", service: "agent" });
  assert.equal(response.runtime, null);
});

test("Linux-only and unknown operations are refused, never routed", async (t) => {
  const { handler, calls } = makeHandler(t);
  for (const op of [
    "update_now",
    "update_status",
    "logs",
    "release_history",
    "update_rollback",
    "private_pr419_ci_start",
    "main_platform_production_activate",
    "run",
    "shell",
  ])
    await assert.rejects(
      handler({ op }),
      /SUPERVISOR_OPERATION_NOT_ALLOWED/,
      op,
    );
  await assert.rejects(
    handler({ op: "status", service: "gateway" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
  await assert.rejects(
    handler({ op: "restart", service: "gateway" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
  assert.equal(
    calls.length,
    0,
    "no process was started for refused operations",
  );
  for (const op of WINDOWS_SUPERVISOR_OPS)
    assert.ok(!/systemd|journal/.test(op));
});

test("callers cannot select executables, args, cwd, environment or paths", async (t) => {
  const { handler, calls } = makeHandler(t);
  for (const extra of [
    { exe: "cmd.exe" },
    { args: ["/c", "calc"] },
    { cwd: "C:\\" },
    { env: { PATH: "x" } },
    { command: "whoami" },
    { task: "Other" },
  ])
    await assert.rejects(
      handler({
        op: "project_verify_stage",
        projectId: "kmj-cinecore",
        sha: SHA,
        stage: "build",
        ...extra,
      }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  assert.equal(calls.length, 0);
});

test("restart needs a configured, existing task and uses fixed schtasks argv", async (t) => {
  const none = makeHandler(t);
  await assert.rejects(
    none.handler({ op: "restart", service: "agent" }),
    /SUPERVISOR_RESTART_UNAVAILABLE/,
  );

  const calls = [];
  const { handler } = makeHandler(t, {
    extra: { agent: { restartTask: "KMJ-CodeBridge-Agent" } },
    runner: async (exe, args) => {
      calls.push(args);
      return {
        exitCode: 0,
        output: '"KMJ-CodeBridge-Agent","N/A","Ready"',
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  const r = await handler({ op: "restart", service: "agent" });
  assert.equal(r.response.accepted, true);
  assert.equal(calls.length, 1, "nothing restarts before the reply is sent");
  await r.afterSend();
  assert.deepEqual(calls.slice(1), [
    ["/End", "/TN", "KMJ-CodeBridge-Agent"],
    ["/Run", "/TN", "KMJ-CodeBridge-Agent"],
  ]);
});

test("disabled and unknown Windows agent task states cannot be restarted", async (t) => {
  for (const state of ["Disabled", "unknown", "Could Not Start"]) {
    const called = [];
    const { handler } = makeHandler(t, {
      extra: { agent: { restartTask: "KMJ-CodeBridge-P720-Agent" } },
      runner: async (_exe, args) => {
        called.push(args);
        return {
          exitCode: 0,
          output: '"KMJ-CodeBridge-P720-Agent","N/A","' + state + '"',
          truncated: false,
          timedOut: false,
          logSha256: "x",
          durationMs: 1,
        };
      },
    });
    const status = (await handler({ op: "status", service: "agent" })).response;
    assert.equal(status.restart.supported, false);
    assert.equal(status.restart.mechanism, null);
    await assert.rejects(
      handler({ op: "restart", service: "agent" }),
      /SUPERVISOR_RESTART_UNAVAILABLE/,
    );
    assert.equal(called.length, 2, "only read-only queries allowed");
    assert.equal(called.some((args) => args.includes("/End") || args.includes("/Run")), false);
  }
});

test("verify prepare/stage use only a separate worktree and fixed argv", async (t) => {
  const seen = [];
  const { handler, config } = makeHandler(t, {
    exists: (target) => !target.includes(`${path.sep}wt${path.sep}`),
    runner: async (exe, args, opts) => {
      seen.push({ exe, args, cwd: opts.cwd });
      const out = args.includes("rev-parse") ? SHA + "\n" : "";
      return {
        exitCode: 0,
        output: out,
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  const p = config.projects[0];
  const prep = await handler({
    op: "project_verify_prepare",
    projectId: "kmj-cinecore",
    sha: SHA,
  });
  assert.equal(prep.response.originalCheckout.unchanged, true);
  assert.ok(prep.response.worktree.endsWith(path.join("wt", SHA.slice(0, 12))));
  const add = seen.find((c) => c.args.includes("worktree"));
  assert.deepEqual(add.args.slice(-4, -2), ["add", "--detach"]);
  assert.equal(add.args.at(-1), SHA);
  assert.ok(!add.args.includes("--force"));

  seen.length = 0;
  const wt = prep.response.worktree;
  const stage = makeHandler(t, {
    runner: async (exe, args, opts) => {
      seen.push({ exe, args, cwd: opts.cwd });
      return {
        exitCode: 0,
        output: args.includes("rev-parse") ? SHA + "\n" : "ok",
        truncated: false,
        timedOut: false,
        logSha256: "abc",
        durationMs: 5,
      };
    },
  });
  for (const name of ["configure", "build", "ctest"]) {
    const r = await stage.handler({
      op: "project_verify_stage",
      projectId: "kmj-cinecore",
      sha: SHA,
      stage: name,
    });
    assert.equal(r.response.passed, true);
    assert.equal(r.response.stage, name);
    assert.equal(r.response.logSha256, "abc");
  }
  const exes = seen
    .filter((c) => !c.args.includes("rev-parse"))
    .map((c) => path.basename(c.exe));
  assert.deepEqual(exes, ["cmake", "cmake", "ctest"]);
  assert.ok(
    seen.every((c) => c.cwd !== p.repoRoot),
    "never executes inside the original checkout",
  );
  assert.ok(wt.length > 0);
});

test("verify refuses bad SHA, bad stage, unknown project and concurrent runs", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { handler } = makeHandler(t, {
    runner: async (exe, args) => {
      if (args.includes("rev-parse"))
        return {
          exitCode: 0,
          output: SHA + "\n",
          truncated: false,
          timedOut: false,
          logSha256: "x",
          durationMs: 1,
        };
      await gate;
      return {
        exitCode: 0,
        output: "",
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  await assert.rejects(
    handler({
      op: "project_verify_prepare",
      projectId: "kmj-cinecore",
      sha: "main",
    }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    handler({
      op: "project_verify_prepare",
      projectId: "kmj-cinecore",
      sha: "A".repeat(40),
    }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    handler({
      op: "project_verify_stage",
      projectId: "kmj-cinecore",
      sha: SHA,
      stage: "install",
    }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  await assert.rejects(
    handler({
      op: "project_verify_stage",
      projectId: "other",
      sha: SHA,
      stage: "build",
    }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
  const first = handler({
    op: "project_verify_stage",
    projectId: "kmj-cinecore",
    sha: SHA,
    stage: "build",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    handler({
      op: "project_verify_stage",
      projectId: "kmj-cinecore",
      sha: SHA,
      stage: "ctest",
    }),
    /SUPERVISOR_BUSY/,
  );
  release();
  await first;
});

test("a failing stage is reported failed, and a SHA absent without fetch permission is refused", async (t) => {
  const failing = makeHandler(t, {
    runner: async (exe, args) => ({
      exitCode: args.includes("rev-parse") ? 0 : 2,
      output: args.includes("rev-parse") ? SHA + "\n" : "boom",
      truncated: false,
      timedOut: false,
      logSha256: "x",
      durationMs: 1,
    }),
  });
  const r = await failing.handler({
    op: "project_verify_stage",
    projectId: "kmj-cinecore",
    sha: SHA,
    stage: "build",
  });
  assert.equal(r.response.passed, false);
  assert.equal(r.response.exitCode, 2);

  const calls = [];
  const missing = makeHandler(t, {
    runner: async (exe, args) => {
      calls.push(args);
      return {
        exitCode: args.includes("cat-file") ? 1 : 0,
        output: "",
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  await assert.rejects(
    missing.handler({
      op: "project_verify_prepare",
      projectId: "kmj-cinecore",
      sha: SHA,
    }),
    /SUPERVISOR_SHA_NOT_AVAILABLE/,
  );
  assert.ok(
    !calls.some((a) => a.includes("fetch")),
    "no network fetch unless explicitly allowed",
  );
});

test("prepare reports a changed original checkout instead of hiding it", async (t) => {
  let statusCalls = 0;
  const { handler } = makeHandler(t, {
    exists: (target) => !target.includes(`${path.sep}wt${path.sep}`),
    runner: async (exe, args) => {
      let output = "";
      if (args.includes("status")) output = ` M file-${statusCalls++}\0`;
      if (args.includes("rev-parse")) output = SHA + "\n";
      return {
        exitCode: 0,
        output,
        truncated: false,
        timedOut: false,
        logSha256: "x",
        durationMs: 1,
      };
    },
  });
  const r = await handler({
    op: "project_verify_prepare",
    projectId: "kmj-cinecore",
    sha: SHA,
  });
  assert.equal(r.response.originalCheckout.dirtyBefore, true);
  assert.equal(r.response.originalCheckout.unchanged, false);
});

test("runBounded: success, exit code, timeout kill, output cap, redaction, spawn failure", async () => {
  const node = process.execPath;
  const ok = await runBounded(node, ["-e", "console.log('hello')"], {
    env: process.env,
    timeoutMs: 10000,
    maxBytes: 4096,
  });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /hello/);
  assert.match(ok.logSha256, /^[a-f0-9]{64}$/);

  const bad = await runBounded(node, ["-e", "process.exit(3)"], {
    env: process.env,
    timeoutMs: 10000,
    maxBytes: 4096,
  });
  assert.equal(bad.exitCode, 3);

  let killed = null;
  const slow = await runBounded(node, ["-e", "setInterval(()=>{},1000)"], {
    env: process.env,
    timeoutMs: 300,
    maxBytes: 4096,
    killTree: (pid) => (killed = pid),
  });
  assert.equal(slow.timedOut, true);
  assert.ok(Number.isInteger(killed));

  const big = await runBounded(
    node,
    ["-e", "process.stdout.write('x'.repeat(200000))"],
    { env: process.env, timeoutMs: 10000, maxBytes: 1000 },
  );
  assert.equal(big.truncated, true);
  assert.ok(big.output.length <= 1000);

  const missing = await runBounded(
    path.join(os.tmpdir(), "does-not-exist-kmj"),
    [],
    { env: process.env, timeoutMs: 2000, maxBytes: 1000 },
  );
  assert.equal(missing.spawnFailed, true);
});

async function withServer(t, handler, options = {}) {
  const sock = listenAddress(t);
  const server = await startWindowsSupervisor({
    pipePath: sock,
    token: TOKEN,
    handler,
    ...options,
  });
  t.after(() => server.close());
  return sock;
}

test("pipe protocol: authenticated request works, wrong secret and replay fail", async (t) => {
  const handler = async (request) => ({ response: { echoed: request.op } });
  const sock = await withServer(t, handler);
  const ok = await challengeResponseRequest({
    socketPath: sock,
    token: TOKEN,
    request: { op: "device_status" },
  });
  assert.deepEqual(ok, { echoed: "device_status" });

  await assert.rejects(
    challengeResponseRequest({
      socketPath: sock,
      token: "w".repeat(48),
      request: { op: "device_status" },
    }),
    /SUPERVISOR_UNAUTHENTICATED/,
  );

  // Replay: capture a valid MAC from one connection, present it on another.
  const stolen = await new Promise((resolve, reject) => {
    const c = net.createConnection({ path: sock });
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        const { nonce } = JSON.parse(buf);
        const request = { op: "device_status" };
        resolve({
          request,
          mac: macFor(TOKEN, nonce, JSON.stringify(request)),
        });
        c.destroy();
      }
    });
    c.on("error", reject);
  });
  const replay = await new Promise((resolve) => {
    const c = net.createConnection({ path: sock });
    let buf = "";
    let sent = false;
    c.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      if (!sent && lines.length > 1) {
        sent = true;
        c.write(JSON.stringify(stolen) + "\n");
      } else if (sent && lines.length > 2) {
        resolve(JSON.parse(lines[1]));
        c.destroy();
      }
    });
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "SUPERVISOR_UNAUTHENTICATED");
});

test("pipe protocol: tampered request, malformed, oversized and unauthenticated input are rejected", async (t) => {
  let ran = 0;
  const sock = await withServer(t, async () => {
    ran += 1;
    return { response: {} };
  });
  const attempt = (build) =>
    new Promise((resolve) => {
      const c = net.createConnection({ path: sock });
      let buf = "";
      let sent = false;
      c.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        if (!sent && lines.length > 1) {
          sent = true;
          c.write(build(JSON.parse(lines[0]).nonce));
        } else if (sent && lines.length > 2) {
          resolve(JSON.parse(lines[1]));
          c.destroy();
        }
      });
      c.on("close", () => resolve({ closed: true }));
      c.on("error", () => resolve({ closed: true }));
    });
  const signed = { op: "device_status" };
  const tampered = await attempt(
    (nonce) =>
      JSON.stringify({
        request: { op: "restart", service: "agent" },
        mac: macFor(TOKEN, nonce, JSON.stringify(signed)),
      }) + "\n",
  );
  assert.equal(tampered.error, "SUPERVISOR_UNAUTHENTICATED");
  assert.equal((await attempt(() => "not json\n")).ok, false);
  assert.equal(
    (await attempt(() => JSON.stringify({ request: signed }) + "\n")).error,
    "SUPERVISOR_UNAUTHENTICATED",
  );
  const huge = await attempt(() => "x".repeat(20000) + "\n");
  assert.ok(huge.closed || huge.ok === false);
  assert.equal(ran, 0, "the handler never ran for an unauthenticated request");
});

test("server refuses a short token and a missing handler", async (t) => {
  await assert.rejects(
    startWindowsSupervisor({
      pipePath: listenAddress(t),
      token: "short",
      handler: async () => ({}),
    }),
    /SUPERVISOR_TOKEN_INVALID/,
  );
  await assert.rejects(
    startWindowsSupervisor({ pipePath: listenAddress(t), token: TOKEN }),
    /SUPERVISOR_LISTENER_REQUIRED/,
  );
});

test("client refuses non-Windows hosts, foreign pipe names and missing or short tokens", async (t) => {
  const dir = tmp(t);
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, TOKEN);
  const pipe = "\\\\.\\pipe\\kmj-codebridge-supervisor-p720";
  await assert.rejects(
    windowsSupervisorRequest(
      { pipePath: pipe, tokenFile },
      { op: "device_status" },
      { platform: "linux" },
    ),
    /SUPERVISOR_UNAVAILABLE/,
  );
  await assert.rejects(
    windowsSupervisorRequest(
      { pipePath: "\\\\.\\pipe\\someone-else", tokenFile },
      { op: "device_status" },
      { platform: "win32" },
    ),
    /SUPERVISOR_UNAVAILABLE/,
  );
  await assert.rejects(
    windowsSupervisorRequest(
      { pipePath: pipe, tokenFile: path.join(dir, "missing") },
      { op: "device_status" },
      { platform: "win32" },
    ),
    /SUPERVISOR_UNAVAILABLE/,
  );
  fs.writeFileSync(tokenFile, "short");
  await assert.rejects(
    windowsSupervisorRequest(
      { pipePath: pipe, tokenFile },
      { op: "device_status" },
      { platform: "win32" },
    ),
    /SUPERVISOR_UNAVAILABLE/,
  );
});

test("token ACL check rejects broad principals and non-Windows", async () => {
  const runner =
    (output, exitCode = 0) =>
    async () => ({ exitCode, output });
  assert.deepEqual(
    await verifyTokenFileAcl("C:\\s\\token", { platform: "linux" }),
    { ok: false, reason: "NOT_WINDOWS" },
  );
  const good =
    "C:\\s\\token NT AUTHORITY\\SYSTEM:(F)\n  BUILTIN\\Administrators:(F)\n  P720\\kmjagent:(R)\n";
  assert.equal(
    (
      await verifyTokenFileAcl("C:\\s\\token", {
        platform: "win32",
        runner: runner(good),
      })
    ).ok,
    true,
  );
  for (const broad of [
    "Everyone:(R)",
    "BUILTIN\\Users:(R)",
    "NT AUTHORITY\\Authenticated Users:(M)",
  ])
    assert.deepEqual(
      await verifyTokenFileAcl("C:\\s\\token", {
        platform: "win32",
        runner: runner(`C:\\s\\token ${broad}\n`),
      }),
      { ok: false, reason: "TOKEN_ACL_TOO_BROAD" },
      broad,
    );
  assert.equal(
    (
      await verifyTokenFileAcl("C:\\s\\token", {
        platform: "win32",
        runner: runner("", 5),
      })
    ).reason,
    "ICACLS_FAILED",
  );
});

test("CLI refuses non-Windows and an unsafe token ACL before listening", async (t) => {
  await assert.rejects(
    runWindowsSupervisorCli("/x", { platform: "linux" }),
    /SUPERVISOR_UNSUPPORTED/,
  );
  const root = tmp(t);
  const cfg = nativeConfig(root);
  fs.writeFileSync(
    path.join(root, "cfg.json"),
    JSON.stringify({
      ...cfg,
      tokenFile: "C:\\kmj\\token",
      agent: {
        installDir: "C:\\kmj\\agent",
        configPath: "C:\\kmj\\agent.json",
      },
      projects: [],
    }),
  );
  let started = 0;
  await assert.rejects(
    runWindowsSupervisorCli(path.join(root, "cfg.json"), {
      platform: "win32",
      acl: {
        platform: "win32",
        runner: async () => ({ exitCode: 0, output: "Everyone:(F)" }),
      },
      start: async () => started++,
    }),
    /SUPERVISOR_TOKEN_ACL_UNSAFE/,
  );
  assert.equal(started, 0);
});

test("agent config accepts only the fixed-prefix Windows pipe", () => {
  const pipe = agentSchema.shape.supervisorPipe;
  assert.ok(
    pipe.safeParse("\\\\.\\pipe\\kmj-codebridge-supervisor-p720").success,
  );
  assert.ok(pipe.safeParse(undefined).success);
  for (const bad of [
    "\\\\.\\pipe\\other",
    "\\\\.\\pipe\\kmj-codebridge-supervisor-UP",
    "\\\\server\\pipe\\kmj-codebridge-supervisor-p720",
    "/run/kmj-codebridge/supervisor.sock",
  ])
    assert.equal(pipe.safeParse(bad).success, false, bad);
  assert.ok(
    agentSchema.shape.supervisorTokenFile.safeParse("D:\\s\\token").success,
  );
});
