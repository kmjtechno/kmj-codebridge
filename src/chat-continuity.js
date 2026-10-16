import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

// Private, project-scoped summaries, NOT ChatGPT messages or browser sessions.
// Only the enrolled device agent owns this directory. A lane is a caller
// label; neither identity nor reported work is independently attested.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const SLOT_LIMIT = 32;
const FILE_MAX = 4096;
const MAX_BLOCKERS = 6;

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function safeText(value, min, max) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.trim() !== value ||
    // Never store secrets, URLs, terminal output or multiline transcripts.
    /[\x00-\x1f\x7f]/.test(value) ||
    /https?:\/\/|-----BEGIN |(?:sk|ghp|gho|ghu|ghs|ghr)-?[A-Za-z0-9_-]{18,}/i.test(
      value,
    ) ||
    redact(value) !== value
  )
    fail("CHAT_CONTINUITY_UNSAFE_TEXT");
  return value;
}

function safeDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    fail("CHAT_CONTINUITY_UNSAFE_DIRECTORY");
}

export class ChatContinuity {
  constructor(stateDir) {
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir))
      fail("CHAT_CONTINUITY_STATE_UNAVAILABLE");
    this.directory = path.join(stateDir, "chat-continuity");
    safeDirectory(this.directory);
  }

  file(project, lane) {
    if (!PROJECT.test(project ?? "") || !KEY.test(lane ?? ""))
      fail("CHAT_CONTINUITY_INVALID_SCOPE");
    const id = digest([project, lane]);
    return path.join(this.directory, id + ".json");
  }

  read(project, lane) {
    const file = this.file(project, lane);
    if (!fs.existsSync(file)) return null;
    let value;
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 2 ||
        stat.size > FILE_MAX ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        fail("CHAT_CONTINUITY_CORRUPT");
      value = JSON.parse(fs.readFileSync(file, "utf8"));
      const { revision, ...contents } = value;
      if (
        value.project !== project ||
        value.lane !== lane ||
        value.version !== 1 ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        !KEY.test(value.requestKey ?? "") ||
        !HASH.test(revision ?? "") ||
        digest(contents) !== revision ||
        !Array.isArray(value.blockers) ||
        value.blockers.length > MAX_BLOCKERS ||
        !Number.isFinite(Date.parse(value.updatedAt))
      )
        fail("CHAT_CONTINUITY_CORRUPT");
      safeText(value.summary, 1, 1000);
      safeText(value.next, 1, 500);
      for (const blocker of value.blockers) safeText(blocker, 1, 120);
    } catch {
      fail("CHAT_CONTINUITY_CORRUPT");
    }
    return value;
  }

  status(project, lane) {
    const current = this.read(project, lane);
    return current
      ? {
          ...current,
          source: "DEVICE_LOCAL_CHECKPOINT",
          contentTrusted: false,
          chatAutoWake: false,
        }
      : {
          project,
          lane,
          version: 1,
          exists: false,
          revision: null,
          source: "DEVICE_LOCAL_CHECKPOINT",
          chatAutoWake: false,
        };
  }

  save(
    project,
    lane,
    { requestKey, expectedRevision, summary, next, blockers },
  ) {
    if (
      !KEY.test(requestKey ?? "") ||
      !Array.isArray(blockers) ||
      blockers.length > MAX_BLOCKERS
    )
      fail("CHAT_CONTINUITY_INVALID_UPDATE");
    const body = {
      summary: safeText(summary, 1, 1000),
      next: safeText(next, 1, 500),
      blockers: blockers.map((item) => safeText(item, 1, 120)),
    };
    const current = this.read(project, lane);
    // Retried calls with the same request key must be identical, even if
    // the original response was lost after the durable atomic rename.
    if (current?.requestKey === requestKey) {
      if (
        JSON.stringify(body) !==
        JSON.stringify({
          summary: current.summary,
          next: current.next,
          blockers: current.blockers,
        })
      )
        fail("CHAT_CONTINUITY_IDEMPOTENCY_CONFLICT");
      return { project, lane, revision: current.revision, reused: true };
    }
    if (
      expectedRevision !== (current?.revision ?? null) ||
      (expectedRevision !== null && !HASH.test(expectedRevision ?? ""))
    )
      fail("CHAT_CONTINUITY_VERSION_CONFLICT");
    const filenames = fs.readdirSync(this.directory);
    if (
      filenames.some(
        (filename) =>
          !HASH.test(filename.slice(0, -5)) || !filename.endsWith(".json"),
      )
    )
      fail("CHAT_CONTINUITY_UNSAFE_DIRECTORY");
    if (!current && filenames.length >= SLOT_LIMIT)
      fail("CHAT_CONTINUITY_CAPACITY_REACHED");
    const contents = {
      version: 1,
      project,
      lane,
      sequence: (current?.sequence ?? 0) + 1,
      requestKey,
      ...body,
      updatedAt: new Date().toISOString(),
    };
    const packet = { ...contents, revision: digest(contents) };
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) > FILE_MAX)
      fail("CHAT_CONTINUITY_TOO_LARGE");
    const temp = path.join(this.directory, randomUUID() + ".tmp");
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, encoded);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // The agent process lock serializes device-local writes. The revision
      // precondition rejects stale multi-chat updates; no path escape exists.
      fs.renameSync(temp, this.file(project, lane));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return { project, lane, revision: packet.revision, reused: false };
  }
}
