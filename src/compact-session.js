import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

// This stores only caller-authored compact facts, never ChatGPT's transcript.
// A checksum detects corruption, NOT whether a caller's claims are correct.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 16384;
const MAX_LANES = 32;
const FIELDS = Object.freeze({
  decisions: [10, 200],
  constraints: [12, 200],
  evidence: [10, 180],
  blockers: [8, 160],
  nextSteps: [6, 180],
});
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");

function cleanText(value, limit) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > limit ||
    value.trim() !== value ||
    // Never persist transcripts, secrets, customer email addresses or URLs.
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(value) ||
    /https?:\/\/|-----BEGIN |(?:sk|ghp|gho|ghu|ghs|ghr)-?[A-Za-z0-9_-]{18,}|(?:password|secret|token|api[_-]?key)\s*[=:]|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i.test(
      value,
    ) ||
    redact(value) !== value
  ) {
    fail("COMPACT_SESSION_UNSAFE_TEXT");
  }
  return value;
}

export function validateCompactDraft(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft))
    fail("COMPACT_SESSION_INVALID_DRAFT");
  const result = {
    objective: cleanText(draft.objective, 240),
    summary: cleanText(draft.summary, 1800),
  };
  for (const [key, [maxCount, maxLength]] of Object.entries(FIELDS)) {
    const list = draft[key];
    if (
      !Array.isArray(list) ||
      list.length > maxCount ||
      (key === "nextSteps" && list.length < 1)
    ) {
      fail("COMPACT_SESSION_INVALID_DRAFT");
    }
    result[key] = list.map((value) => cleanText(value, maxLength));
  }
  return result;
}

function safeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    fail("COMPACT_SESSION_UNSAFE_DIRECTORY");
}

export function compactSessionHandoff(packet) {
  const lines = [
    "# KMJ Compact Session v1",
    "Project: " + packet.project + " | Lane: " + packet.lane,
    "Checkpoint revision: " + packet.revision,
    "Evidence status: CLIENT_REPORTED_UNVERIFIED (recheck exact HEAD and CI)",
    "Objective: " + packet.objective,
    "Summary: " + packet.summary,
  ];
  for (const [label, key] of [
    ["Locked decisions", "decisions"],
    ["Must-preserve constraints", "constraints"],
    ["Reported evidence (reverify)", "evidence"],
    ["Known blockers", "blockers"],
    ["Next actions", "nextSteps"],
  ]) {
    lines.push(label + ":");
    if (!packet[key].length) lines.push("- None recorded");
    for (const item of packet[key]) lines.push("- " + item);
  }
  lines.push(
    "Refresh live state with CodeBridge context_resume before new work.",
  );
  return lines.join("\n");
}

export class CompactSessionStore {
  constructor(stateDir) {
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir))
      fail("COMPACT_SESSION_STATE_UNAVAILABLE");
    this.directory = path.join(stateDir, "compact-sessions");
    safeDir(this.directory);
  }

  file(project, lane) {
    if (!PROJECT.test(project ?? "") || !ID.test(lane ?? ""))
      fail("COMPACT_SESSION_INVALID_SCOPE");
    return path.join(this.directory, hash([project, lane]) + ".json");
  }

  read(project, lane) {
    const file = this.file(project, lane);
    if (!fs.existsSync(file)) return null;
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 2 ||
        stat.size > MAX_FILE_BYTES ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        fail("COMPACT_SESSION_CORRUPT");
      const packet = JSON.parse(fs.readFileSync(file, "utf8"));
      const { revision, ...body } = packet;
      if (
        packet.version !== 1 ||
        packet.project !== project ||
        packet.lane !== lane ||
        !ID.test(packet.requestKey ?? "") ||
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence < 1 ||
        !Number.isFinite(Date.parse(packet.updatedAt)) ||
        !HASH.test(revision ?? "") ||
        hash(body) !== revision
      )
        fail("COMPACT_SESSION_CORRUPT");
      validateCompactDraft(packet);
      return packet;
    } catch {
      fail("COMPACT_SESSION_CORRUPT");
    }
  }

  resume(project, lane, ifNoneMatch) {
    const current = this.read(project, lane);
    if (!current)
      return {
        version: 1,
        project,
        lane,
        exists: false,
        revision: null,
        source: "DEVICE_LOCAL_CHECKPOINT",
      };
    if (ifNoneMatch === current.revision)
      return {
        version: 1,
        project,
        lane,
        unchanged: true,
        revision: current.revision,
      };
    const handoff = compactSessionHandoff(current);
    return {
      ...current,
      exists: true,
      source: "DEVICE_LOCAL_CHECKPOINT",
      contentTrusted: false,
      hostContextWindowExtended: false,
      chatAutoWake: false,
      approxHandoffTokens: Math.ceil(Buffer.byteLength(handoff) / 4),
      handoff,
    };
  }

  save(project, lane, { requestKey, expectedRevision, ...draft }) {
    this.file(project, lane);
    if (!ID.test(requestKey ?? "")) fail("COMPACT_SESSION_INVALID_UPDATE");
    const safe = validateCompactDraft(draft);
    const current = this.read(project, lane);
    if (current?.requestKey === requestKey) {
      if (
        JSON.stringify(safe) !== JSON.stringify(validateCompactDraft(current))
      )
        fail("COMPACT_SESSION_IDEMPOTENCY_CONFLICT");
      return { project, lane, revision: current.revision, reused: true };
    }
    if (
      expectedRevision !== (current?.revision ?? null) ||
      (expectedRevision !== null && !HASH.test(expectedRevision ?? ""))
    )
      fail("COMPACT_SESSION_VERSION_CONFLICT");
    const filenames = fs.readdirSync(this.directory);
    if (
      filenames.some(
        (name) => !name.endsWith(".json") || !HASH.test(name.slice(0, -5)),
      )
    )
      fail("COMPACT_SESSION_UNSAFE_DIRECTORY");
    if (!current && filenames.length >= MAX_LANES)
      fail("COMPACT_SESSION_CAPACITY_REACHED");
    const body = {
      version: 1,
      project,
      lane,
      sequence: (current?.sequence ?? 0) + 1,
      requestKey,
      ...safe,
      updatedAt: new Date().toISOString(),
    };
    const packet = { ...body, revision: hash(body) };
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
      fail("COMPACT_SESSION_TOO_LARGE");
    const temp = path.join(this.directory, randomUUID() + ".tmp");
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, encoded);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // Agent process lock serializes saves; CAS guards multi-chat conflicts.
      fs.renameSync(temp, this.file(project, lane));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return { project, lane, revision: packet.revision, reused: false };
  }
}
