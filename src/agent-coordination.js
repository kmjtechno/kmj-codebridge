import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

// Device-local, project-scoped, pull-based communication between authorized
// MCP clients. No background worker, external account, remote inference,
// arbitrary shell, or untrusted process identity is introduced here.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KINDS = new Set(["issue", "analysis", "proposal", "handoff", "result"]);
const GATES = new Set(["unknown", "pass", "fail", "blocked"]);
const MAX_MESSAGES = 256;
const MAX_MESSAGE_BYTES = 2048;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkDir(dir) {
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    fail("COORDINATION_DIR_UNSAFE");
}

function safeNote(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 500 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /https?:\/\/|-----BEGIN |(?:sk|ghp|gho|ghu|ghs|ghr)-?[A-Za-z0-9_-]{18,}/i.test(value) ||
    redact(value) !== value
  )
    fail("COORDINATION_SENSITIVE_OR_INVALID_NOTE");
  return value;
}

function safeRow(row, project, expectedId) {
  if (
    !row ||
    typeof row !== "object" ||
    row.version !== 1 ||
    row.project !== project ||
    row.id !== expectedId ||
    !DIGEST.test(row.id) ||
    !KEY.test(row.actor) ||
    !KEY.test(row.requestKey) ||
    !KEY.test(row.recipient) ||
    !KINDS.has(row.kind) ||
    !GATES.has(row.reportedGate) ||
    (row.replyTo !== null && !DIGEST.test(row.replyTo)) ||
    (row.evidenceSha !== null && !SHA.test(row.evidenceSha)) ||
    !Number.isSafeInteger(row.createdAtEpochMs) ||
    typeof row.note !== "string"
  )
    return false;
  try {
    safeNote(row.note);
  } catch {
    return false;
  }
  const { digest, ...payload } = row;
  return DIGEST.test(digest ?? "") && digest === hash(JSON.stringify(payload));
}

export class AgentCoordination {
  constructor(stateDir, { now = Date.now } = {}) {
    if (typeof now !== "function") fail("COORDINATION_INVALID_CLOCK");
    this.base = path.join(stateDir, "agent-coordination");
    this.now = now;
    checkDir(this.base);
  }

  directory(project) {
    if (!PROJECT.test(project)) fail("COORDINATION_INVALID_PROJECT");
    const dir = path.join(this.base, project);
    checkDir(dir);
    return dir;
  }

  filename(dir, id) {
    if (!DIGEST.test(id)) fail("COORDINATION_INVALID_MESSAGE");
    return path.join(dir, id + ".json");
  }

  readMessage(dir, project, id) {
    const file = this.filename(dir, id);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      stat.size > MAX_MESSAGE_BYTES ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      fail("COORDINATION_JOURNAL_CORRUPT");
    let row;
    try {
      row = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail("COORDINATION_JOURNAL_CORRUPT");
    }
    if (!safeRow(row, project, id)) fail("COORDINATION_JOURNAL_CORRUPT");
    return row;
  }

  rows(project) {
    const dir = this.directory(project);
    const filenames = fs.readdirSync(dir).sort();
    if (filenames.length > MAX_MESSAGES ||
        filenames.some((name) => !/^[a-f0-9]{64}\.json$/.test(name)))
      fail("COORDINATION_JOURNAL_CORRUPT");
    return filenames.map((name) =>
      this.readMessage(dir, project, name.slice(0, 64)),
    );
  }

  list(project, { limit = 25, after = null } = {}) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (after !== null && !DIGEST.test(after))
    )
      fail("COORDINATION_INVALID_QUERY");
    const all = this.rows(project).sort(
      (a, b) =>
        a.createdAtEpochMs - b.createdAtEpochMs ||
        a.id.localeCompare(b.id),
    );
    const start = after === null ? 0 : all.findIndex((row) => row.id === after) + 1;
    if (after !== null && start === 0) fail("COORDINATION_CURSOR_UNKNOWN");
    const page = all.slice(start, start + limit);
    return {
      project,
      messages: page.map(({ digest, ...row }) => row),
      nextCursor: start + limit < all.length ? page.at(-1).id : null,
      totalStored: all.length,
      automaticWorkerStarted: false,
      actorLabelsVerified: false,
      note: "Authorized clients share this project mailbox; actor names and reported gates are claims, not signed task completion or actual agent presence.",
    };
  }

  post(project, { actor, recipient = "all", requestKey, kind, note,
    replyTo = null, evidenceSha = null, reportedGate = "unknown" } = {}) {
    if (
      !KEY.test(actor ?? "") ||
      !KEY.test(recipient ?? "") ||
      !KEY.test(requestKey ?? "") ||
      !KINDS.has(kind) ||
      !GATES.has(reportedGate) ||
      (replyTo !== null && !DIGEST.test(replyTo)) ||
      (evidenceSha !== null && !SHA.test(evidenceSha))
    )
      fail("COORDINATION_INVALID_MESSAGE");
    safeNote(note);
    const dir = this.directory(project);
    // Actor + project + request key provides deterministic retry identity.
    const id = hash(JSON.stringify([project, actor, requestKey]));
    const file = this.filename(dir, id);
    if (replyTo !== null) {
      if (!fs.existsSync(this.filename(dir, replyTo)))
        fail("COORDINATION_REPLY_NOT_FOUND");
      this.readMessage(dir, project, replyTo);
    }
    const existing = fs.existsSync(file) ? this.readMessage(dir, project, id) : null;
    const body = { actor, recipient, requestKey, kind, note, replyTo,
      evidenceSha, reportedGate };
    if (existing !== null) {
      if (Object.entries(body).some(([key, value]) => existing[key] !== value))
        fail("COORDINATION_IDEMPOTENCY_CONFLICT");
      return { project, id, reused: true, stored: true };
    }
    // One immutable file per message: no read-modify-write race between
    // different agents/processes, even when they post simultaneously.
    if (fs.readdirSync(dir).length >= MAX_MESSAGES)
      fail("COORDINATION_CAPACITY_REACHED");
    const createdAtEpochMs = this.now();
    if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0)
      fail("COORDINATION_INVALID_CLOCK");
    const payload = { version: 1, project, id, createdAtEpochMs, ...body };
    const row = { ...payload, digest: hash(JSON.stringify(payload)) };
    const raw = JSON.stringify(row);
    if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES)
      fail("COORDINATION_MESSAGE_TOO_LARGE");
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, raw, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code === "EEXIST") {
        const raced = this.readMessage(dir, project, id);
        if (Object.entries(body).some(([key, value]) => raced[key] !== value))
          fail("COORDINATION_IDEMPOTENCY_CONFLICT");
        return { project, id, reused: true, stored: true };
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return { project, id, reused: false, stored: true };
  }
}
