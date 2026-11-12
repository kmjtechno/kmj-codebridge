#!/usr/bin/env node
// Convert the roadmap phases in docs/specs/KMJ-CodeBridge-Roadmap.yaml into
// one `mission_compile` payload, so every AI chat or worker continues from the
// persistent autopilot queue (autopilot_claim -> work -> autopilot_complete)
// instead of re-reading and re-planning the roadmap each session.
//
// Read-only: prints JSON to stdout. It does not call CodeBridge, GitHub,
// a model or any network service. Completed phases are skipped; tasks for
// in-progress phases tell the worker to verify existing evidence first.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROADMAP = path.join(ROOT, "docs/specs/KMJ-CodeBridge-Roadmap.yaml");
const PRIORITY = { P0: 60, P1: 30, P2: 10 };
const PHASE_KEYS = new Set([
  "id",
  "name",
  "priority",
  "depends_on",
  "status",
  "deliverables",
  "acceptance",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function scalar(raw) {
  const value = raw.trim();
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(value)) return JSON.parse(value);
  return value;
}

function inlineList(raw) {
  const value = raw.trim();
  if (!/^\[.*\]$/.test(value)) fail("ROADMAP_LIST_FORMAT");
  const inner = value.slice(1, -1).trim();
  return inner ? inner.split(",").map((item) => scalar(item)) : [];
}

// Bounded parser for the fixed `roadmap_phases:` layout only. Any line it
// does not understand fails closed instead of being silently skipped.
export function parseRoadmapPhases(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("roadmap_phases:");
  if (start < 0) fail("ROADMAP_PHASES_MISSING");
  const phases = [];
  let phase = null;
  let list = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    let match;
    if ((match = /^ {2}- id: (.+)$/.exec(line))) {
      phase = { id: scalar(match[1]) };
      phases.push(phase);
      list = null;
    } else if (phase && (match = /^ {4}([a-z_]+):(.*)$/.exec(line))) {
      const [, key, rest] = match;
      if (!PHASE_KEYS.has(key) || key in phase) fail("ROADMAP_PHASE_KEY");
      if (rest.trim() === "") {
        phase[key] = [];
        list = phase[key];
      } else {
        phase[key] = key === "depends_on" ? inlineList(rest) : scalar(rest);
        list = null;
      }
    } else if (list && (match = /^ {6}- (.+)$/.exec(line))) {
      list.push(scalar(match[1]));
    } else {
      fail("ROADMAP_LINE_UNRECOGNISED:" + (i + 1));
    }
  }
  if (phases.length < 1 || phases.length > 30) fail("ROADMAP_PHASE_COUNT");
  const ids = new Set(phases.map((p) => p.id));
  for (const p of phases) {
    if (!/^[A-Za-z0-9]{1,16}$/.test(p.id)) fail("ROADMAP_PHASE_ID");
    for (const key of PHASE_KEYS)
      if (!(key in p)) fail("ROADMAP_PHASE_FIELD_MISSING:" + p.id + "." + key);
    for (const dep of p.depends_on)
      if (!ids.has(dep)) fail("ROADMAP_UNKNOWN_DEPENDENCY:" + p.id);
  }
  return phases;
}

export function roadmapVersion(text) {
  const match = /^ {2}document_version: '?([0-9][0-9A-Za-z.-]{0,31})'?$/m.exec(
    text,
  );
  if (!match) fail("ROADMAP_VERSION_MISSING");
  return match[1];
}

export function buildMission(text, { project, device }) {
  const phases = parseRoadmapPhases(text);
  const version = roadmapVersion(text);
  const open = phases.filter((p) => p.status !== "completed");
  const openIds = new Set(open.map((p) => p.id));
  const tasks = [];
  const acceptanceCriteria = [];
  for (const phase of open) {
    const blockers = phase.depends_on
      .filter((dep) => openIds.has(dep))
      .map((dep) => `${dep}.accept`);
    const base = PRIORITY[phase.priority] ?? 0;
    const header =
      `[${phase.id}] ${phase.name} (roadmap ${version}, status ${phase.status}).\n` +
      "First verify what already exists on main and in merged PRs; do not redo " +
      "completed work. Deliver small reviewable PRs with exact-SHA CI evidence. " +
      "Never deploy, sign releases, change DNS or spend money: record those as " +
      "owner gates via autopilot_wait.";
    const deliverableKeys = [];
    phase.deliverables.forEach((deliverable, index) => {
      const key = `${phase.id}.d${index + 1}`;
      deliverableKeys.push(key);
      tasks.push({
        key,
        objective: `${header}\nDeliverable: ${deliverable}`,
        priority: Math.max(-100, Math.min(100, base - index)),
        dependsOn: blockers,
      });
    });
    tasks.push({
      key: `${phase.id}.accept`,
      objective:
        `${header}\nAcceptance review for ${phase.id}: collect evidence for each ` +
        `criterion and record it with mission_evidence.\n- ` +
        phase.acceptance.join("\n- "),
      priority: Math.max(-100, base - 10),
      dependsOn: deliverableKeys.length ? deliverableKeys : blockers,
    });
    acceptanceCriteria.push(
      `${phase.id} accepted: ${phase.acceptance.join("; ")}`.slice(0, 1024),
    );
  }
  if (tasks.length < 1) fail("ROADMAP_NOTHING_OPEN");
  if (tasks.length > 50) fail("ROADMAP_TOO_MANY_TASKS");
  if (acceptanceCriteria.length > 30) fail("ROADMAP_TOO_MANY_PHASES");
  return {
    device,
    project,
    key: `roadmap-v${version}`,
    objective:
      `Deliver the open phases of the KMJ CodeBridge roadmap ${version} ` +
      `(${open.map((p) => p.id).join(", ")}) through the persistent autopilot ` +
      "queue so any chat or worker continues the next dependency-ready task.",
    acceptanceCriteria,
    requirements: {
      security: [
        "No unrestricted shell, credential collection or permission widening.",
        "Every write is project-scoped, hash-preconditioned and reviewable.",
      ],
      reliability: [
        "Checkpoint progress with autopilot_checkpoint; leases recover stalled work.",
      ],
      performance: [],
      documentation: [
        "Update the roadmap status and evidence when a phase is accepted.",
      ],
    },
    tasks,
    ownerGates: [
      "Production deployment, release signing and publication stay owner-run.",
      "Roadmap approval does not authorize purchases, migrations or customer outreach.",
      "DNS, Cloudflare and server privilege changes require explicit owner action.",
    ],
    definitionOfDone:
      "Every open roadmap phase has its acceptance task succeeded with exact-SHA " +
      "CI or live evidence recorded, and all owner gates are approved by the owner.",
    aiBudget: "balanced",
  };
}

function main(argv) {
  const args = { project: "kmj-codebridge", device: "p520" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--project" || flag === "--device") {
      const value = argv[++i];
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value ?? "")) fail("INVALID_ARGUMENT");
      args[flag.slice(2)] = value;
    } else fail("UNKNOWN_ARGUMENT");
  }
  const mission = buildMission(readFileSync(ROADMAP, "utf8"), args);
  process.stdout.write(JSON.stringify(mission, null, 2) + "\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      "ROADMAP_MISSION=BLOCKED " + (error.code ?? "ERROR") + "\n",
    );
    process.exitCode = 1;
  }
}
