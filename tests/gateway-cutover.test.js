import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CutoverError,
  DEFAULTS,
  dropInContent,
  parseArgs,
  recognizedDropIn,
  runCutover,
  validateOptions,
} from "../scripts/gateway-cutover.mjs";
import { REQUIRED_TOOLS } from "../scripts/verify-public-mcp-catalog.mjs";

const OLD_SHA = "055fd88ebfd56125abbe2bcec8f99819ed54ae80";
const NEW_SHA = "5eab929549edbef644f0b93c22eda42a4c48a320";

// A small but faithful fake host: systemd state, /proc, git and the gateway's
// MCP responses all derive from the files the controller really writes.
function host(t, tweak = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cutover-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = (...p) => {
    const full = path.join(base, ...p);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const oldRoot = dir("srv", "old");
  const target = dir("opt", "candidates", NEW_SHA);
  fs.mkdirSync(path.join(target, "node_modules", "zod"), { recursive: true });
  const config = path.join(base, "gateway.json");
  fs.writeFileSync(config, "{}", { mode: tweak.configMode ?? 0o600 });
  const node = path.join(base, "node");
  fs.writeFileSync(node, "");
  const unitFile = path.join(base, "unit.service");
  fs.writeFileSync(unitFile, "[Service]\nExecStart=/bin/true\n");
  const options = {
    ...DEFAULTS,
    candidates: path.join(base, "opt", "candidates"),
    systemDir: dir("etc", "systemd"),
    backupRoot: path.join(base, "backups"),
    lockFile: path.join(base, "cutover.lock"),
    procRoot: dir("proc"),
    targetSha: NEW_SHA,
    apply: false,
    confirmNoActiveJobs: false,
  };
  const dropIn = path.join(
    options.systemDir,
    `${options.unit}.d`,
    "99-kmj-pinned-runtime.conf",
  );
  const state = {
    pid: 100,
    active: true,
    cwd: oldRoot,
    commit: OLD_SHA,
    restarts: 0,
    calls: [],
    user: options.serviceUser,
    ignoreDropIn: false,
    ignoreCommitEnv: false,
    breakOnRestart: false,
    dirty: false,
    candidateHead: NEW_SHA,
    ...tweak.state,
  };
  const publish = () => {
    const p = path.join(options.procRoot, String(state.pid));
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(
      path.join(p, "cmdline"),
      [node, path.join(state.cwd, "src", "cli.js"), "gateway", config].join(
        "\0",
      ) + "\0",
    );
    fs.symlinkSync(node, path.join(p, "exe"));
    fs.symlinkSync(state.cwd, path.join(p, "cwd"));
  };
  publish();
  const names = [
    ...REQUIRED_TOOLS,
    ...Array.from({ length: 90 }, (_, i) => "filler_tool_" + i),
  ];
  const run = (argv, { input } = {}) => {
    state.calls.push(argv.join(" "));
    const [cmd, ...rest] = argv;
    if (cmd === "systemctl") {
      if (rest[0] === "show") {
        const key = rest[rest.length - 2];
        return {
          MainPID: String(state.active ? state.pid : 0),
          ActiveState: state.active ? "active" : "failed",
          User: state.user,
          FragmentPath: unitFile,
        }[key];
      }
      if (rest[0] === "restart") {
        state.restarts += 1;
        state.pid += 1;
        const applied = !state.ignoreDropIn && fs.existsSync(dropIn);
        if (applied) {
          const text = fs.readFileSync(dropIn, "utf8");
          state.cwd = /WorkingDirectory=(.+)/.exec(text)[1];
          state.commit = state.ignoreCommitEnv
            ? OLD_SHA
            : /CODEBRIDGE_SOURCE_COMMIT=(\w+)/.exec(text)[1];
        } else {
          state.cwd = oldRoot;
          state.commit = OLD_SHA;
        }
        if (state.breakOnRestart) state.active = false;
        publish();
        return "";
      }
      return "";
    }
    if (cmd === node) return "v24.21.0";
    if (cmd === "git") {
      const root = argv[argv.indexOf("-C") + 1];
      if (argv.includes("status")) return state.dirty ? " M src/x.js" : "";
      return root === target ? state.candidateHead : state.commit;
    }
    if (cmd === "getent") return "kmjcode:x:1000:1000::/home/kmjcode:/bin/sh";
    if (cmd === "runuser") return "CONFIG_VALID";
    if (cmd === "curl") {
      if (!state.active) throw new CutoverError("COMMAND_FAILED:curl");
      const method = JSON.parse(input).method;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result:
          method === "tools/list"
            ? { tools: names.map((name) => ({ name })) }
            : { serverInfo: { name: "kmj-codebridge", commit: state.commit } },
      });
    }
    throw new Error("unexpected command " + cmd);
  };
  const deps = {
    run,
    platform: () => "linux",
    uid: () => tweak.uid ?? 0,
    hostname: () => tweak.hostname ?? "KMJ-elite",
    now: () => Date.UTC(2026, 9, 13, 12, 0, 0),
    sleep: async () => {},
  };
  return { options, deps, state, dropIn, target, oldRoot, base, node, config };
}

// The fake host models a Linux server (POSIX paths, symlinked /proc), so those
// tests only run on POSIX. The Linux-only refusal below runs on every OS.
const POSIX_ONLY = process.platform === "win32" ? "POSIX host model" : false;

const lines = (out) => Object.fromEntries(out.map(([k, v]) => [k, v]));

test("option parsing and validation reject anything but a pinned full SHA and safe values", () => {
  assert.equal(parseArgs(["--target-sha", NEW_SHA]).apply, false);
  assert.equal(parseArgs(["--apply"]).apply, true);
  assert.throws(() => parseArgs(["--nope"]), /UNKNOWN_OPTION/);
  assert.throws(() => parseArgs(["--unit"]), /OPTION_VALUE_MISSING/);
  const good = { ...DEFAULTS, targetSha: NEW_SHA };
  validateOptions(good);
  for (const bad of [
    { targetSha: "main" },
    { targetSha: NEW_SHA.slice(0, 7) },
    { targetSha: NEW_SHA.toUpperCase() },
    { unit: "a b" },
    { port: 80 },
    { port: NaN },
    { candidates: "/opt/x;rm -rf /" },
    { backupRoot: "relative/path" },
  ])
    assert.throws(() => validateOptions({ ...good, ...bad }), CutoverError);
});

test(
  "dry run passes preflight but changes nothing",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t);
    const { ok, out } = await runCutover(h.options, h.deps);
    assert.equal(ok, true);
    const r = lines(out);
    assert.equal(r.PREFLIGHT, "PASS");
    assert.equal(r.FROM_COMMIT, OLD_SHA);
    assert.equal(r.RESULT, "DRY_RUN_OK_NOTHING_CHANGED");
    assert.equal(h.state.restarts, 0);
    assert.equal(fs.existsSync(h.dropIn), false);
    assert.equal(fs.existsSync(h.options.backupRoot), false);
    assert.equal(fs.existsSync(h.options.lockFile), false);
  },
);

test(
  "apply requires explicit consent that no jobs are in flight",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t);
    await assert.rejects(
      runCutover({ ...h.options, apply: true }, h.deps),
      /ACTIVE_JOBS_NOT_CONFIRMED/,
    );
    assert.equal(h.state.restarts, 0);
    assert.equal(fs.existsSync(h.dropIn), false);
  },
);

test(
  "successful cutover pins the runtime, backs up, restarts once and asserts the commit",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t);
    const previous = dropInContent({
      target: h.oldRoot,
      sha: OLD_SHA,
      node: h.node,
      config: h.config,
    });
    fs.mkdirSync(path.dirname(h.dropIn), { recursive: true });
    fs.writeFileSync(h.dropIn, previous);
    const { ok, out } = await runCutover(
      { ...h.options, apply: true, confirmNoActiveJobs: true },
      h.deps,
    );
    const r = lines(out);
    assert.equal(ok, true);
    assert.equal(r.RESULT, "PASS");
    assert.equal(r.COMMIT_ASSERT, "PASS");
    // Agent reconnection can't be proven without agent credentials: say so.
    assert.equal(r.AGENT_RECONNECT, "NOT_VERIFIED_USE_AUTHENTICATED_CLIENT");
    assert.equal(h.state.restarts, 1);
    assert.equal(h.state.commit, NEW_SHA);
    assert.equal(
      fs.readFileSync(h.dropIn, "utf8"),
      dropInContent({
        target: h.target,
        sha: NEW_SHA,
        node: h.node,
        config: h.config,
      }),
    );
    const backup = r.BACKUP;
    assert.equal(
      fs.readFileSync(path.join(backup, "previous-dropin.conf"), "utf8"),
      previous,
    );
    assert.ok(fs.existsSync(path.join(backup, "original.service")));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(backup, "plan.json"))),
      {
        from: OLD_SHA,
        to: NEW_SHA,
      },
    );
    assert.equal(fs.statSync(backup).mode & 0o077, 0);
    assert.equal(fs.existsSync(h.options.lockFile), false);
    // Only systemd, git, curl and the config check were ever invoked.
    for (const call of h.state.calls)
      assert.match(call, /^(systemctl|git|curl|getent|runuser|\S*node )/);
    assert.ok(!h.state.calls.some((c) => /nginx|dns|certbot/i.test(c)));
  },
);

test(
  "a failed assertion rolls back byte-for-byte and verifies the rollback",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t, { state: { ignoreCommitEnv: true } });
    // The runtime directory switches, but the gateway still reports the old commit.
    const previous = "[Service]\nWorkingDirectory=/previous\n";
    fs.mkdirSync(path.dirname(h.dropIn), { recursive: true });
    fs.writeFileSync(h.dropIn, previous);
    const { ok, out } = await runCutover(
      { ...h.options, apply: true, confirmNoActiveJobs: true },
      h.deps,
    );
    const r = lines(out);
    assert.equal(ok, false);
    assert.equal(r.CUTOVER, "FAIL");
    assert.equal(r.FAILURE, "DIRECT_COMMIT_MISMATCH");
    assert.equal(r.ROLLBACK, "PASS");
    assert.equal(r.RESULT, "FAIL");
    assert.equal(fs.readFileSync(h.dropIn, "utf8"), previous);
    assert.equal(h.state.restarts, 2);
    assert.equal(fs.existsSync(h.options.lockFile), false);
  },
);

test(
  "rollback without a previous drop-in removes the new one",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t, { state: { ignoreDropIn: true } });
    const { ok, out } = await runCutover(
      { ...h.options, apply: true, confirmNoActiveJobs: true },
      h.deps,
    );
    assert.equal(ok, false);
    // The drop-in was not applied, so the wrong runtime directory is caught first.
    assert.equal(lines(out).FAILURE, "RUNTIME_CWD_WRONG");
    assert.equal(lines(out).ROLLBACK, "PASS");
    assert.equal(fs.existsSync(h.dropIn), false);
  },
);

test(
  "a gateway that will not come back is reported as manual recovery, never as success",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t, { state: { breakOnRestart: true } });
    const { ok, out } = await runCutover(
      { ...h.options, apply: true, confirmNoActiveJobs: true },
      h.deps,
    );
    const r = lines(out);
    assert.equal(ok, false);
    assert.equal(r.FAILURE, "GATEWAY_FAILED_RESTART");
    assert.equal(r.ROLLBACK, "FAIL_MANUAL_RECOVERY_REQUIRED");
    assert.equal(r.RESULT, "FAIL");
  },
);

test(
  "preflight refuses unsafe hosts, users, candidates and configs before any change",
  { skip: POSIX_ONLY },
  async (t) => {
    const cases = [
      [{ uid: 1000 }, "ROOT_REQUIRED"],
      [{ hostname: "other-box" }, "UNEXPECTED_HOST"],
      [{ configMode: 0o644 }, "CONFIG_NOT_PRIVATE"],
      [{ state: { user: "root" } }, "WRONG_SERVICE_USER"],
      [{ state: { dirty: true } }, "CANDIDATE_DIRTY"],
      [{ state: { candidateHead: OLD_SHA } }, "CANDIDATE_SHA_MISMATCH"],
      [{ state: { active: false } }, "GATEWAY_NOT_RUNNING"],
    ];
    for (const [tweak, code] of cases) {
      const h = host(t, tweak);
      await assert.rejects(
        runCutover(
          { ...h.options, apply: true, confirmNoActiveJobs: true },
          h.deps,
        ),
        (error) => error.code === code,
        code,
      );
      assert.equal(h.state.restarts, 0, code);
      assert.equal(fs.existsSync(h.dropIn), false, code);
    }
    const missing = host(t);
    fs.rmSync(path.join(missing.target, "node_modules"), { recursive: true });
    await assert.rejects(
      runCutover(missing.options, missing.deps),
      /DEPENDENCIES_MISSING/,
    );
    const same = host(t);
    same.state.cwd = same.target;
    fs.rmSync(path.join(same.options.procRoot, "100"), { recursive: true });
    fs.mkdirSync(path.join(same.options.procRoot, "100"));
    fs.writeFileSync(
      path.join(same.options.procRoot, "100", "cmdline"),
      [
        same.node,
        path.join(same.target, "src/cli.js"),
        "gateway",
        same.config,
      ].join("\0") + "\0",
    );
    fs.symlinkSync(same.node, path.join(same.options.procRoot, "100", "exe"));
    fs.symlinkSync(same.target, path.join(same.options.procRoot, "100", "cwd"));
    await assert.rejects(
      runCutover(same.options, same.deps),
      /ALREADY_RUNNING_TARGET/,
    );
  },
);

test(
  "a leftover lock file blocks a second cutover instead of racing it",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t);
    fs.writeFileSync(h.options.lockFile, "");
    await assert.rejects(
      runCutover(
        { ...h.options, apply: true, confirmNoActiveJobs: true },
        h.deps,
      ),
      /CUTOVER_LOCKED/,
    );
    assert.equal(h.state.restarts, 0);
  },
);

test("the controller refuses to run anywhere but Linux, on every OS", async () => {
  const deps = {
    platform: () => "win32",
    uid: () => 0,
    run() {
      throw new Error("must not run any command");
    },
  };
  await assert.rejects(
    runCutover({ ...DEFAULTS, targetSha: NEW_SHA, apply: true }, deps),
    (error) => error.code === "UNSUPPORTED_PLATFORM",
  );
});

test("only drop-ins made of this controller's own lines may be replaced", async (t) => {
  const ours = dropInContent({
    target: "/opt/c/" + NEW_SHA,
    sha: NEW_SHA,
    node: "/usr/bin/node",
    config: "/etc/k/g.json",
  });
  assert.equal(recognizedDropIn(ours), true);
  // The one-time utility's format (no commit marker) is also recognized.
  assert.equal(
    recognizedDropIn(
      "[Service]\nWorkingDirectory=/opt/c/x\nExecStart=\nExecStart=/usr/bin/node /opt/c/x/src/cli.js gateway /etc/k/g.json\n",
    ),
    true,
  );
  for (const bad of [
    "",
    "WorkingDirectory=/opt/c/x\n",
    ours + "Environment=EXTRA=1\n",
    ours + "LimitNOFILE=1\n",
    ours + "ExecStartPre=/bin/true\n",
    "[Service]\nExecStart=/bin/sh -c evil\n",
    "[Service]\nWorkingDirectory=/opt/c/x y\n",
  ])
    assert.equal(recognizedDropIn(bad), false, JSON.stringify(bad));
});

test(
  "an operator-edited drop-in blocks the cutover before anything changes",
  { skip: POSIX_ONLY },
  async (t) => {
    const h = host(t);
    const edited =
      dropInContent({
        target: h.oldRoot,
        sha: OLD_SHA,
        node: h.node,
        config: h.config,
      }) + "LimitNOFILE=65536\n";
    fs.mkdirSync(path.dirname(h.dropIn), { recursive: true });
    fs.writeFileSync(h.dropIn, edited);
    await assert.rejects(
      runCutover(
        { ...h.options, apply: true, confirmNoActiveJobs: true },
        h.deps,
      ),
      (error) => error.code === "DROPIN_UNRECOGNIZED",
    );
    assert.equal(h.state.restarts, 0);
    assert.equal(fs.readFileSync(h.dropIn, "utf8"), edited);
    assert.equal(fs.existsSync(h.options.backupRoot), false);
  },
);
