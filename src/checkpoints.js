import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./errors.js";

const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_PROJECT_CHECKPOINTS = 100;
const digest = (text) => createHash("sha256").update(text).digest("hex");

function safeDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(dir);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
  )
    fail("CHECKPOINT_DIR_INSECURE");
}

export class FileCheckpoints {
  constructor(stateDir) {
    this.dir = path.join(stateDir, "file-checkpoints");
    safeDirectory(this.dir);
  }

  location(project, requestKey) {
    if (!PROJECT.test(project) || !REQUEST_KEY.test(requestKey))
      fail("INVALID_CHECKPOINT_ID");
    const dir = path.join(this.dir, project);
    safeDirectory(dir);
    return path.join(dir, digest(requestKey) + ".json");
  }

  load(project, requestKey) {
    const file = this.location(project, requestKey);
    if (!fs.existsSync(file)) fail("CHECKPOINT_NOT_FOUND");
    const stats = fs.lstatSync(file);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size > MAX_CHECKPOINT_BYTES * 4 ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    )
      fail("CHECKPOINT_INVALID");
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail("CHECKPOINT_INVALID");
    }
    const { integrity, ...payload } = record ?? {};
    if (
      payload.schema !== 1 ||
      payload.project !== project ||
      typeof payload.path !== "string" ||
      !SHA256.test(payload.sha256 ?? "") ||
      typeof payload.content !== "string" ||
      Buffer.byteLength(payload.content) > MAX_CHECKPOINT_BYTES ||
      digest(payload.content) !== payload.sha256 ||
      typeof integrity !== "string" ||
      digest(JSON.stringify(payload)) !== integrity
    ) fail("CHECKPOINT_INVALID");
    return payload;
  }

  public(record) {
    return {
      project: record.project,
      checkpoint: record.checkpoint,
      path: record.path,
      sha256: record.sha256,
      bytes: record.bytes,
      createdAt: record.createdAt,
    };
  }

  create(project, requestKey, relative, expectedHash, files, contentAllowed) {
    if (!SHA256.test(expectedHash ?? "")) fail("INVALID_HASH");
    const target = this.location(project, requestKey);
    if (fs.existsSync(target)) {
      const saved = this.load(project, requestKey);
      if (saved.path !== relative || saved.sha256 !== expectedHash)
        fail("IDEMPOTENCY_CONFLICT");
      return { ...this.public(saved), existing: true };
    }

    const source = files.read(relative);
    if (source.sha256 !== expectedHash) fail("CONTENT_CONFLICT");
    if (source.bytes > MAX_CHECKPOINT_BYTES) fail("CHECKPOINT_TOO_LARGE");
    if (!contentAllowed(source.content)) fail("SENSITIVE_CONTENT_PROTECTED");
    const folder = path.dirname(target);
    if (
      fs.readdirSync(folder).filter((name) => name.endsWith(".json")).length >=
      MAX_PROJECT_CHECKPOINTS
    )
      fail("CHECKPOINT_CAPACITY_EXCEEDED");

    const record = {
      schema: 1,
      project,
      checkpoint: path.basename(target, ".json"),
      path: relative,
      sha256: source.sha256,
      bytes: source.bytes,
      createdAt: new Date().toISOString(),
      content: source.content,
    };
    const encoded = JSON.stringify({
      ...record,
      integrity: digest(JSON.stringify(record)),
    });
    let fd;
    try {
      fd = fs.openSync(target, "wx", 0o600);
      fs.writeFileSync(fd, encoded);
      fs.fsyncSync(fd);
    } catch (error) {
      if (error.code === "EEXIST") {
        const saved = this.load(project, requestKey);
        if (saved.path !== relative || saved.sha256 !== expectedHash)
          fail("IDEMPOTENCY_CONFLICT");
        return { ...this.public(saved), existing: true };
      }
      fail("CHECKPOINT_WRITE_FAILED");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return { ...this.public(record), existing: false };
  }

  restorePlan(project, requestKey, files) {
    const saved = this.load(project, requestKey);
    // Read through existing project-root guards: no symlinks or secret paths.
    const current = files.read(saved.path);
    return {
      ...this.public(saved),
      currentSha256: current.sha256,
      unchanged: current.sha256 === saved.sha256,
      restoreAvailable: false,
      nextAction: "REQUIRE_EXPLICIT_APPROVAL_FOR_ROLLBACK",
    };
  }
}
