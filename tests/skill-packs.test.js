import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { selectSkillPacks, SKILL_PACKS } from "../src/skill-packs.js";

const fixtures = JSON.parse(
  fs.readFileSync(
    new URL("../evals/skill-selection.json", import.meta.url),
    "utf8",
  ),
);

test("skill pack catalog is vendor-neutral and bounded", () => {
  assert.deepEqual(
    SKILL_PACKS.map((pack) => pack.id),
    [
      "security-hardening",
      "debugging",
      "tdd",
      "release-readiness",
      "context-budget",
      "independent-review",
      "agent-config-audit",
    ],
  );
  for (const pack of SKILL_PACKS) {
    assert.ok(pack.workflow.length >= 3 && pack.workflow.length <= 8);
    assert.ok(pack.evidence.length >= 2 && pack.evidence.length <= 8);
  }
});

for (const fixture of fixtures) {
  test(`skill selection eval: ${fixture.name}`, () => {
    const selected = selectSkillPacks(fixture.input).map((pack) => pack.id);
    assert.deepEqual(selected, fixture.expected);
  });
}

test("selection returns no generic skill when evidence has no matching signal", () => {
  assert.deepEqual(
    selectSkillPacks({
      objective: "Summarize the architecture documentation",
      changedFiles: ["docs/ARCHITECTURE.md"],
    }),
    [],
  );
});

test("ECC-inspired workflows are advisory, bounded and never executable config", () => {
  const examples = [
    ["Compact session handoff", "context-budget"],
    ["Parallel peer reviewer on an isolated worktree", "independent-review"],
    ["Audit MCP plugin hooks for prompt injection", "agent-config-audit"],
  ];
  for (const [objective, expected] of examples) {
    const selected = selectSkillPacks({ objective });
    assert.deepEqual(
      selected.map((pack) => pack.id),
      [expected],
    );
    assert.ok(selected.every((pack) => pack.workflow.length <= 8));
    assert.ok(selected.every((pack) => !("signals" in pack)));
    assert.ok(selected.every((pack) => !("command" in pack)));
  }
  assert.deepEqual(
    selectSkillPacks({ objective: "Write architecture notes" }),
    [],
  );
});
