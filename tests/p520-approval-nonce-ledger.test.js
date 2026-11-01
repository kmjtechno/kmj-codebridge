import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { consumeP520ApprovalNonce } from "../src/p520-approval-nonce-ledger.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const ISSUED = 1793530800000;
const EXPIRES = ISSUED + 240000;
const NOW = ISSUED + 60000;

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-p520-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(dir, patch = {}) {
  return {
    directory: dir,
    nonce: NONCE,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    now: NOW,
    ...patch,
  };
}

test("nonce claim is one-time and never authorizes inference", (t) => {
  const dir = directory(t);
  const first = consumeP520ApprovalNonce(fixture(dir));
  assert.deepEqual(first, {
    status: "OWNER_NONCE_RECORDED_SUPERVISOR_REQUIRED",
    recorded: true,
    ownerAttested: false,
    mayEnableInference: false,
  });
  const file = path.join(dir, "p520-" + NONCE + ".used");
  assert.match(fs.readFileSync(file, "utf8"), /^KMJ-P520-LLAMACPP-NONCE-V1\n/);
  assert.equal(fs.readdirSync(dir).length, 1);
  const second = consumeP520ApprovalNonce(fixture(dir));
  assert.equal(second.status, "OWNER_NONCE_REPLAY");
  assert.equal(second.ownerAttested, false);
  assert.equal(second.mayEnableInference, false);
});

test("claim remains consumed in a fresh child process (normal process restart)", (t) => {
  const dir = directory(t);
  assert.equal(consumeP520ApprovalNonce(fixture(dir)).recorded, true);
  const source = fileURLToPath(
    new URL("../src/p520-approval-nonce-ledger.js", import.meta.url),
  );
  const code =
    "import { consumeP520ApprovalNonce } from " +
    JSON.stringify(pathToFileURL(source).href) +
    "; console.log(JSON.stringify(consumeP520ApprovalNonce(" +
    JSON.stringify(fixture(dir)) +
    ")));";
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, child.stderr);
  const replay = JSON.parse(child.stdout.trim());
  assert.equal(replay.status, "OWNER_NONCE_REPLAY");
  assert.equal(replay.mayEnableInference, false);
});

test("invalid time, expired envelope and malformed nonce never touch filesystem", (t) => {
  const dir = directory(t);
  for (const patch of [
    { nonce: "../other" },
    { nonce: NONCE.toUpperCase() },
    { nonce: "f".repeat(31) },
    { issuedAt: ISSUED - 1, expiresAt: EXPIRES + 300000 },
    { now: EXPIRES },
    { now: ISSUED - 1 },
    { now: Infinity },
    { issuedAt: Number.NaN },
  ]) {
    const result = consumeP520ApprovalNonce(fixture(dir, patch));
    assert.equal(result.recorded, false);
    assert.equal(result.ownerAttested, false);
    assert.equal(result.mayEnableInference, false);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("untrusted or missing storage root fails closed without creating folders", (t) => {
  const root = directory(t);
  for (const p of [
    root + path.sep + "..",
    path.join(root, "missing"),
    "relative-directory",
    "",
    null,
    root + "\0evil",
  ]) {
    const result = consumeP520ApprovalNonce(fixture(p));
    assert.equal(result.status, "OWNER_NONCE_STORAGE_UNTRUSTED");
    assert.equal(result.recorded, false);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("preexisting claim file is never overwritten or deleted", (t) => {
  const dir = directory(t);
  const claim = path.join(dir, "p520-" + NONCE + ".used");
  fs.writeFileSync(claim, "owner-reserved");
  const result = consumeP520ApprovalNonce(fixture(dir));
  assert.equal(result.status, "OWNER_NONCE_REPLAY");
  assert.equal(result.recorded, false);
  assert.equal(fs.readFileSync(claim, "utf8"), "owner-reserved");
});

test("write and fsync failures leave the nonce burned, never permitting retry", (t) => {
  for (const name of ["writeFileSync", "fsyncSync"]) {
    const dir = directory(t);
    const io = { ...fs, [name]: () => { throw new Error("simulated failure"); } };
    const error = consumeP520ApprovalNonce(fixture(dir, { io }));
    assert.equal(error.status, "OWNER_NONCE_STORAGE_ERROR");
    assert.equal(error.mayEnableInference, false);
    const second = consumeP520ApprovalNonce(fixture(dir));
    assert.equal(second.status, "OWNER_NONCE_REPLAY");
  }
});

test("symlinked storage directory is rejected without writing through it", (t) => {
  if (process.platform === "win32") return t.skip("symlink creation needs privileges");
  const root = directory(t);
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const result = consumeP520ApprovalNonce(fixture(link));
  assert.equal(result.status, "OWNER_NONCE_STORAGE_UNTRUSTED");
  assert.deepEqual(fs.readdirSync(real), []);
});
