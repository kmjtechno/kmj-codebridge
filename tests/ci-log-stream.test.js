import assert from "node:assert/strict";
import test from "node:test";
import { readCiLogDiagnostics } from "../src/ci-log-stream.js";

async function* bytes(text) {
  for (const byte of Buffer.from(text)) yield Buffer.from([byte]);
}

test("diagnostics survive split UTF-8 and filter secrets and private-key blocks", async () => {
  const text =
    "progress हिन्दी\nerror TS2339: field café missing\n" +
    "Authorization: Bearer hidden-session-value\n" +
    "-----BEGIN " +
    "PRIVATE KEY-----\nerror should-never-leave-key-block\n-----END PRIVATE KEY-----\n" +
    "error TS2345: final failure";
  const result = await readCiLogDiagnostics(bytes(text));
  assert.deepEqual(result.lines, [
    "error TS2339: field café missing",
    "error TS2345: final failure",
  ]);
  assert.equal(result.sourceComplete, true);
  assert.equal(result.sourceBytesRead, Buffer.byteLength(text));
  assert.doesNotMatch(
    JSON.stringify(result),
    /hidden-session-value|should-never-leave/,
  );
});

test("oversized lines are discarded rather than buffered or treated as safe fragments", async () => {
  const text =
    "error " +
    "x".repeat(100000) +
    "password=hidden\nerror TS2339: next complete line\n";
  const result = await readCiLogDiagnostics(bytes(text));
  assert.deepEqual(result.lines, ["error TS2339: next complete line"]);
  assert.equal(result.truncated, true);
});

test("byte cap closes the source and excludes a partially consumed diagnostic", async () => {
  let closed = false;
  let produced = 0;
  async function* source() {
    try {
      for (let i = 0; i < 1000; i++) {
        produced++;
        yield Buffer.alloc(16384, 120);
      }
    } finally {
      closed = true;
    }
  }
  const result = await readCiLogDiagnostics(source());
  assert.equal(result.sourceComplete, false);
  assert.equal(result.sourceBytesRead, 4 * 1024 * 1024);
  assert.equal(produced, 257);
  assert.equal(closed, true);
  assert.deepEqual(result.lines, []);
});

test("stream errors propagate instead of claiming a complete log", async () => {
  async function* source() {
    yield Buffer.from("error TS2339: partial transport\n");
    throw new Error("transport failed");
  }
  await assert.rejects(readCiLogDiagnostics(source()), /transport failed/);
});

test("private-key suppression survives oversized delimiter lines and split markers", async () => {
  const text =
    "x".repeat(500) +
    "-----BEGIN RSA " +
    "PRIVATE KEY-----" +
    " ".repeat(500) +
    "\nerror must-stay-private\n" +
    " ".repeat(500) +
    "-----END RSA PRIVATE KEY-----" +
    "\nerror TS2339: after key\n";
  const result = await readCiLogDiagnostics(bytes(text));
  assert.deepEqual(result.lines, ["error TS2339: after key"]);
  assert.equal(result.truncated, true);
});
