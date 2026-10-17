import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher, FAST_READ_TOOLS } from "../src/tools.js";

test("skill_recommendations is read-only, deterministic and fast-batch eligible", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-skill-tool-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );

  assert.ok(FAST_READ_TOOLS.includes("skill_recommendations"));
  const result = await dispatch(
    "skill_recommendations",
    {
      device: "d1",
      project: "p1",
      objective: "Fix OAuth authorization regression before release",
      changedFiles: ["src/auth.js"],
      failureSummary: "cross-tenant test failing",
    },
    ["read"],
  );

  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ["security-hardening", "debugging", "tdd", "release-readiness"],
  );
  assert.ok(result.skills.every((skill) => !("signals" in skill)));
});

test("opt-in observer uses the same scoped read-only tool without changing legacy response", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-observer-tool-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );

  const basic = await dispatch(
    "skill_recommendations",
    { device: "d1", project: "p1", objective: "Fix regression" },
    ["read"],
  );
  assert.equal(Object.hasOwn(basic, "observer"), false);

  const signal = (eventId, sessionId) => ({
    eventId,
    project: "p1",
    sessionId,
    skill: "debugging",
    kind: "ci_failure",
    causeCode: "CI_RUNNER_PRESTART",
    evidence: "REPRODUCED",
  });
  const reviewed = await dispatch(
    "skill_recommendations",
    {
      device: "d1",
      project: "p1",
      objective: "Fix CI failure",
      observations: [
        signal("evt-00000001", "chat-00000001"),
        signal("evt-00000002", "chat-00000002"),
      ],
    },
    ["read"],
  );
  assert.equal(reviewed.observer.proposalCount, 1);
  assert.equal(reviewed.observer.proposals[0].stage, "STRUCTURAL_GUARD_REVIEW");
  assert.equal(reviewed.observer.liveSkillsChanged, false);
  assert.equal(reviewed.observer.externalEvidenceVerified, false);
});
