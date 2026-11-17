import assert from "node:assert/strict";
import test from "node:test";
import { candidateChains, TASKS } from "../src/freellmapi-client.js";

// Routing is only a preference calculation. It must never invent a chain
// missing from the discovered catalog or substitute a paid model identifier.
test("route preferences are restricted to discovered chain IDs", () => {
  const catalog = ["paid-model", "auto:coder", "auto:default", "auto:code"];
  assert.deepEqual(candidateChains("code", catalog), [
    "auto:code",
    "auto:coder",
    "auto:default",
  ]);
  assert.deepEqual(candidateChains("fast", catalog), ["auto:default"]);
  assert.deepEqual(candidateChains("reasoning", catalog), ["auto:default"]);
  assert.deepEqual(candidateChains("general", catalog), ["auto:default"]);
});

test("no discovered preferred chain means no candidate, not a fallback", () => {
  for (const task of TASKS) {
    assert.deepEqual(candidateChains(task, ["paid-model", "other"]), []);
    assert.deepEqual(candidateChains(task, []), []);
  }
});

test("unknown task uses general preference without widening model selection", () => {
  assert.deepEqual(candidateChains("unknown", ["auto:code"]), []);
  assert.deepEqual(candidateChains("unknown", ["auto:code", "auto:default"]), [
    "auto:default",
  ]);
});

test("candidate routing does not mutate the discovered catalog", () => {
  const discovered = Object.freeze(["auto:default", "auto:code"]);
  assert.deepEqual(candidateChains("code", discovered), [
    "auto:code",
    "auto:default",
  ]);
  assert.deepEqual(discovered, ["auto:default", "auto:code"]);
});
