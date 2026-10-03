import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";

const LINUX_BOOT_ID = "/proc/sys/kernel/random/boot_id";

function readBootId() {
  if (process.platform !== "linux") return null;
  try {
    const value = fs.readFileSync(LINUX_BOOT_ID, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function parseLock(raw) {
  const text = raw.trim();
  if (/^[1-9]\d*$/.test(text))
    return { pid: Number(text), bootId: null, owner: null };
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      (value.bootId !== null &&
        value.bootId !== undefined &&
        typeof value.bootId !== "string") ||
      (value.owner !== null &&
        value.owner !== undefined &&
        typeof value.owner !== "string")
    )
      return null;
    return {
      pid: value.pid,
      bootId: value.bootId || null,
      owner: value.owner || null,
    };
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function lockPredatesCurrentBoot(lockPath) {
  try {
    const bootTimeMs = Date.now() - os.uptime() * 1000;
    return fs.statSync(lockPath).mtimeMs < bootTimeMs - 5000;
  } catch {
    return false;
  }
}

function staleLockIsProven(record, bootId, lockPath) {
  if (!record) return false;
  if (lockPredatesCurrentBoot(lockPath)) return true;
  if (record.bootId && bootId && record.bootId !== bootId) return true;
  return !processExists(record.pid);
}

export function acquireAgentLock(stateDir) {
  const lockPath = path.join(stateDir, "agent.lock");
  const bootId = readBootId();
  const owner = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, bootId, owner }) + "\n";

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return { path: lockPath, owner };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
      if (error?.code !== "EEXIST") throw error;

      let existing;
      try {
        existing = parseLock(fs.readFileSync(lockPath, "utf8"));
      } catch {
        fail("AGENT_ALREADY_RUNNING_OR_STALE_LOCK");
      }
      if (!staleLockIsProven(existing, bootId, lockPath))
        fail("AGENT_ALREADY_RUNNING_OR_STALE_LOCK");

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT")
          fail("AGENT_ALREADY_RUNNING_OR_STALE_LOCK");
      }
    }
  }

  fail("AGENT_ALREADY_RUNNING_OR_STALE_LOCK");
}

export function releaseAgentLock(lock) {
  if (!lock?.path || !lock.owner) return;
  let existing;
  try {
    existing = parseLock(fs.readFileSync(lock.path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (existing?.owner !== lock.owner) return;
  try {
    fs.unlinkSync(lock.path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
