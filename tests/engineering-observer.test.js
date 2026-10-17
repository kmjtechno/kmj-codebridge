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
