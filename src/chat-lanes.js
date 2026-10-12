import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";

const MAX_LEASES = 128;
const MAX_SECONDS = 3600;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function normalized(input) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 512 ||
    input.includes("\\") ||
    input.startsWith("/") ||
    input.includes("//") ||
    /[\x00-\x1f]/.test(input)
  ) fail("CHAT_LANE_INVALID_PATH");
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === ".git") fail("CHAT_LANE_INVALID_PATH");
  return parts.join("/");
}
function overlaps(a, b) {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
function eligible(row) {
  return row && typeof row === "object" && KEY.test(row.project) &&
    KEY.test(row.requestKey) && Array.isArray(row.paths) &&
    typeof row.token === "string" && /^[0-9a-f-]{36}$/.test(row.token) &&
    Number.isFinite(row.expiresAt);
}

export class ChatLaneRegistry {
  constructor(stateDir, { now = () => Date.now() } = {}) {
    this.dir = path.join(stateDir, "chat-lanes");
    this.file = path.join(this.dir, "lanes.json");
    this.now = now;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    let value;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072)
        fail("CHAT_LANE_JOURNAL_CORRUPT");
      value = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch { fail("CHAT_LANE_JOURNAL_CORRUPT"); }
    if (!Array.isArray(value) || value.length > MAX_LEASES ||
      !value.every(eligible)) fail("CHAT_LANE_JOURNAL_CORRUPT");
    return value;
  }

  persist(rows) {
    const temp = path.join(this.dir, "lanes-" + randomUUID() + ".tmp");
    fs.writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(temp, this.file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  active() {
    return this.load().filter((row) => row.expiresAt > this.now());
  }

  status(project) {
    const active = this.active().filter((row) => row.project === project);
    return {
      activeCount: active.length,
      lanes: active.map((row) => ({
        requestKey: row.requestKey,
        paths: row.paths,
        expiresAt: new Date(row.expiresAt).toISOString(),
      })),
      note: "Only CodeBridge file write/edit operations honor these reservations. Other AI clients and Git commands must use separate branches/worktrees.",
    };
  }

  reserve(project, requestKey, paths, ttlSeconds) {
    if (!KEY.test(project) || !KEY.test(requestKey) ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 60 ||
      ttlSeconds > MAX_SECONDS || !Array.isArray(paths) ||
      paths.length < 1 || paths.length > 20) fail("CHAT_LANE_INVALID");
    const cleanPaths = [...new Set(paths.map(normalized))].sort();
    const active = this.active();
    const prior = active.find((row) => row.project === project && row.requestKey === requestKey);
    if (prior) {
      if (JSON.stringify(prior.paths) !== JSON.stringify(cleanPaths))
        fail("CHAT_LANE_IDEMPOTENCY_CONFLICT");
      return { leaseToken: prior.token, paths: prior.paths,
        expiresAt: new Date(prior.expiresAt).toISOString(), reused: true };
    }
    if (active.length >= MAX_LEASES) fail("CHAT_LANE_CAPACITY");
    if (active.some((row) => row.project === project &&
      row.paths.some((other) => cleanPaths.some((candidate) => overlaps(other, candidate)))))
      fail("CHAT_LANE_CONFLICT");
    const row = { project, requestKey, paths: cleanPaths,
      token: randomUUID(), expiresAt: this.now() + ttlSeconds * 1000 };
    this.persist([...active, row]);
    return { leaseToken: row.token, paths: row.paths,
      expiresAt: new Date(row.expiresAt).toISOString(), reused: false };
  }

  assertWritable(project, paths, token) {
    const requested = paths.map(normalized);
    const conflicting = this.active().filter((row) => row.project === project &&
      row.paths.some((p) => requested.some((s) => overlaps(p, s))));
    if (conflicting.some((row) => row.token !== token))
      fail("CHAT_LANE_CONFLICT");
  }

  release(project, token) {
    if (!KEY.test(project) || typeof token !== "string")
      fail("CHAT_LANE_INVALID");
    const active = this.active();
    const mine = active.find((row) => row.project === project && row.token === token);
    if (!mine) fail("CHAT_LANE_NOT_FOUND");
    this.persist(active.filter((row) => row !== mine));
    return { released: true };
  }
}
