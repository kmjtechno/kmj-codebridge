import fs from "node:fs";
import path from "node:path";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fail } from "./errors.js";

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const ENTRY_LIMIT = 4096;
const KEY_BYTES = 32;
const ENTRY_PATTERN = /^[a-zA-Z0-9-]+\.entry$/;

function secureDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CORRUPT_JOB_ARCHIVE");
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) fail("INSECURE_JOB_ARCHIVE");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      fail("INSECURE_JOB_ARCHIVE");
  }
}

function readPrivateFile(file, maxSize) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxSize)
    fail("CORRUPT_JOB_ARCHIVE");
  if (process.platform !== "win32") {
    if ((before.mode & 0o077) !== 0) fail("INSECURE_JOB_ARCHIVE");
    if (typeof process.getuid === "function" && before.uid !== process.getuid())
      fail("INSECURE_JOB_ARCHIVE");
  }
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const after = fs.fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size > maxSize ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      fail("CORRUPT_JOB_ARCHIVE");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(dir) {
  // Windows does not support fsync of directory handles in Node.
  if (process.platform === "win32") return;
  const fd = fs.openSync(
    dir,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY || 0) |
      (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusive(file, data) {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function archiveRecord(job) {
  return {
    v: 1,
    id: job.id,
    project: job.project,
    gate: job.gate,
    key: job.key,
    fingerprint: job.fingerprint,
    state: job.state,
    queuedAt: job.queuedAt ?? null,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    exitCode: job.exitCode ?? null,
    truncated: Boolean(job.truncated),
    archivedAt: new Date().toISOString(),
  };
}

function validRecord(record, filename) {
  return (
    record?.v === 1 &&
    typeof record.id === "string" &&
    /^[a-zA-Z0-9-]{1,128}$/.test(record.id) &&
    filename === record.id + ".entry" &&
    typeof record.project === "string" &&
    record.project.length > 0 &&
    record.project.length <= 128 &&
    typeof record.gate === "string" &&
    record.gate.length > 0 &&
    record.gate.length <= 128 &&
    typeof record.key === "string" &&
    record.key.length > 0 &&
    record.key.length <= 128 &&
    typeof record.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.fingerprint) &&
    TERMINAL.has(record.state) &&
    typeof record.endedAt === "string" &&
    Number.isFinite(Date.parse(record.endedAt)) &&
    typeof record.archivedAt === "string" &&
    Number.isFinite(Date.parse(record.archivedAt)) &&
    (record.queuedAt === null || typeof record.queuedAt === "string") &&
    (record.startedAt === null || typeof record.startedAt === "string") &&
    (record.exitCode === null || Number.isInteger(record.exitCode)) &&
    typeof record.truncated === "boolean" &&
    Object.keys(record).length === 13
  );
}

export class DurableJobArchive {
  constructor(root, { maxEntries = 100000 } = {}) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 1000000
    )
      fail("INVALID_JOB_ARCHIVE_LIMIT");
    this.root = root;
    this.dir = path.join(root, "job-archive");
    this.maxEntries = maxEntries;
    this.byId = new Map();
    this.byKey = new Map();
    this.secret = [REDACTED];
    if (fs.existsSync(this.dir)) this.load();
  }

  index(record) {
    const keyed = JSON.stringify([record.project, record.key]);
    if (this.byId.has(record.id) || this.byKey.has(keyed))
      fail("CORRUPT_JOB_ARCHIVE");
    this.byId.set(record.id, record);
    this.byKey.set(keyed, record);
  }

  load() {
    secureDirectory(this.dir);
    const names = fs.readdirSync(this.dir);
    if (!names.includes(".hmac-key")) fail("CORRUPT_JOB_ARCHIVE");
    this.secret = [REDACTED], ".hmac-key"), KEY_BYTES);
    if (this.secret.length !== KEY_BYTES) fail("CORRUPT_JOB_ARCHIVE");
    for (const name of names) {
      if (name === ".hmac-key" || /^\.pending-[a-f0-9-]+$/.test(name)) continue;
      if (!ENTRY_PATTERN.test(name)) fail("CORRUPT_JOB_ARCHIVE");
      if (this.byId.size >= this.maxEntries) fail("JOB_ARCHIVE_FULL");
      let container;
      try {
        const bytes = readPrivateFile(path.join(this.dir, name), ENTRY_LIMIT);
        container = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("CORRUPT_JOB_ARCHIVE");
      }
      if (
        !container ||
        typeof container !== "object" ||
        Object.keys(container).length !== 2 ||
        typeof container.mac !== "string" ||
        !/^[a-f0-9]{64}$/.test(container.mac) ||
        !validRecord(container.record, name)
      )
        fail("CORRUPT_JOB_ARCHIVE");
      const expected = createHmac("sha256", this.secret)
        .update(JSON.stringify(container.record))
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(container.mac, "hex")))
        fail("CORRUPT_JOB_ARCHIVE");
      this.index(container.record);
    }
  }

  initialize() {
    if (this.secret) return;
    fs.mkdirSync(this.dir, { mode: 0o700 });
    secureDirectory(this.dir);
    const key = randomBytes(KEY_BYTES);
    writeExclusive(path.join(this.dir, ".hmac-key"), key);
    syncDirectory(this.dir);
    syncDirectory(this.root);
    this.secret = [REDACTED];
  }

  lookup(project, key) {
    const record = this.byKey.get(JSON.stringify([project, key]));
    return record ? this.publicRecord(record) : null;
  }

  get(id) {
    const record = this.byId.get(id);
    return record ? this.publicRecord(record) : null;
  }

  publicRecord(record) {
    return { ...record, output: "", outputAvailable: false, archived: true };
  }

  count(project = null) {
    if (project === null) return this.byId.size;
    return [...this.byId.values()].filter(
      (record) => record.project === project,
    ).length;
  }

  add(job) {
    if (!TERMINAL.has(job.state) || !job.endedAt)
      fail("JOB_ARCHIVE_NON_TERMINAL");
    const key = JSON.stringify([job.project, job.key]);
    const existing = this.byId.get(job.id) ?? this.byKey.get(key);
    if (existing) {
      if (
        existing.id !== job.id ||
        existing.project !== job.project ||
        existing.key !== job.key ||
        existing.fingerprint !== job.fingerprint ||
        existing.state !== job.state
      )
        fail("CORRUPT_JOB_ARCHIVE");
      return this.publicRecord(existing);
    }
    if (this.byId.size >= this.maxEntries) fail("JOB_ARCHIVE_FULL");
    const record = archiveRecord(job);
    if (!validRecord(record, record.id + ".entry"))
      fail("JOB_ARCHIVE_INVALID_RECORD");
    this.initialize();
    const payload = JSON.stringify({
      record,
      mac: createHmac("sha256", this.secret)
        .update(JSON.stringify(record))
        .digest("hex"),
    });
    if (Buffer.byteLength(payload) > ENTRY_LIMIT)
      fail("JOB_ARCHIVE_INVALID_RECORD");
    const temp = path.join(this.dir, ".pending-" + randomUUID());
    const target = path.join(this.dir, record.id + ".entry");
    writeExclusive(temp, payload);
    try {
      if (fs.existsSync(target)) fail("CORRUPT_JOB_ARCHIVE");
      fs.renameSync(temp, target);
      syncDirectory(this.dir);
    } catch (error) {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw error;
    }
    this.index(record);
    return this.publicRecord(record);
  }
}
