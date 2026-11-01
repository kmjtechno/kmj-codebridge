import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readAcceptedUpdateState,
  runStableUpdate,
  writeAcceptedUpdateState,
} from "../src/stable-updater.js";

const manifest = {
  sequence: 43,
  version: "0.3.2",
  revision: "a".repeat(40),
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-antirollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  return {
    root,
    stateDir,
    file: path.join(stateDir, "stable-update-state.json"),
  };
}

test("accepted signed sequence is stored as a private regular inode and readable", (t) => {
  const { stateDir, file } = fixture(t);
  assert.equal(readAcceptedUpdateState(stateDir), null);
  writeAcceptedUpdateState(
    stateDir,
    manifest,
    Date.parse("2026-11-01T00:00:00Z"),
  );
  const accepted = readAcceptedUpdateState(stateDir);
  assert.equal(accepted.sequence, 43);
  assert.equal(accepted.revision, manifest.revision);
  assert.equal(fs.lstatSync(file).nlink, 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  }
});

test(
  "dangling symlink cannot downgrade a signed anti-rollback watermark to absent",
  { skip: process.platform === "win32" },
  (t) => {
    const { stateDir, file } = fixture(t);
    fs.symlinkSync(path.join(stateDir, "missing-watermark"), file);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_INVALID/,
    );
  },
);

test(
  "hardlinked or group-writable anti-rollback state fails closed",
  { skip: process.platform === "win32" },
  (t) => {
    const { stateDir, file } = fixture(t);
    writeAcceptedUpdateState(stateDir, manifest);
    const second = path.join(stateDir, "second-link");
    fs.linkSync(file, second);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_INVALID/,
    );
    fs.unlinkSync(second);
    fs.chmodSync(file, 0o660);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_INVALID/,
    );
  },
);

test("malformed or oversized watermark never becomes an absent sequence", (t) => {
  const { stateDir, file } = fixture(t);
  for (const content of ["{broken", "x".repeat(4097)]) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_INVALID/,
    );
  }
});

test(
  "existing world-writable updater state directory blocks before network or activation",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, stateDir } = fixture(t);
    fs.chmodSync(stateDir, 0o777);
    const agentStateDir = path.join(root, "agent");
    fs.mkdirSync(agentStateDir);
    let networkCalls = 0;
    await assert.rejects(
      runStableUpdate(
        {
          schema: 1,
          channel: "stable",
          manifestUrl: "https://updates.example/manifest.json",
          signatureUrl: "https://updates.example/manifest.sig",
          trustedKeys: { stable: "x".repeat(40) },
          installRoot: path.join(root, "install"),
          stateDir,
          agentStateDir,
          workDir: path.join(root, "work"),
        },
        {
          fetchBytes: async () => {
            networkCalls++;
            throw Error("must not fetch");
          },
        },
      ),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.equal(networkCalls, 0);
  },
);
