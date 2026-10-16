import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const linux = { skip: process.platform !== "linux" };
async function fixture(t) {
  const m = await import("../src/update-maintenance.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-maintenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = path.join(root, "control");
  const stateDir = path.join(root, "agent");
  fs.mkdirSync(control, { mode: 0o755 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const requestPath = path.join(control, "maintenance", "request.json");
  const agentOwner = "test-agent-instance";
  fs.writeFileSync(
    path.join(stateDir, "agent.lock"),
    JSON.stringify({ pid: process.pid, owner: agentOwner }),
  );
  const options = {
    requestPath,
    trustedUid: process.getuid(),
    identify: (pid) =>
      pid === process.pid
        ? { id: "test-boot:42", uid: process.getuid() }
        : null,
  };
  const guard = new m.AgentUpdateGuard({
    stateDir,
    agentOwner,
    isIdle: () => true,
    ...options,
  });
  t.after(() => guard.close());
  const acquire = () =>
    m.acquireUpdateMaintenance(
      { agentStateDir: stateDir },
      {
        ...options,
        status: async () => ({ activeState: "active", mainPid: process.pid }),
        attempts: 2,
        sleep: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          guard.refresh();
        },
      },
    );
  return { m, root, stateDir, requestPath, options, guard, acquire };
}

test(
  "maintenance stops new operations and waits for in-flight activity before acknowledging",
  linux,
  async (t) => {
    const { guard, acquire, stateDir } = await fixture(t);
    let finish;
    const running = guard.run(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const lease = acquire();
    t.after(() => lease.close());
    assert.equal(guard.canStart(), true, "downloads must not pause the agent");
    const draining = lease.drain();
    assert.equal(guard.canStart(), false);
    await assert.rejects(
      guard.run(() => assert.fail("new work ran")),
      /UPDATE_MAINTENANCE/,
    );
    assert.equal(
      fs.existsSync(path.join(stateDir, "update-drained.json")),
      false,
    );
    finish("completed");
    assert.equal(await running, "completed");
    guard.refresh();
    await draining;
    lease.close();
    assert.equal(guard.canStart(), true);
  },
);

test(
  "maintenance defers activation while jobs or worker bookkeeping remain active",
  linux,
  async (t) => {
    const f = await fixture(t);
    f.guard.isIdle = () => false;
    const lease = f.acquire();
    await assert.rejects(lease.drain(), /UPDATE_AGENT_BUSY_OR_UNSUPPORTED/);
    assert.equal(
      fs.existsSync(path.join(f.stateDir, "update-drained.json")),
      false,
    );
    lease.close();
    assert.equal(f.guard.canStart(), true);
  },
);

test(
  "a second updater cannot acquire the same maintenance lease",
  linux,
  async (t) => {
    const f = await fixture(t);
    const lease = f.acquire();
    assert.throws(() => f.acquire(), /UPDATE_ALREADY_RUNNING_OR_STALE_LOCK/);
    lease.close();
  },
);

test(
  "stale or wrong-process acknowledgements cannot authorize a restart",
  linux,
  async (t) => {
    const f = await fixture(t);
    const lease = f.m.acquireUpdateMaintenance(
      { agentStateDir: f.stateDir },
      {
        ...f.options,
        status: async () => ({
          activeState: "active",
          mainPid: process.pid + 1,
        }),
        attempts: 2,
        sleep: async () => f.guard.refresh(),
      },
    );
    f.guard.refresh();
    await assert.rejects(lease.drain(), /UPDATE_AGENT_BUSY_OR_UNSUPPORTED/);
    lease.close();
  },
);

test(
  "malformed or linked maintenance files fail closed for agent admission",
  linux,
  async (t) => {
    const f = await fixture(t);
    fs.mkdirSync(path.dirname(f.requestPath), { mode: 0o755 });
    fs.writeFileSync(f.requestPath, "{");
    fs.chmodSync(f.requestPath, 0o644);
    assert.equal(f.guard.canStart(), false);
    fs.unlinkSync(f.requestPath);
    fs.symlinkSync(path.join(f.stateDir, "agent.lock"), f.requestPath);
    assert.equal(f.guard.canStart(), false);
  },
);

test(
  "agent resumes after the updater process dies without releasing its request",
  linux,
  async (t) => {
    const f = await fixture(t);
    if (
      !fs.existsSync(`/proc/${process.pid}/stat`) ||
      !fs
        .readFileSync(`/proc/${process.pid}/stat`, "utf8")
        .startsWith(`${process.pid} `)
    ) {
      t.skip(
        "sandbox does not expose its process namespace in /proc; exercised in Linux CI",
      );
      return;
    }
    f.guard.close();
    f.guard = new f.m.AgentUpdateGuard({
      stateDir: f.stateDir,
      agentOwner: "test-agent-instance",
      isIdle: () => true,
      requestPath: f.requestPath,
      trustedUid: process.getuid(),
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { acquireUpdateMaintenance } from ${JSON.stringify(new URL("../src/update-maintenance.js", import.meta.url).href)};
    const lease=acquireUpdateMaintenance({agentStateDir:process.argv[2]}, {requestPath:process.argv[1],trustedUid:process.getuid(),attempts:1});
    lease.drain().catch(()=>{});
    console.log('ready');
    setInterval(()=>{},1000);
  `,
        f.requestPath,
        f.stateDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw Error("canary child exited before ready");
      }),
    ]);
    assert.equal(f.guard.canStart(), false);
    const ended = once(child, "exit");
    child.kill("SIGKILL");
    await ended;
    assert.equal(f.guard.canStart(), true);
  },
);

test(
  "maintenance publishes only a complete intent, never an empty public file",
  linux,
  async (t) => {
    const f = await fixture(t);
    const sync = fs.fsyncSync;
    let inspected = false;
    fs.fsyncSync = (fd) => {
      inspected = true;
      assert.equal(fs.existsSync(f.requestPath), false);
      assert.equal(f.guard.canStart(), true);
      return sync(fd);
    };
    let lease;
    try {
      lease = f.acquire();
    } finally {
      fs.fsyncSync = sync;
    }
    assert.equal(inspected, true);
    assert.equal(
      JSON.parse(fs.readFileSync(f.requestPath, "utf8")).phase,
      "prepare",
    );
    lease.close();
  },
);

test(
  "drain preserves real active and queued jobs until both have finished",
  linux,
  async (t) => {
    const f = await fixture(t);
    const { JobRunner } = await import("../src/jobs.js");
    const runner = new JobRunner(path.join(f.stateDir, "jobs"), {
      resourceProbe: () => ({
        cpuCount: 2,
        loadOne: 0,
        totalMemoryBytes: 2 ** 30,
        freeMemoryBytes: 2 ** 29,
        freeDiskBytes: 2 ** 30,
      }),
    });
    t.after(() => runner.close());
    f.guard.isIdle = () =>
      runner.active.size === 0 && runner.pending.size === 0;
    const spec = {
      project: "p",
      gate: "unit",
      cwd: f.root,
      command: process.execPath,
      args: ["-e", "setTimeout(()=>console.log('done'),40)"],
      timeoutMs: 2000,
    };
    const a = runner.run({ ...spec, key: "first" });
    const b = runner.run({ ...spec, key: "second" });
    assert.equal(runner.active.size, 1);
    assert.equal(runner.pending.size, 1);
    const lease = f.m.acquireUpdateMaintenance(
      { agentStateDir: f.stateDir },
      {
        ...f.options,
        status: async () => ({ activeState: "active", mainPid: process.pid }),
        attempts: 100,
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 10));
          f.guard.refresh();
        },
      },
    );
    try {
      await lease.drain();
      assert.equal(runner.get(a.id, "p").state, "succeeded");
      assert.equal(runner.get(b.id, "p").state, "succeeded");
      await assert.rejects(
        f.guard.run(() => runner.run({ ...spec, key: "third" })),
        /UPDATE_MAINTENANCE/,
      );
    } finally {
      lease.close();
      await runner.close();
    }
  },
);
