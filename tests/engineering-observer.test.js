import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEngineeringObservations } from "../src/engineering-observer.js";

const project = "kmj-codebridge";
const make = (overrides = {}) => ({
  eventId: "evt-00000001",
  project,
  sessionId: "chat-00000001",
  skill: "debugging",
  kind: "ci_failure",
  causeCode: "GITHUB_ACTIONS_PRESTART",
  evidence: "REPRODUCED",
  ...overrides,
});

test("empty review is deterministic, read-only and zero-cost", () => {
  const actual = evaluateEngineeringObservations({ project });
  assert.deepEqual(actual.proposals, []);
  assert.equal(actual.durableStateSaved, false);
  assert.equal(actual.liveSkillsChanged, false);
  assert.equal(actual.automaticExecution, false);
  assert.equal(actual.paidModelCalls, false);
  assert.equal(actual.externalEvidenceVerified, false);
});

test("single session never auto-promotes error to a new skill gate", () => {
  const result = evaluateEngineeringObservations({
    project,
    observations: [make()],
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].stage, "EVIDENCE_COLLECTION");
  assert.equal(result.proposals[0].status, "PROPOSED_NOT_INSTALLED");
});

test("two independent observed sessions suggest structural guard review only", () => {
  const observations = [
    make(),
    make({
      eventId: "evt-00000002",
      sessionId: "chat-00000002",
      kind: "user_correction",
      evidence: "USER_CONFIRMED",
    }),
  ];
  const result = evaluateEngineeringObservations({ project, observations });
  assert.equal(result.proposals[0].stage, "STRUCTURAL_GUARD_REVIEW");
  assert.equal(result.proposals[0].distinctSessions, 2);
  assert.equal(result.proposals[0].sessionsWithAssertedEvidence, 2);
  assert.equal(result.proposals[0].externalEvidenceVerified, false);
  assert.ok(
    result.proposals[0].requiredGates.includes("exact-head required CI"),
  );
  const reversed = evaluateEngineeringObservations({
    project,
    observations: [...observations].reverse(),
  });
  assert.deepEqual(result, reversed);
});

test("same-session duplicates never masquerade as independent reproduction", () => {
  const actual = evaluateEngineeringObservations({
    project,
    observations: [
      make(),
      make({ eventId: "evt-00000002", kind: "skill_gap" }),
      make(),
    ],
  });
  assert.equal(actual.ingested, 2);
  assert.equal(actual.idempotentReplays, 1);
  assert.equal(actual.proposals[0].distinctSessions, 1);
  assert.equal(actual.proposals[0].stage, "EVIDENCE_COLLECTION");
});

test("idempotency-key reuse with changed evidence fails closed", () => {
  assert.throws(
    () =>
      evaluateEngineeringObservations({
        project,
        observations: [make(), make({ evidence: "UNVERIFIED" })],
      }),
    /ENGINEERING_OBSERVER_CONFLICTING_REPLAY/,
  );
});

test("unverified signals do not become trustworthy from repetition", () => {
  const actual = evaluateEngineeringObservations({
    project,
    observations: [
      make({ evidence: "UNVERIFIED" }),
      make({
        eventId: "evt-00000002",
        sessionId: "chat-00000002",
        evidence: "UNVERIFIED",
      }),
    ],
  });
  assert.equal(actual.proposals[0].distinctSessions, 2);
  assert.equal(actual.proposals[0].sessionsWithAssertedEvidence, 0);
  assert.equal(actual.proposals[0].stage, "EVIDENCE_COLLECTION");
});

test("tenant/project and arbitrary secret-bearing fields are rejected atomically", () => {
  const invalid = [
    make({ project: "kmj-cinecore" }),
    make({ rawLog: "client data" }),
    make({ causeCode: "password=secret" }),
    make({ evidence: "SUCCESS" }),
    make({ eventId: "x" }),
    make({ skill: "not-installed-skill" }),
  ];
  for (const item of invalid)
    assert.throws(
      () =>
        evaluateEngineeringObservations({
          project,
          observations: [make(), item],
        }),
      /ENGINEERING_OBSERVER_(INVALID_EVENT_OR_SCOPE|CONFLICTING_REPLAY)/,
    );
});

test("event budget and project identity are strictly bounded", () => {
  assert.throws(
    () =>
      evaluateEngineeringObservations({
        project,
        observations: Array.from({ length: 33 }, () => make()),
      }),
    /ENGINEERING_OBSERVER_INVALID_REQUEST/,
  );
  assert.throws(
    () =>
      evaluateEngineeringObservations({
        project: "../other",
        observations: [],
      }),
    /ENGINEERING_OBSERVER_INVALID_REQUEST/,
  );
});

test("different causes are never incorrectly merged as one systemic failure", () => {
  const r = evaluateEngineeringObservations({
    project,
    observations: [
      make(),
      make({
        eventId: "evt-00000002",
        sessionId: "chat-00000002",
        causeCode: "POSTGRES_FTS_MISMATCH",
      }),
    ],
  });
  assert.equal(r.proposalCount, 2);
  assert.ok(
    r.proposals.every((proposal) => proposal.stage === "EVIDENCE_COLLECTION"),
  );
});

test("repeated observed skill gaps become design-review candidates, not installed skills", () => {
  const result = evaluateEngineeringObservations({
    project,
    observations: [
      make({ kind: "skill_gap" }),
      make({
        eventId: "evt-00000002",
        sessionId: "chat-00000002",
        kind: "skill_gap",
        evidence: "USER_CONFIRMED",
      }),
    ],
  });
  assert.equal(result.newSkillCandidates.length, 1);
  const candidate = result.newSkillCandidates[0];
  assert.equal(candidate.observedInSkill, "debugging");
  assert.equal(candidate.stage, "NEW_SKILL_DESIGN_REVIEW");
  assert.equal(candidate.status, "PROPOSED_NOT_INSTALLED");
  assert.equal(candidate.externalEvidenceVerified, false);
  assert.ok(candidate.requiredGates.includes("project-scoped owner review"));
  assert.equal(result.liveSkillsChanged, false);
});

test("unverified repeated skill gaps never promote a new skill design", () => {
  const result = evaluateEngineeringObservations({
    project,
    observations: [
      make({ kind: "skill_gap", evidence: "UNVERIFIED" }),
      make({
        eventId: "evt-00000002",
        sessionId: "chat-00000002",
        kind: "skill_gap",
        evidence: "UNVERIFIED",
      }),
    ],
  });
  assert.equal(result.newSkillCandidates[0].stage, "EVIDENCE_COLLECTION");
  assert.equal(result.crossCuttingCandidates.length, 0);
});

test("independent skills and sessions produce a cross-cutting review proposal only", () => {
  const observations = [
    make({ skill: "debugging" }),
    make({
      eventId: "evt-00000002",
      sessionId: "chat-00000002",
      skill: "security-hardening",
      kind: "user_correction",
    }),
  ];
  const result = evaluateEngineeringObservations({ project, observations });
  assert.equal(result.crossCuttingCandidates.length, 1);
  const candidate = result.crossCuttingCandidates[0];
  assert.deepEqual(candidate.affectedSkills, [
    "debugging",
    "security-hardening",
  ]);
  assert.equal(candidate.stage, "CROSS_SKILL_REVIEW");
  assert.equal(candidate.distinctSessions, 2);
  assert.equal(candidate.externalEvidenceVerified, false);
  assert.equal(candidate.status, "PROPOSED_NOT_INSTALLED");
  assert.equal(result.durableStateSaved, false);
  assert.deepEqual(
    result,
    evaluateEngineeringObservations({
      project,
      observations: [...observations].reverse(),
    }),
  );
});

test("a shared cause in only one session or with unverified evidence stays in collection", () => {
  const singleSession = evaluateEngineeringObservations({
    project,
    observations: [
      make(),
      make({
        eventId: "evt-00000002",
        skill: "security-hardening",
      }),
    ],
  });
  assert.equal(
    singleSession.crossCuttingCandidates[0].stage,
    "EVIDENCE_COLLECTION",
  );
  const unverified = evaluateEngineeringObservations({
    project,
    observations: [
      make(),
      make({
        eventId: "evt-00000002",
        sessionId: "chat-00000002",
        skill: "security-hardening",
        evidence: "UNVERIFIED",
      }),
    ],
  });
  assert.equal(
    unverified.crossCuttingCandidates[0].stage,
    "EVIDENCE_COLLECTION",
  );
});

test("new outputs preserve safe idempotent retries without extra candidates", () => {
  const events = [
    make({ kind: "skill_gap" }),
    make({
      eventId: "evt-00000002",
      sessionId: "chat-00000002",
      skill: "security-hardening",
    }),
  ];
  const exact = evaluateEngineeringObservations({
    project,
    observations: events,
  });
  const replay = evaluateEngineeringObservations({
    project,
    observations: [...events, events[0]],
  });
  assert.equal(replay.idempotentReplays, 1);
  assert.deepEqual(replay.newSkillCandidates, exact.newSkillCandidates);
  assert.deepEqual(replay.crossCuttingCandidates, exact.crossCuttingCandidates);
});
