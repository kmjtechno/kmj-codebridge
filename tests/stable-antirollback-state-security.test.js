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

test("writer cannot downgrade or replace a different signed release at the accepted sequence", (t) => {
  const { stateDir, file } = fixture(t);
  writeAcceptedUpdateState(stateDir, manifest);
  assert.throws(
    () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 42 }),
    /UPDATE_STATE_ROLLBACK_REJECTED/,
  );
  assert.throws(
    () =>
      writeAcceptedUpdateState(stateDir, {
        ...manifest,
        revision: "b".repeat(40),
      }),
    /UPDATE_STATE_ROLLBACK_REJECTED/,
  );
  assert.equal(readAcceptedUpdateState(stateDir).sequence, 43);
  assert.equal(readAcceptedUpdateState(stateDir).revision, manifest.revision);
  assert.deepEqual(fs.readdirSync(stateDir), [path.basename(file)]);
});

test(
  "writer rejects unsafe or corrupt existing watermark before replacing it",
  { skip: process.platform === "win32" },
  (t) => {
    const { stateDir, file } = fixture(t);
    fs.symlinkSync(path.join(stateDir, "missing-watermark"), file);
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, manifest),
      /UPDATE_STATE_INVALID/,
    );
    fs.unlinkSync(file);
    writeAcceptedUpdateState(stateDir, manifest);
    const second = path.join(stateDir, "second-link");
    fs.linkSync(file, second);
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 44 }),
      /UPDATE_STATE_INVALID/,
    );
    fs.unlinkSync(second);
    fs.writeFileSync(file, "{broken", { mode: 0o600 });
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 44 }),
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

test("existing writer lock fails closed without replacing a higher watermark", (t) => {
  const { stateDir, file } = fixture(t);
  writeAcceptedUpdateState(stateDir, manifest);
  const lock = path.join(stateDir, ".stable-update-state.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  assert.throws(
    () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 44 }),
    /UPDATE_STATE_LOCKED/,
  );
  assert.equal(readAcceptedUpdateState(stateDir).sequence, 43);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), [
    ".stable-update-state.lock",
    path.basename(file),
  ]);
  fs.rmdirSync(lock);
  writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 44 });
  assert.equal(readAcceptedUpdateState(stateDir).sequence, 44);
  assert.deepEqual(fs.readdirSync(stateDir), [path.basename(file)]);
});

test("failed direct writer releases only its own lock and leaves no temp state", (t) => {
  const { stateDir, file } = fixture(t);
  writeAcceptedUpdateState(stateDir, manifest);
  assert.throws(
    () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 42 }),
    /UPDATE_STATE_ROLLBACK_REJECTED/,
  );
  assert.deepEqual(fs.readdirSync(stateDir), [path.basename(file)]);
  assert.equal(readAcceptedUpdateState(stateDir).sequence, 43);
});

test(
  "reader rejects missing, redirected or world-readable state root before assuming first boot",
  { skip: process.platform === "win32" },
  (t) => {
    const { root, stateDir } = fixture(t);
    fs.rmdirSync(stateDir);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    fs.symlinkSync(root, stateDir);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    fs.unlinkSync(stateDir);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.chmodSync(stateDir, 0o755);
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.deepEqual(fs.readdirSync(stateDir), []);
  },
);

test(
  "direct writer rejects insecure state root before creating lock or watermark",
  { skip: process.platform === "win32" },
  (t) => {
    const { stateDir } = fixture(t);
    fs.chmodSync(stateDir, 0o777);
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, manifest),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.deepEqual(fs.readdirSync(stateDir), []);
  },
);

test(
  "post-rename durability failure retains lock and rejects automatic retry",
  { skip: process.platform === "win32" },
  (t) => {
    const { stateDir, file } = fixture(t);
    const originalFsync = fs.fsyncSync;
    let fsyncCalls = 0;
    t.mock.method(fs, "fsyncSync", (fd) => {
      fsyncCalls++;
      // 1: persist writer lock, 2: persist file, 3: persist rename.
      if (fsyncCalls === 3) throw Error("INJECTED_DIRECTORY_FSYNC_FAILURE");
      return originalFsync(fd);
    });
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, manifest),
      /INJECTED_DIRECTORY_FSYNC_FAILURE/,
    );
    assert.equal(fsyncCalls, 3);
    assert.equal(readAcceptedUpdateState(stateDir).sequence, 43);
    assert.deepEqual(fs.readdirSync(stateDir).sort(), [
      ".stable-update-state.lock",
      path.basename(file),
    ]);
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, { ...manifest, sequence: 44 }),
      /UPDATE_STATE_LOCKED/,
    );
    t.mock.restoreAll();
    // Fixture cleanup is only for the isolated test. Production must require
    // owner reconciliation rather than automatically clearing this lock.
    fs.rmdirSync(path.join(stateDir, ".stable-update-state.lock"));
  },
);

test(
  "signed watermark reader and writer reject a symlinked parent of a private state root",
  { skip: process.platform === "win32" },
  (t) => {
    const { root } = fixture(t);
    const actual = path.join(root, "actual");
    const redirected = path.join(root, "redirected");
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.mkdirSync(path.join(actual, "state"), { mode: 0o700 });
    fs.symlinkSync(actual, redirected, "dir");
    const stateDir = path.join(redirected, "state");
    assert.throws(
      () => readAcceptedUpdateState(stateDir),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.throws(
      () => writeAcceptedUpdateState(stateDir, manifest),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.deepEqual(fs.readdirSync(path.join(actual, "state")), []);
  },
);

test(
  "writer rejects redirected parent before creating a missing watermark directory",
  { skip: process.platform === "win32" },
  (t) => {
    const { root } = fixture(t);
    const actual = path.join(root, "actual");
    const redirected = path.join(root, "redirected");
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.symlinkSync(actual, redirected, "dir");
    assert.throws(
      () =>
        writeAcceptedUpdateState(path.join(redirected, "new-state"), manifest),
      /UPDATE_STATE_ROOT_INVALID/,
    );
    assert.deepEqual(fs.readdirSync(actual), []);
  },
);

test(
  "writable non-sticky state ancestors fail closed before watermark creation",
  { skip: process.platform === "win32" },
  (t) => {
    const { root } = fixture(t);
    const parent = path.join(root, "untrusted-parent");
    const stateDir = path.join(parent, "state");
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.mkdirSync(stateDir, { mode: 0o700 });
    for (const mode of [0o770, 0o777]) {
      fs.chmodSync(parent, mode);
      assert.throws(
        () => readAcceptedUpdateState(stateDir),
        /UPDATE_STATE_ROOT_INVALID/,
      );
      assert.throws(
        () => writeAcceptedUpdateState(stateDir, manifest),
        /UPDATE_STATE_ROOT_INVALID/,
      );
      assert.deepEqual(fs.readdirSync(stateDir), []);
    }
    fs.chmodSync(parent, 0o700);
    writeAcceptedUpdateState(stateDir, manifest);
    assert.equal(readAcceptedUpdateState(stateDir).sequence, 43);
  },
);
