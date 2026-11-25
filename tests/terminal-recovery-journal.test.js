import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planTerminalRecovery,
  TerminalRecoveryJournal,
} from "../src/terminal-recovery-journal.js";

const imageId = "sha256:" + "a".repeat(64);
const id = "b".repeat(64);
const daemonId = "local-daemon";
const intent = {
  version: 1,
  name: "kmj-terminal-12345678-1234-1234-1234-123456789abc",
  imageId,
  daemonId,
};
const observation = {
  status: "present",
  queriedId: id,
  id,
  name: intent.name,
  imageId,
  daemonId,
  label: "isolated-terminal",
};

test("recovery only proposes removal for exact journaled identity", () => {
  assert.deepEqual(planTerminalRecovery(intent, id, observation), {
    state: "EXACT_ID_CLEANUP_CANDIDATE",
    removeId: id,
  });
  for (const changed of [
    { daemonId: "another-daemon" },
    { id: "c".repeat(64) },
    { queriedId: "c".repeat(64) },
    { name: "other" },
    { imageId: "sha256:" + "c".repeat(64) },
    { label: "unrelated" },
    { status: "unknown" },
  ]) {
    assert.equal(
      planTerminalRecovery(intent, id, { ...observation, ...changed }).removeId,
      null,
    );
  }
  assert.deepEqual(planTerminalRecovery(intent, null, observation), {
    state: "AMBIGUOUS_CREATE",
    removeId: null,
  });
  assert.deepEqual(
    planTerminalRecovery(intent, id, {
      daemonId,
      status: "absent",
      queriedId: id,
    }),
    { state: "EXACT_ID_ABSENT", removeId: null },
  );
});

test("durable journal survives reopening and refuses identity replacement", {
  skip: process.platform !== "linux",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-terminal-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new TerminalRecoveryJournal(root);
  const created = journal.begin({ imageId, daemonId });
  assert.deepEqual(new TerminalRecoveryJournal(root).read(created.name), {
    intent: created,
    boundId: null,
  });
  journal.bind(created.name, id);
  assert.deepEqual(new TerminalRecoveryJournal(root).read(created.name), {
    intent: created,
    boundId: id,
  });
  assert.throws(() => journal.bind(created.name, "c".repeat(64)), {
    code: "EEXIST",
  });
  assert.throws(() => journal.read("../other"), /INVALID_NAME/);
  assert.throws(() => journal.bind(created.name, "short"), /INVALID_ID/);
});

test("private journal rejects insecure root and malformed binding", {
  skip: process.platform !== "linux",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-terminal-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o755);
  assert.throws(
    () => new TerminalRecoveryJournal(root),
    /UNTRUSTED_DIRECTORY/,
  );
  fs.chmodSync(root, 0o700);
  const journal = new TerminalRecoveryJournal(root);
  const created = journal.begin({ imageId, daemonId });
  journal.bind(created.name, id);
  fs.writeFileSync(
    path.join(root, "terminal-recovery", created.name + ".bound"),
    JSON.stringify({ version: 1, name: "wrong", id }),
  );
  assert.throws(() => journal.read(created.name), /INVALID_BINDING/);
});

test("unsupported private storage fails closed", {
  skip: process.platform === "linux",
}, () => {
  assert.throws(
    () => new TerminalRecoveryJournal(os.tmpdir()),
    /PRIVATE_STORAGE_UNVERIFIED/,
  );
});
