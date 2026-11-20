import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const text = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", ".github", "CODEOWNERS"),
  "utf8",
);
const rules = text
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/\s+/));

test("every path is owner-reviewed by default and the default comes first", () => {
  assert.deepEqual(rules[0], ["*", "@nskmedia"]);
});

test("high-risk paths are explicitly owned", () => {
  for (const p of [
    "/.github/",
    "/CLAUDE.md",
    "/SECURITY.md",
    "/releases/",
    "/scripts/",
    "/src/",
    "/config/",
    "/package.json",
    "/package-lock.json",
  ])
    assert.ok(
      rules.some((r) => r[0] === p && r[1] === "@nskmedia"),
      p,
    );
});

test("only plain Markdown under docs/ is released from review", () => {
  const released = rules.filter((r) => r.length === 1).map((r) => r[0]);
  assert.deepEqual(released, ["/docs/**/*.md"]);
});
