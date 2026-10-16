import assert from "node:assert/strict";
import { test } from "node:test";
import { buildKnowledgeMemoryBrief } from "../src/knowledge-memory-brief.js";

const scope = {
  organizationId: "01234567-89ab-4cde-8000-0123456789ab",
  project: "kmj-codebridge",
};
const one = {
  organization_id: scope.organizationId,
  project_key: scope.project,
  observation_id: "01234567-89ab-4cde-8000-0123456789ac",
  topic_key: "decision/dirty-worktree",
  type: "decision",
  title: "Preserve the dirty checkout",
  preview: "Use an isolated worktree for risky test changes.",
  revision: 1,
};

test("empty results are bounded and do not call any provider or execute work", () => {
  const result = buildKnowledgeMemoryBrief({
    ...scope,
    observations: [],
  });
  assert.equal(result.accepted, 0);
  assert.equal(result.omitted, 0);
  assert.equal(result.execution, "NONE");
  assert.equal(result.authorization, "NOT_VERIFIED_BY_THIS_MODULE");
  assert.equal(result.promptTransferred, false);
  assert.match(result.brief, /UNTRUSTED HISTORICAL PROJECT KNOWLEDGE/);
});

test("a scoped projection is deterministic, digestible and marked untrusted", () => {
  const a = { ...one, topic_key: "bugfix/agent-reconnect" };
  const b = { ...one, observation_id: "01234567-89ab-4cde-8000-0123456789ad" };
  const r1 = buildKnowledgeMemoryBrief({
    ...scope,
    observations: [a, b],
  });
  const r2 = buildKnowledgeMemoryBrief({
    ...scope,
    observations: [b, a],
  });
  assert.equal(r1.brief, r2.brief);
  assert.equal(r1.sha256, r2.sha256);
  assert.equal(r1.accepted, 2);
  assert.ok(r1.brief.includes("dirty-worktree"));
  assert.ok(r1.brief.includes("not current CI"));
});

test("higher topic revision supersedes prior context without duplicate notes", () => {
  const a = { ...one, revision: 2, preview: "Always use a clean isolated worktree." };
  const r = buildKnowledgeMemoryBrief({
    ...scope,
    observations: [a, one],
  });
  assert.equal(r.accepted, 1);
  assert.match(r.brief, /clean isolated worktree/);
  assert.doesNotMatch(r.brief, /risky test changes/);
});

test("same topic and revision with conflicting content must fail closed", () => {
  const changed = { ...one, preview: "Different observation." };
  assert.throws(
    () => buildKnowledgeMemoryBrief({ ...scope, observations: [one, changed] }),
    /KNOWLEDGE_BRIEF_CONFLICTING_REVISIONS/,
  );
});

test("cross-tenant and cross-project context never enters an assembled brief", () => {
  const foreignOrganization = {
    ...one,
    organization_id: "01234567-89ab-4cde-8000-0123456789ae",
  };
  const foreignProject = { ...one, project_key: "kmj-cinecore" };
  for (const foreign of [foreignOrganization, foreignProject]) {
    assert.throws(
      () =>
        buildKnowledgeMemoryBrief({
          ...scope,
          observations: [one, foreign],
        }),
      /KNOWLEDGE_BRIEF_SCOPE_OR_RECORD_MISMATCH/,
    );
  }
});

test("secrets, URLs, terminal transcripts and malformed note fields are denied", () => {
  const bad = [
    { preview: "api_key=DO_NOT_SHARE" },
    { preview: "-----BEGIN RSA PRIVATE KEY-----" },
    { preview: "https://unsafe.example/path" },
    { title: "Do this\nexecute that" },
    { preview: "ghp_abcdefghijklmnopqrstuvwx" },
  ];
  for (const change of bad) {
    assert.throws(
      () =>
        buildKnowledgeMemoryBrief({
          ...scope,
          observations: [{ ...one, ...change }],
        }),
      /KNOWLEDGE_BRIEF_UNSAFE_ITEM/,
    );
  }
});

test("full notes are not truncated and oversized sets are omitted atomically", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    ...one,
    observation_id: "01234567-89ab-4cde-8000-0123456789ac",
    topic_key: "decision/long-" + i,
    preview: "x".repeat(180),
  }));
  const r = buildKnowledgeMemoryBrief({
    ...scope,
    observations: many,
    maxChars: 600,
  });
  assert.ok(r.brief.length <= 600);
  assert.ok(r.accepted >= 1);
  assert.ok(r.omitted >= 1);
  assert.ok(!r.brief.includes("x".repeat(100)) || r.brief.includes("x".repeat(180)));
});

test("invalid scope, too many observations and too-large budget are refused", () => {
  const invalid = [
    { ...scope, observations: [one], project: "../other" },
    { ...scope, observations: [one], organizationId: "no-uuid" },
    { ...scope, observations: [one], maxChars: 1000000 },
    { ...scope, observations: new Array(21).fill(one) },
  ];
  for (const args of invalid)
    assert.throws(
      () => buildKnowledgeMemoryBrief(args),
      /KNOWLEDGE_BRIEF_INVALID_REQUEST/,
    );
});
