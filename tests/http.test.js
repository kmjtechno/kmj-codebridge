import test from "node:test";
import assert from "node:assert/strict";
import { readJsonLimited } from "../src/http.js";
test("stream reader bounds bytes before buffering a whole response", async () => {
  let produced = 0,
    closed = false;
  async function* source() {
    try {
      for (let i = 0; i < 100; i++) {
        produced++;
        yield Buffer.alloc(1024, 32);
      }
    } finally {
      closed = true;
    }
  }
  await assert.rejects(readJsonLimited(source(), 2048), /BODY_TOO_LARGE/);
  assert.equal(produced, 3);
  assert.equal(closed, true);
});
test("stream reader parses valid JSON and rejects invalid JSON", async () => {
  async function* valid() {
    yield Buffer.from('{"ok":');
    yield Buffer.from("true}");
  }
  assert.deepEqual(await readJsonLimited(valid()), { ok: true });
  async function* invalid() {
    yield Buffer.from("{");
  }
  await assert.rejects(readJsonLimited(invalid()), /INVALID_JSON/);
});
