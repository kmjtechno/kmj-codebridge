import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { planLargePrompt } from "../src/large-prompt-plan.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function checkFullCoverage(original, plan) {
  assert.equal(plan.promptSha256, sha(original));
  assert.equal(plan.utf8Bytes, Buffer.byteLength(original, "utf8"));
  assert.equal(plan.utf16Chars, original.length);
  assert.equal(plan.parts[0].startUtf16, 0);
  assert.equal(plan.parts.at(-1).endUtf16, original.length);
  let cursor = 0;
  const portions = [];
  for (const part of plan.parts) {
    assert.equal(part.startUtf16, cursor);
    assert.ok(part.endUtf16 > part.startUtf16);
    const piece = original.slice(part.startUtf16, part.endUtf16);
    assert.equal(part.sha256, sha(piece));
    assert.equal(part.utf8Bytes, Buffer.byteLength(piece, "utf8"));
    assert.ok(piece.length <= 32768);
    portions.push(piece);
    cursor = part.endUtf16;
  }
  assert.equal(portions.join(""), original);
  assert.equal(plan.promptStored, false);
  assert.equal(plan.promptContentReturned, false);
  assert.equal(plan.modelInvoked, false);
  assert.equal(plan.contextWindowExtended, false);
  assert.equal(plan.budgetFitVerified, false);
}

test("large ASCII prompt is covered exactly and never silently truncated", () => {
  const source = ("# Section\n" + "line of requirements\n".repeat(50)).repeat(450);
  const plan = planLargePrompt({ prompt: source });
  checkFullCoverage(source, plan);
  assert.ok(plan.parts.length > 10);
  assert.ok(plan.parts.length <= 128);
  assert.equal(plan.unclosedCodeFence, false);
  assert.ok(plan.headingCount > 10);
  assert.equal(plan.latencyImprovementMeasured, false);
});

test("Hindi, emoji, CRLF and very long lines preserve every original unit", () => {
  const source =
    "# हिंदी निर्देश\r\n" +
    "सुरक्षित परीक्षण 🌍🚀\r\n".repeat(2500) +
    "z".repeat(40000) +
    "🚀" +
    "# अंतिम चरण";
  const plan = planLargePrompt({ prompt: source, chunkChars: 8192 });
  checkFullCoverage(source, plan);
  for (const part of plan.parts.slice(0, -1)) {
    const before = source.charCodeAt(part.endUtf16 - 1);
    const after = source.charCodeAt(part.endUtf16);
    assert.equal(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff, false);
    assert.equal(source[part.endUtf16 - 1] === "\r" && source[part.endUtf16] === "\n", false);
  }
});

test("splitting within a large fenced code block is flagged for reassembly", () => {
  const source = "# Overview\n" + "```js\n" + "x".repeat(45000) + "\n```\n" + "# End\n";
  const plan = planLargePrompt({ prompt: source, chunkChars: 8192 });
  checkFullCoverage(source, plan);
  assert.ok(plan.parts.some((p) => p.crossesCodeFenceBoundary));
  assert.equal(plan.unclosedCodeFence, false);
});

test("unclosed fenced code is flagged rather than silently treated as a task", () => {
  const plan = planLargePrompt({ prompt: "# Work\n~~~python\n" + "x".repeat(10000) });
  assert.equal(plan.unclosedCodeFence, true);
  assert.ok(plan.parts.length >= 1);
  assert.equal(plan.modelInvoked, false);
});

test("digest-based repeat returns tiny unchanged reply without copying content", () => {
  const secret = "Private roadmap must not be repeated or uploaded to a model.";
  const first = planLargePrompt({ prompt: secret });
  const again = planLargePrompt({
    prompt: secret,
    ifNoneMatch: first.promptSha256,
  });
  assert.equal(again.unchanged, true);
  assert.equal(again.promptSha256, sha(secret));
  assert.equal(Object.hasOwn(again, "parts"), false);
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.ok(!JSON.stringify(again).includes(secret));
});

test("maximum 1 MiB UTF-8 is accepted, overflow fails closed without fallback", () => {
  const exact = "A".repeat(1024 * 1024);
  checkFullCoverage(exact, planLargePrompt({ prompt: exact }));
  assert.throws(
    () => planLargePrompt({ prompt: exact + "A" }),
    /LARGE_PROMPT_INVALID_REQUEST/,
  );
  assert.throws(
    () => planLargePrompt({ prompt: "क".repeat(400000) }),
    /LARGE_PROMPT_TOO_LARGE/,
  );
});

test("rejects malformed Unicode, unsafe chunk budgets and bad cache tags", () => {
  for (const input of [
    { prompt: "" },
    { prompt: "\ud800" },
    { prompt: "\udc00" },
    { prompt: "abc\u0000" },
    { prompt: "valid", chunkChars: 100 },
    { prompt: "valid", chunkChars: 99999 },
    { prompt: "valid", ifNoneMatch: "not-a-sha" },
  ]) {
    assert.throws(
      () => planLargePrompt(input),
      /LARGE_PROMPT_(INVALID_REQUEST|INVALID_UNICODE)/,
    );
  }
});

test("planner does not infer LLM fit, project access or real execution speed", () => {
  const prompt = "# Work\n" + "Must pass secure tests\n".repeat(800);
  const planned = planLargePrompt({ prompt });
  assert.equal(planned.contextWindowExtended, false);
  assert.equal(planned.latencyImprovementMeasured, false);
  assert.equal(planned.budgetFitVerified, false);
  assert.equal(planned.originalRetainedByCaller, true);
  assert.ok(planned.preferredExistingTools.includes("fast_read_batch"));
  assert.equal(Object.hasOwn(planned, "recommendedTasks"), false);
});
