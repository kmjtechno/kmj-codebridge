import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedTerminalCore } from "../src/isolated-terminal-core.js";
import { TerminalRecoveryJournal } from "../src/terminal-recovery-journal.js";

const imageId = "sha256:" + "a".repeat(64);
const id = "b".repeat(64);
const daemonId = "local-daemon";
const linuxOnly = { skip: process.platform !== "linux" };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-terminal-life-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new TerminalRecoveryJournal(root);
}

test(
  "journal binds before start and completes after removal",
  linuxOnly,
  async (t) => {
    const journal = setup(t);
    let name;
    const calls = [];
    const terminal = createIsolatedTerminalCore({
      enabled: true,
      imageId,
      daemonId,
      recoveryJournal: journal,
      invokeDocker: async (args) => {
        calls.push(args[0]);
        if (args[0] === "create") {
          name = args[2];
          assert.equal(journal.read(name).boundId, null);
          return { exitCode: 0, stdout: id };
        }
        assert.equal(journal.read(name).boundId, id);
        assert.equal(journal.completion(name), false);
        return { exitCode: 0 };
      },
    });
    const receipt = await terminal.execute("true");
    assert.deepEqual(calls, ["create", "start", "rm"]);
    assert.equal(journal.completion(name), true);
    assert.equal(receipt.recoveryJournalCompleted, true);
  },
);

test("failed cleanup leaves bound intent recoverable", linuxOnly, async (t) => {
  const journal = setup(t);
  let name;
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    daemonId,
    recoveryJournal: journal,
    invokeDocker: async (args) => {
      if (args[0] === "create") {
        name = args[2];
        return { exitCode: 0, stdout: id };
      }
      return { exitCode: args[0] === "rm" ? 1 : 0 };
    },
  });
  await assert.rejects(terminal.execute("true"), /CLEANUP_UNVERIFIED/);
  assert.equal(journal.read(name).boundId, id);
  assert.equal(journal.completion(name), false);
});

test("ambiguous create is journaled but cannot start", linuxOnly, async (t) => {
  const journal = setup(t);
  let name;
  const calls = [];
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    daemonId,
    recoveryJournal: journal,
    invokeDocker: async (args) => {
      calls.push(args[0]);
      name = args[2];
      throw new Error("connection lost");
    },
  });
  await assert.rejects(terminal.execute("true"));
  assert.deepEqual(calls, ["create"]);
  assert.equal(journal.read(name).boundId, null);
  assert.equal(journal.completion(name), false);
});
