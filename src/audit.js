import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";

const ZERO_HASH = "0".repeat(64);
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const ACCESS = new Set(["read", "write", "execute"]);
const RISK = new Set([
  "READ",
  "TEST",
  "EDIT",
  "GIT_WRITE",
  "SERVICE",
  "DEPLOY",
  "PRIVILEGED",
  "DESTRUCTIVE",
]);
const PHASE = new Set(["attempt", "result"]);
const OUTCOME = new Set(["pending", "succeeded", "failed"]);
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_TAIL = 100;

function digest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validEntry(entry, project, expectedSequence, previousHash) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const { hash, ...payload } = entry;
  return (
    payload.schema === 1 &&
    payload.sequence === expectedSequence &&
    typeof payload.id === "string" &&
    payload.id.length >= 8 &&
    payload.id.length <= 128 &&
    typeof payload.timestamp === "string" &&
    payload.timestamp.length >= 20 &&
    payload.timestamp.length <= 40 &&
    typeof payload.device === "string" &&
    payload.device.length >= 1 &&
    payload.device.length <= 64 &&
    payload.project === project &&
    typeof payload.tool === "string" &&
    TOOL_ID.test(payload.tool) &&
    ACCESS.has(payload.access) &&
    RISK.has(payload.risk) &&
    PHASE.has(payload.phase) &&
    OUTCOME.has(payload.outcome) &&
    (payload.correlationId === null ||
      (typeof payload.correlationId === "string" &&
        payload.correlationId.length >= 8 &&
        payload.correlationId.length <= 128)) &&
    (payload.error === null ||
      (typeof payload.error === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(payload.error))) &&
    payload.previousHash === previousHash &&
    typeof hash === "string" &&
    /^[a-f0-9]{64}$/.test(hash) &&
    digest(payload) === hash
  );
}

export class AuditLedger {
  constructor(
    dir,
    {
      now = () => new Date().toISOString(),
      id = () => randomUUID(),
    } = {},
  ) {
    this.dir = dir;
    this.now = now;
    this.id = id;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  file(project) {
    if (typeof project !== "string" || !PROJECT_ID.test(project))
      fail("INVALID_AUDIT_PROJECT");
    return path.join(this.dir, `${project}.jsonl`);
  }

  load(project) {
    const file = this.file(project);
    if (!fs.existsSync(file))
      return {
        file,
        count: 0,
        headHash: ZERO_HASH,
        tail: [],
      };

    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > MAX_LEDGER_BYTES)
      fail("AUDIT_LEDGER_INVALID");

    const raw = fs.readFileSync(file, "utf8");
    const lines = raw === "" ? [] : raw.split("\n").filter(Boolean);
    let previousHash = ZERO_HASH;
    let sequence = 0;
    const tail = [];

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        fail("AUDIT_LEDGER_INVALID");
      }
      sequence += 1;
      if (!validEntry(entry, project, sequence, previousHash))
        fail("AUDIT_LEDGER_INVALID");
      previousHash = entry.hash;
      tail.push(entry);
      if (tail.length > MAX_TAIL) tail.shift();
    }

    return {
      file,
      count: sequence,
      headHash: previousHash,
      tail,
    };
  }

  append(project, event) {
    const state = this.load(project);
    const error =
      event.error === null || event.error === undefined
        ? null
        : typeof event.error === "string" &&
            /^[A-Z0-9_]{1,64}$/.test(event.error)
          ? event.error
          : "INTERNAL_ERROR";
    const payload = {
      schema: 1,
      sequence: state.count + 1,
      id: this.id(),
      timestamp: this.now(),
      device: event.device,
      project,
      tool: event.tool,
      access: event.access,
      risk: event.risk,
      phase: event.phase,
      outcome: event.outcome,
      correlationId: event.correlationId ?? null,
      error,
      previousHash: state.headHash,
    };
    const entry = { ...payload, hash: digest(payload) };
    if (!validEntry(entry, project, payload.sequence, state.headHash))
      fail("INVALID_AUDIT_EVENT");

    let fd;
    try {
      fd = fs.openSync(state.file, "a", 0o600);
      fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
      fs.fsyncSync(fd);
    } catch {
      fail("AUDIT_WRITE_FAILED");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return entry;
  }

  status(project) {
    const state = this.load(project);
    return {
      project,
      valid: true,
      events: state.count,
      headHash: state.headHash,
      lastSequence: state.count,
    };
  }

  tail(project, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_AUDIT_LIMIT");
    const state = this.load(project);
    return {
      project,
      valid: true,
      events: state.count,
      headHash: state.headHash,
      entries: state.tail.slice(-limit),
    };
  }
}
