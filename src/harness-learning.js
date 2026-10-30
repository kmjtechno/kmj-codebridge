import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

// Harness2-inspired, CodeBridge-native learning from *reported* A/B evidence.
// Nothing here executes a model, test, patch, tool or production action.
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_LESSONS = 16;
const MAX_BYTES = 16384;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function safeNote(value) {
  if (
    typeof value !== "string" ||
    value.length < 5 ||
    value.length > 180 ||
    value.trim() !== value ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /https?:\/\/|-----BEGIN |(?:sk|ghp|gho|ghu|ghs|ghr)-?[A-Za-z0-9_-]{18,}|(?:password|secret|token|api[_-]?key)\s*[=:]|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i.test(value) ||
    /\b(?:ignore (?:all |previous )?instructions|bypass (?:approval|sandbox|security)|disable (?:security|auth)|execute|run (?:this|the following) command)\b/i.test(value) ||
    redact(value) !== value
  )
    fail("HARNESS_LEARNING_UNSAFE_NOTE");
  return value;
}

function metric(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !KEY.test(value.label ?? "") ||
    typeof value.passed !== "boolean" ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 1 ||
    value.elapsedMs > 3600000 ||
    value.costUsd !== 0
  )
    fail("HARNESS_LEARNING_INVALID_METRIC");
  return {
    label: value.label,
    passed: value.passed,
    score: value.score,
    elapsedMs: value.elapsedMs,
    costUsd: 0,
  };
}

export function reviewHarnessEvidence(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !KEY.test(input.taskKey ?? "") ||
    !KEY.test(input.gate ?? "") ||
    !SHA.test(input.sourceHead ?? "") ||
    !DIGEST.test(input.taskDigest ?? "") ||
    !DIGEST.test(input.policyDigest ?? "")
  )
    fail("HARNESS_LEARNING_INVALID_SCOPE");

  const baseline = metric(input.baseline);
  const candidate = metric(input.candidate);
  if (baseline.label === candidate.label)
    fail("HARNESS_LEARNING_DUPLICATE_CANDIDATE");

  const improved = candidate.passed && candidate.score > baseline.score;
  const timeGuard = candidate.elapsedMs <= baseline.elapsedMs * 2;
  const reason = !candidate.passed
    ? "CANDIDATE_GATE_REPORTED_FAILED"
    : !improved
      ? "NO_MEASURED_IMPROVEMENT"
      : !timeGuard
        ? "EXCESSIVE_RUNTIME_REGRESSION"
        : "REVIEW_WORTHWHILE";

  const evidence = {
    taskKey: input.taskKey,
    gate: input.gate,
    sourceHead: input.sourceHead,
    taskDigest: input.taskDigest,
    policyDigest: input.policyDigest,
    baseline,
    candidate,
  };
  return {
    version: 1,
    kind: "codebridge.harness_learning_review",
    evidenceSha256: hash(evidence),
    sourceHead: input.sourceHead,
    taskKey: input.taskKey,
    gate: input.gate,
    scoreDelta: candidate.score - baseline.score,
    elapsedDeltaMs: candidate.elapsedMs - baseline.elapsedMs,
    reportedBaselinePassed: baseline.passed,
    reportedCandidatePassed: candidate.passed,
    recommendation: reason,
    verification: "CALLER_REPORTED_NOT_INDEPENDENTLY_ATTESTED",
    autoAdopted: false,
    codeExecuted: false,
    inferenceCalled: false,
    networkCalled: false,
    productionChanged: false,
  };
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    fail("HARNESS_LEARNING_UNSAFE_DIRECTORY");
}

export class HarnessLearningStore {
  constructor(stateDir) {
    if (typeof stateDir !== "string" || !path.isAbsolute(stateDir))
      fail("HARNESS_LEARNING_STATE_UNAVAILABLE");
    this.directory = path.join(stateDir, "harness-learning");
    privateDirectory(this.directory);
  }

  filename(project) {
    if (!PROJECT.test(project ?? "")) fail("HARNESS_LEARNING_INVALID_PROJECT");
    return path.join(this.directory, hash(project) + ".json");
  }

  read(project) {
    const file = this.filename(project);
    if (!fs.existsSync(file)) return null;
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size < 2 ||
        stat.size > MAX_BYTES ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      )
        fail("HARNESS_LEARNING_CORRUPT");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      const { revision, ...body } = state;
      if (
        state.version !== 1 ||
        state.project !== project ||
        !Number.isSafeInteger(state.sequence) ||
        state.sequence < 1 ||
        !KEY.test(state.requestKey ?? "") ||
        !Array.isArray(state.lessons) ||
        state.lessons.length > MAX_LESSONS ||
        !Number.isFinite(Date.parse(state.updatedAt)) ||
        !DIGEST.test(revision ?? "") ||
        revision !== hash(body)
      )
        fail("HARNESS_LEARNING_CORRUPT");
      const keys = new Set();
      for (const row of state.lessons) {
        if (
          !KEY.test(row.taskKey ?? "") ||
          keys.has(row.taskKey) ||
          !DIGEST.test(row.evidenceSha256 ?? "") ||
          !SHA.test(row.sourceHead ?? "") ||
          !KEY.test(row.gate ?? "") ||
          !["pending_review", "revoked"].includes(row.status) ||
          !Number.isFinite(Date.parse(row.recordedAt))
        )
          fail("HARNESS_LEARNING_CORRUPT");
        safeNote(row.lesson);
        keys.add(row.taskKey);
      }
      return state;
    } catch {
      fail("HARNESS_LEARNING_CORRUPT");
    }
  }

  list(project, { includeRevoked = false } = {}) {
    const state = this.read(project);
    const lessons = (state?.lessons ?? [])
      .filter((row) => includeRevoked || row.status !== "revoked")
      .map((row) => ({ ...row, trusted: false, autoExecutable: false }));
    return {
      version: 1,
      project,
      revision: state?.revision ?? null,
      lessons,
      status: "CALLER_REPORTED_UNVERIFIED",
      noAutomaticExecution: true,
      noPromptAuthority: true,
      noPaidInference: true,
    };
  }

  write(project, current, requestKey, lessons) {
    const body = {
      version: 1,
      project,
      sequence: (current?.sequence ?? 0) + 1,
      requestKey,
      lessons,
      updatedAt: new Date().toISOString(),
    };
    const packet = { ...body, revision: hash(body) };
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) > MAX_BYTES)
      fail("HARNESS_LEARNING_CAPACITY_REACHED");
    const tmp = path.join(this.directory, randomUUID() + ".tmp");
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, encoded);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // One enrolled device-agent owns this directory. CAS rejects stale chats.
      fs.renameSync(tmp, this.filename(project));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    return { project, revision: packet.revision, saved: true };
  }

  record(project, { requestKey, expectedRevision, lesson, ...input }) {
    this.filename(project);
    if (!KEY.test(requestKey ?? "")) fail("HARNESS_LEARNING_INVALID_REQUEST");
    const safe = safeNote(lesson);
    const evidence = reviewHarnessEvidence(input);
    if (evidence.recommendation !== "REVIEW_WORTHWHILE")
      fail("HARNESS_LEARNING_NO_IMPROVEMENT");
    const current = this.read(project);
    const existing = current?.lessons.find((x) => x.taskKey === evidence.taskKey);
    if (current?.requestKey === requestKey) {
      if (
        existing?.lesson !== safe ||
        existing?.evidenceSha256 !== evidence.evidenceSha256
      )
        fail("HARNESS_LEARNING_IDEMPOTENCY_CONFLICT");
      return { project, revision: current.revision, saved: true, reused: true };
    }
    if (
      expectedRevision !== (current?.revision ?? null) ||
      (expectedRevision !== null && !DIGEST.test(expectedRevision ?? ""))
    )
      fail("HARNESS_LEARNING_REVISION_CONFLICT");
    if (existing) fail("HARNESS_LEARNING_TASK_EXISTS");
    const lessons = [
      ...(current?.lessons ?? []),
      {
        taskKey: evidence.taskKey,
        lesson: safe,
        evidenceSha256: evidence.evidenceSha256,
        sourceHead: evidence.sourceHead,
        gate: evidence.gate,
        status: "pending_review",
        recordedAt: new Date().toISOString(),
      },
    ];
    if (lessons.length > MAX_LESSONS)
      fail("HARNESS_LEARNING_CAPACITY_REACHED");
    return {
      ...this.write(project, current, requestKey, lessons),
      status: "PENDING_INDEPENDENT_VERIFICATION",
      trusted: false,
      autoAdopted: false,
    };
  }

  revoke(project, { requestKey, expectedRevision, taskKey }) {
    this.filename(project);
    if (!KEY.test(requestKey ?? "") || !KEY.test(taskKey ?? ""))
      fail("HARNESS_LEARNING_INVALID_REQUEST");
    const current = this.read(project);
    if (current?.requestKey === requestKey) {
      if (!current.lessons.some((x) => x.taskKey === taskKey && x.status === "revoked"))
        fail("HARNESS_LEARNING_IDEMPOTENCY_CONFLICT");
      return { project, revision: current.revision, revoked: true, reused: true };
    }
    if (
      expectedRevision !== (current?.revision ?? null) ||
      (expectedRevision !== null && !DIGEST.test(expectedRevision ?? ""))
    )
      fail("HARNESS_LEARNING_REVISION_CONFLICT");
    if (!current?.lessons.some((x) => x.taskKey === taskKey && x.status === "pending_review"))
      fail("HARNESS_LEARNING_TASK_NOT_FOUND");
    const lessons = current.lessons.map((x) =>
      x.taskKey === taskKey ? { ...x, status: "revoked" } : x,
    );
    return {
      ...this.write(project, current, requestKey, lessons),
      revoked: true,
    };
  }
}
