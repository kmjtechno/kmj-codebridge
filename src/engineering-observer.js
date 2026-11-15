import { createHash } from "node:crypto";
import { SKILL_PACKS } from "./skill-packs.js";

// Vendor-neutral, read-only learning proposals inspired by the observation
// methodology in rebelytics/one-skill-to-rule-them-all (CC BY 4.0).
// No upstream code is copied. Never ingest raw logs, prompts or credentials.
const SKILLS = new Set(SKILL_PACKS.map((pack) => pack.id));
const KINDS = new Set([
  "ci_failure",
  "user_correction",
  "repeated_work",
  "skill_gap",
]);
const EVIDENCE = new Set(["REPRODUCED", "USER_CONFIRMED", "UNVERIFIED"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/;
const CAUSE = /^[A-Z][A-Z0-9_]{3,47}$/;
const MAX_OBSERVATIONS = 32;

function invalid(code) {
  throw new Error("ENGINEERING_OBSERVER_" + code);
}

function digest(parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

function validateEvent(event, project) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    Object.keys(event).length !== 7 ||
    ![
      "eventId",
      "project",
      "sessionId",
      "skill",
      "kind",
      "causeCode",
      "evidence",
    ].every((key) => Object.hasOwn(event, key)) ||
    event.project !== project ||
    typeof event.eventId !== "string" ||
    !ID.test(event.eventId) ||
    typeof event.sessionId !== "string" ||
    !ID.test(event.sessionId) ||
    typeof event.skill !== "string" ||
    !SKILLS.has(event.skill) ||
    typeof event.kind !== "string" ||
    !KINDS.has(event.kind) ||
    typeof event.causeCode !== "string" ||
    !CAUSE.test(event.causeCode) ||
    typeof event.evidence !== "string" ||
    !EVIDENCE.has(event.evidence)
  )
    invalid("INVALID_EVENT_OR_SCOPE");
  return {
    eventId: event.eventId,
    project: event.project,
    sessionId: event.sessionId,
    skill: event.skill,
    kind: event.kind,
    causeCode: event.causeCode,
    evidence: event.evidence,
  };
}

/**
 * Evaluate only bounded, caller-supplied, structured observations.
 * Caller evidence is NOT verified by this function: a proposal never proves
 * that a failure occurred or that a suggested repair will work.
 *
 * No reads/writes, inference, network calls, installed skill changes,
 * GitHub mutations or project cross-talk occur here.
 */
export function evaluateEngineeringObservations({
  project,
  observations = [],
} = {}) {
  if (
    typeof project !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(project) ||
    !Array.isArray(observations) ||
    observations.length > MAX_OBSERVATIONS
  )
    invalid("INVALID_REQUEST");

  const byId = new Map();
  let replayed = 0;
  for (const raw of observations) {
    const event = validateEvent(raw, project);
    const existing = byId.get(event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event))
        invalid("CONFLICTING_REPLAY");
      replayed += 1;
    } else {
      byId.set(event.eventId, event);
    }
  }

  // Different sessions, not duplicate events in one chat, establish
  // recurrence. One session can never promote an unverified guess to a gate.
  const groups = new Map();
  for (const event of byId.values()) {
    const key = JSON.stringify([event.skill, event.causeCode]);
    if (!groups.has(key))
      groups.set(key, {
        skill: event.skill,
        causeCode: event.causeCode,
        count: 0,
        sessions: new Set(),
        verifiedSessions: new Set(),
        kinds: new Set(),
      });
    const group = groups.get(key);
    group.count += 1;
    group.sessions.add(event.sessionId);
    group.kinds.add(event.kind);
    if (event.evidence !== "UNVERIFIED")
      group.verifiedSessions.add(event.sessionId);
  }

  const proposals = [...groups.values()]
    .sort(
      (a, b) =>
        a.skill.localeCompare(b.skill) ||
        a.causeCode.localeCompare(b.causeCode),
    )
    .map((group) => {
      const repeatable = group.verifiedSessions.size >= 2;
      return {
        proposalId: digest([project, group.skill, group.causeCode]),
        skill: group.skill,
        causeCode: group.causeCode,
        eventCount: group.count,
        distinctSessions: group.sessions.size,
        sessionsWithAssertedEvidence: group.verifiedSessions.size,
        eventKinds: [...group.kinds].sort(),
        stage: repeatable ? "STRUCTURAL_GUARD_REVIEW" : "EVIDENCE_COLLECTION",
        action: repeatable
          ? "Propose a bounded, fail-closed guard with regression tests; review on an isolated branch."
          : "Gather verified examples across independent sessions before proposing a rule.",
        status: "PROPOSED_NOT_INSTALLED",
        externalEvidenceVerified: false,
        requiredGates: [
          "project-scoped owner review",
          "regression tests",
          "exact-head required CI",
          "staged candidate diff",
          "rollback plan",
        ],
      };
    });

  // Propose new skills only from explicit skill-gap signals. A known skill
  // acts as the observation context, not as proof that a new pack is needed.
  // Candidates contain no generated instructions, filenames or log content.
  const newSkillCandidates = proposals
    .filter((proposal) => proposal.eventKinds.includes("skill_gap"))
    .map((proposal) => ({
      candidateId: digest([
        project,
        "new-skill",
        proposal.skill,
        proposal.causeCode,
      ]),
      observedInSkill: proposal.skill,
      causeCode: proposal.causeCode,
      distinctSessions: proposal.distinctSessions,
      sessionsWithAssertedEvidence: proposal.sessionsWithAssertedEvidence,
      stage:
        proposal.stage === "STRUCTURAL_GUARD_REVIEW"
          ? "NEW_SKILL_DESIGN_REVIEW"
          : "EVIDENCE_COLLECTION",
      status: "PROPOSED_NOT_INSTALLED",
      externalEvidenceVerified: false,
      requiredGates: [
        "verify real workflow gap against existing skill catalog",
        "project-scoped owner review",
        "isolated staged skill candidate",
        "negative regression tests and exact-head required CI",
        "rollback plan",
      ],
    }));

  // Detect possible cross-cutting rules without treating a matching cause
  // code as proof of one systemic defect. Only independently asserted
  // observations in two distinct sessions AND skills reach review stage.
  const crossSkillGroups = new Map();
  for (const event of byId.values()) {
    if (!crossSkillGroups.has(event.causeCode))
      crossSkillGroups.set(event.causeCode, {
        skills: new Set(),
        sessions: new Set(),
        assertedSkills: new Set(),
        assertedSessions: new Set(),
      });
    const group = crossSkillGroups.get(event.causeCode);
    group.skills.add(event.skill);
    group.sessions.add(event.sessionId);
    if (event.evidence !== "UNVERIFIED") {
      group.assertedSkills.add(event.skill);
      group.assertedSessions.add(event.sessionId);
    }
  }
  const crossCuttingCandidates = [...crossSkillGroups.entries()]
    .filter(([, group]) => group.skills.size >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([causeCode, group]) => ({
      candidateId: digest([project, "cross-cutting", causeCode]),
      causeCode,
      affectedSkills: [...group.skills].sort(),
      distinctSessions: group.sessions.size,
      sessionsWithAssertedEvidence: group.assertedSessions.size,
      stage:
        group.assertedSkills.size >= 2 && group.assertedSessions.size >= 2
          ? "CROSS_SKILL_REVIEW"
          : "EVIDENCE_COLLECTION",
      status: "PROPOSED_NOT_INSTALLED",
      externalEvidenceVerified: false,
      requiredGates: [
        "independently verify cause and skill scope",
        "review cross-skill exceptions and confidentiality",
        "project-scoped owner review",
        "isolated negative regression tests and exact-head required CI",
        "rollback plan",
      ],
    }));

  return {
    version: 1,
    kind: "kmj.engineering_observer_review",
    project,
    ingested: byId.size,
    idempotentReplays: replayed,
    proposalCount: proposals.length,
    proposals,
    newSkillCandidates,
    crossCuttingCandidates,
    source: "CALLER_SUPPLIED_STRUCTURED_SIGNALS",
    externalEvidenceVerified: false,
    durableStateSaved: false,
    liveSkillsChanged: false,
    automaticExecution: false,
    paidModelCalls: false,
    additionalInfrastructureRequired: false,
  };
}
