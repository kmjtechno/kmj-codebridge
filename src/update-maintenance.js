import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { SUPERVISOR_SOCKET, supervisorRequest } from "./supervisor-client.js";

export const UPDATE_MAINTENANCE_REQUEST =
  "/run/kmj-codebridge-update/maintenance/request.json";
const ACK = "update-drained.json";

// PID alone is insufficient: Linux can reuse it after a crashed updater.
function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const boot = fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (Number(stat.slice(0, stat.indexOf(" "))) !== pid)
      fail("UPDATE_MAINTENANCE_UNAVAILABLE");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0])) return null;
    const start = fields[19];
    if (!/^\d+$/.test(start)) return null;
    return { id: `${boot}:${start}`, uid: fs.statSync(`/proc/${pid}`).uid };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

function readRecord(file, trustedUid) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (trustedUid !== undefined &&
        (stat.uid !== trustedUid || stat.mode & 0o022))
    )
      fail("UPDATE_MAINTENANCE_INVALID");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function checkParent(file, trustedUid) {
  const parent = path.dirname(file);
  const s = fs.lstatSync(parent);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== trustedUid ||
    s.mode & 0o022 ||
    fs.realpathSync(parent) !== parent
  )
    fail("UPDATE_MAINTENANCE_INVALID");
}

function readRequest(file, trustedUid, identify) {
  try {
    checkParent(file, trustedUid);
    const r = readRecord(file, trustedUid);
    if (
      r?.schema !== 1 ||
      !/^[a-f0-9-]{36}$/.test(r.token ?? "") ||
      !["prepare", "drain"].includes(r.phase) ||
      typeof r.identity !== "string" ||
      !Number.isSafeInteger(r.pid) ||
      r.pid < 1
    )
      fail("UPDATE_MAINTENANCE_INVALID");
    // A proven dead owner no longer prevents work. Its stale lock is retained
    // for operator inspection; another updater must never steal a live lock.
    const owner = identify(r.pid);
    if (owner?.id !== r.identity) return null;
    if (owner.uid !== trustedUid) fail("UPDATE_MAINTENANCE_INVALID");
    return r;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function replaceRecord(file, value, mode) {
  const temp = `${file}.tmp-${randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export class AgentUpdateGuard {
  constructor({
    stateDir,
    agentOwner,
    isIdle,
    requestPath = UPDATE_MAINTENANCE_REQUEST,
    trustedUid = 0,
    identify = processInfo,
  }) {
    this.stateDir = stateDir;
    this.agentOwner = agentOwner;
    this.isIdle = isIdle;
    this.requestPath = requestPath;
    this.trustedUid = trustedUid;
    this.identify = identify;
    this.active = 0;
    this.lastToken = null;
    this.timer = null;
  }
  canStart() {
    if (process.platform !== "linux") return true;
    try {
      return (
        readRequest(this.requestPath, this.trustedUid, this.identify)?.phase !==
        "drain"
      );
    } catch {
      return false;
    }
  }
  async run(operation) {
    if (!this.canStart()) fail("UPDATE_MAINTENANCE");
    return this.track(operation);
  }
  async track(operation) {
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }
  refresh() {
    if (process.platform !== "linux") return;
    try {
      const request = readRequest(
        this.requestPath,
        this.trustedUid,
        this.identify,
      );
      if (request?.phase !== "drain" || this.active || !this.isIdle()) return;
      if (this.lastToken === request.token) return;
      replaceRecord(
        path.join(this.stateDir, ACK),
        {
          schema: 1,
          token: request.token,
          pid: process.pid,
          identity: this.identify(process.pid)?.id,
          agentOwner: this.agentOwner,
        },
        0o600,
      );
      this.lastToken = request.token;
    } catch {
      // Malformed intent/failed acknowledgement never authorizes activation.
    }
  }
  start() {
    if (process.platform !== "linux") return;
    this.timer = setInterval(() => this.refresh(), 250);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
}

// This root-only lease serializes BOTH update and rollback, from reading the
// accepted sequence until the last restart/health check. prepare permits work;
// drain blocks admission across agent restarts until close() removes the intent.
export function acquireUpdateMaintenance(
  config,
  {
    requestPath = UPDATE_MAINTENANCE_REQUEST,
    trustedUid = 0,
    identify = processInfo,
    status = () =>
      supervisorRequest(SUPERVISOR_SOCKET, { op: "status", service: "agent" }),
    attempts = 40,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (process.platform !== "linux" || process.getuid() !== trustedUid)
    fail("UPDATE_MAINTENANCE_UNAVAILABLE");
  const leaseDir = path.dirname(requestPath);
  checkParent(leaseDir, trustedUid);
  const request = {
    schema: 1,
    token: randomUUID(),
    pid: process.pid,
    identity: identify(process.pid)?.id,
    phase: "prepare",
  };
  if (!request.identity) fail("UPDATE_MAINTENANCE_UNAVAILABLE");
  // Publish a COMPLETE nonempty directory atomically. rename cannot replace a
  // live nonempty lease directory. A kill before publication exposes no intent;
  // a kill afterward leaves a complete owner record that agents can inspect.
  const staging = `${leaseDir}.pending-${randomUUID()}`;
  fs.mkdirSync(staging, { mode: 0o755 });
  try {
    fs.chmodSync(staging, 0o755);
    replaceRecord(
      path.join(staging, path.basename(requestPath)),
      request,
      0o644,
    );
    if (fs.existsSync(leaseDir)) fail("UPDATE_ALREADY_RUNNING_OR_STALE_LOCK");
    try {
      fs.renameSync(staging, leaseDir);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST"].includes(error.code))
        fail("UPDATE_ALREADY_RUNNING_OR_STALE_LOCK");
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  let closed = false;
  const assertHeld = () => {
    const current = readRequest(requestPath, trustedUid, identify);
    if (closed || current?.token !== request.token)
      fail("UPDATE_MAINTENANCE_LOST");
  };
  return {
    assertHeld,
    drain: async () => {
      assertHeld();
      request.phase = "drain";
      replaceRecord(requestPath, request, 0o644);
      for (let i = 0; i < attempts; i++) {
        assertHeld();
        try {
          const ack = readRecord(path.join(config.agentStateDir, ACK));
          const lock = readRecord(
            path.join(config.agentStateDir, "agent.lock"),
          );
          if (
            ack.schema === 1 &&
            ack.token === request.token &&
            ack.pid === lock.pid &&
            ack.agentOwner === lock.owner &&
            ack.identity === identify(ack.pid)?.id
          ) {
            const live = await status();
            assertHeld();
            if (live?.activeState === "active" && live.mainPid === ack.pid)
              return;
          }
        } catch (error) {
          if (error?.code === "UPDATE_MAINTENANCE_LOST") throw error;
        }
        if (i + 1 < attempts) await sleep(250);
      }
      fail("UPDATE_AGENT_BUSY_OR_UNSUPPORTED");
    },
    close: () => {
      if (closed) return;
      assertHeld();
      const retired = `${leaseDir}.closed-${randomUUID()}`;
      fs.renameSync(leaseDir, retired);
      closed = true;
      fs.rmSync(retired, { recursive: true, force: true });
    },
  };
}
