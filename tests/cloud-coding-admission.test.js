import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCloudCodingAdmission } from "../src/cloud-coding-admission.js";

const fixture = () => ({
  provider: {
    upstreamProviderVerified: true,
    billingVerified: true,
    zeroPriceVerified: true,
    quotaVerified: true,
    noPaidFallbackVerified: true,
    paidInference: false,
    accountId: "fixture-account",
    routeId: "fixture-free-route",
    snapshotId: "fixture-snapshot",
    attestationId: "fixture-attestation",
    snapshotFresh: true,
    routeBound: true,
  },
  consent: {
    approved: true,
    project: "fixture-project",
    accountId: "fixture-account",
    routeId: "fixture-free-route",
    approvalId: "fixture-consent",
  },
  lane: {
    project: "fixture-project",
    head: "a".repeat(40),
    dirty: false,
    isolated: true,
    currentHeadVerified: true,
    mayPrepare: true,
  },
  qa: { approved: true, nonDestructive: true, recipeId: "fixture-qa" },
  release: {
    ownerSigned: true,
    immutableVerified: true,
    supervisorBound: true,
    revision: "b".repeat(40),
  },
  explicitActivationRequested: true,
});

test("cloud coding admission defaults to deny and never performs work", () => {
  for (const input of [undefined, null, {}, [], { provider: {} }]) {
    assert.equal(evaluateCloudCodingAdmission(input).allowed, false);
  }
});

test("cloud coding admission rejects every missing independent evidence gate", () => {
  const changes = [
    (x) => (x.provider.upstreamProviderVerified = false),
    (x) => (x.provider.billingVerified = false),
    (x) => (x.provider.zeroPriceVerified = false),
    (x) => (x.provider.quotaVerified = false),
    (x) => (x.provider.noPaidFallbackVerified = false),
    (x) => (x.provider.paidInference = null),
    (x) => (x.provider.routeBound = false),
    (x) => (x.provider.snapshotFresh = false),
    (x) => (x.provider.attestationId = ""),
    (x) => (x.consent.approved = false),
    (x) => (x.consent.accountId = "other-account"),
    (x) => (x.consent.routeId = "paid-route"),
    (x) => (x.lane.project = "other-project"),
    (x) => (x.lane.head = "untrusted"),
    (x) => (x.lane.dirty = true),
    (x) => (x.lane.isolated = false),
    (x) => (x.lane.mayPrepare = false),
    (x) => (x.qa.nonDestructive = false),
    (x) => (x.qa.approved = false),
    (x) => (x.release.ownerSigned = false),
    (x) => (x.release.supervisorBound = false),
    (x) => (x.explicitActivationRequested = false),
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.equal(evaluateCloudCodingAdmission(input).allowed, false);
  }
});

test("positive fixture remains advisory and can never grant activation", () => {
  assert.deepEqual(evaluateCloudCodingAdmission(fixture()), {
    allowed: false,
    preflightEligible: true,
    reason: "PREFLIGHT_ONLY_REVALIDATE_AT_EXECUTION",
  });
});

test("inherited evidence and hostile getters cannot forge activation proofs", () => {
  const inherited = fixture();
  delete inherited.provider.billingVerified;
  Object.setPrototypeOf(inherited.provider, { billingVerified: true });
  assert.deepEqual(evaluateCloudCodingAdmission(inherited), {
    allowed: false,
    reason: "UNTRUSTED_EVIDENCE_FIELDS",
  });
  const getter = fixture();
  Object.defineProperty(getter.consent, "approved", {
    get() {
      throw new Error("HOSTILE_CONSENT_GETTER");
    },
  });
  assert.deepEqual(evaluateCloudCodingAdmission(getter), {
    allowed: false,
    reason: "UNTRUSTED_EVIDENCE_FIELDS",
  });
  const trap = new Proxy(fixture(), {
    getOwnPropertyDescriptor() {
      throw new Error("HOSTILE_PROXY_TRAP");
    },
  });
  assert.deepEqual(evaluateCloudCodingAdmission(trap), {
    allowed: false,
    reason: "EVIDENCE_ACCESS_FAILED",
  });
  // All-positive caller-controlled booleans have no authority to start work.
  assert.equal(evaluateCloudCodingAdmission(fixture()).allowed, false);
});
