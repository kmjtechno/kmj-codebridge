// Compact, versioned "resume" packet for continuing an engineering session
// without replaying history. Pure function over already-fetched tool results;
// anything that could not be read is reported as UNKNOWN, never guessed.
// Mailbox notes and PASS/FAIL values are caller-reported claims, not facts.
import { createHash } from "node:crypto";
const STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
];
const MAX_CHARS = 6000;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA = /^[a-f0-9]{7,64}$/;

const ok = (part) =>
  part?.ok === true && part.value && typeof part.value === "object";
const text = (value, max) =>
  typeof value === "string"
    ? // eslint-disable-next-line no-control-regex
      value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, max)
    : null;
const id = (value) =>
  typeof value === "string" && ID.test(value) ? value : null;
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function buildContextResume({
  device,
  project,
  git,
  autopilot,
  lanes,
  mailbox,
  capacity,
  now = new Date(),
}) {
  const unknown = [];
  const packet = {
    version: 1,
    kind: "codebridge.context_resume",
    generatedAt: now.toISOString(),
    device: id(device),
    project: id(project),
    git: "UNKNOWN",
    tasks: "UNKNOWN",
    locks: "UNKNOWN",
    mailbox: "UNKNOWN",
    availableAuthorizedSlots: "UNKNOWN",
    evidence: {
      git: ok(git),
      tasks: ok(autopilot),
      locks: ok(lanes),
      mailbox: ok(mailbox),
      capacity: ok(capacity),
    },
    unverified: [
      "mailbox actor names and reported gates are caller claims",
      "no completion percentage or release readiness is evaluated",
    ],
    unknown,
    approxTokens: 0,
  };

  if (ok(git) && typeof git.value.status === "string") {
    const first = git.value.status.split("\n", 1)[0] ?? "";
    const branch = /^## ([A-Za-z0-9._/-]{1,120})/.exec(first);
    packet.git = {
      branch: branch ? branch[1] : null,
      dirty: /\n\s*(?:M|A|D|R|\?\?|U)/m.test(git.value.status),
    };
  }
  if (ok(autopilot)) {
    const rows = Array.isArray(autopilot.value.tasks)
      ? autopilot.value.tasks
      : [];
    const open = rows
      .filter((t) => t?.state === "queued" || t?.state === "running")
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, 5)
      .map((t) => ({
        id: id(t.id),
        key: text(t.key, 96),
        state: t.state,
        priority: Number.isSafeInteger(t.priority) ? t.priority : null,
      }));
    packet.tasks = {
      counts: Object.fromEntries(
        STATES.map((s) => [s, count(autopilot.value.counts?.[s])]),
      ),
      nextReadyTaskId: id(autopilot.value.next?.id),
      topOpen: open,
    };
  }
  if (ok(lanes)) {
    const rows = Array.isArray(lanes.value.lanes) ? lanes.value.lanes : [];
    packet.locks = {
      activeCount: count(lanes.value.activeCount),
      lanes: rows.slice(0, 5).map((l) => ({
        requestKey: id(l.requestKey),
        paths: (Array.isArray(l.paths) ? l.paths : [])
          .slice(0, 5)
          .map((p) => text(p, 160)),
        expiresAt: text(l.expiresAt, 40),
      })),
    };
  }
  if (ok(mailbox)) {
    const rows = Array.isArray(mailbox.value.messages)
      ? mailbox.value.messages
      : [];
    packet.mailbox = {
      totalStored: count(mailbox.value.totalStored),
      recent: rows.slice(-5).map((m) => ({
        id: id(m.id),
        actor: id(m.actor),
        recipient: id(m.recipient),
        kind: text(m.kind, 32),
        evidenceSha:
          typeof m.evidenceSha === "string" && SHA.test(m.evidenceSha)
            ? m.evidenceSha
            : null,
        reportedGate: text(m.reportedGate, 16),
        note: text(m.note, 160),
      })),
      actorLabelsVerified: false,
    };
  }
  if (
    ok(capacity) &&
    Number.isSafeInteger(capacity.value.effectiveMaxConcurrent) &&
    Number.isSafeInteger(capacity.value.activeJobs)
  ) {
    packet.availableAuthorizedSlots = capacity.value.blocked
      ? 0
      : Math.max(
          0,
          Math.min(16, capacity.value.effectiveMaxConcurrent) -
            capacity.value.activeJobs,
        );
  }
  for (const key of [
    "git",
    "tasks",
    "locks",
    "mailbox",
    "availableAuthorizedSlots",
  ])
    if (packet[key] === "UNKNOWN") unknown.push(key);

  // Hard size bound: drop the oldest mailbox notes first, never safety fields.
  const size = () => JSON.stringify(packet).length;
  while (
    packet.mailbox !== "UNKNOWN" &&
    packet.mailbox.recent.length > 0 &&
    size() > MAX_CHARS
  )
    packet.mailbox.recent.shift();
  packet.approxTokens = Math.ceil(size() / 4);
  packet.digest = contextDigest(packet);
  return packet;
}

// Stable content digest ignoring volatile fields, so a client that already
// holds this state can send it back (ifNoneMatch) and receive a tiny
// "unchanged" answer instead of the full packet.
export function contextDigest(packet) {
  const { generatedAt, approxTokens, digest, ...stable } = packet;
  void generatedAt;
  void approxTokens;
  void digest;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function unchangedResume(packet) {
  return {
    version: packet.version,
    kind: packet.kind,
    device: packet.device,
    project: packet.project,
    unchanged: true,
    digest: packet.digest,
  };
}
