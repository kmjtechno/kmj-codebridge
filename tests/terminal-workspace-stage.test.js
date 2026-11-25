import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { ProjectFiles } from "../src/policy.js";
import { planTerminalWorkspaceSnapshot } from "../src/terminal-workspace-snapshot.js";
import { stageTerminalWorkspace } from "../src/terminal-workspace-stage.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-stage-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(path.join(project, "src"));
  const bytes = Buffer.from("alpha\r\n", "utf8");
  fs.writeFileSync(path.join(project, "src", "a.txt"), bytes);
  const files = new ProjectFiles(project);
  const expectedHead = "a".repeat(40);
  const options = {
    files,
    expectedHead,
    readHead: () => expectedHead,
    entries: [{ path: "src/a.txt", sha256: hash(bytes) }],
  };
  const plan = planTerminalWorkspaceSnapshot(options);
  return {
    bytes,
    options: {
      ...options,
      stateDir,
      approveLocalTransfer: true,
      expectedManifestSha256: plan.manifestSha256,
    },
  };
}

test(
  "local staging preserves bytes without touching the checkout",
  { skip: process.platform !== "linux" },
  (t) => {
    const { options, bytes } = fixture(t);
    const result = stageTerminalWorkspace(options);
    assert.equal(result.locallyStaged, true);
    assert.equal(result.containerTransferred, false);
    assert.equal(result.hostWriteBack, false);
    assert.equal(result.files, 1);
    assert.equal(result.bytes, bytes.length);
    assert.deepEqual(
      fs.readFileSync(path.join(result.directory, "src", "a.txt")),
      bytes,
    );
    assert.equal(fs.statSync(result.directory).mode & 0o077, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(options.files.root, "src", "a.txt")),
      bytes,
    );
  },
);

test(
  "stage rejects stale manifests and changed source without creating a directory",
  { skip: process.platform !== "linux" },
  (t) => {
    const { options } = fixture(t);
    assert.throws(
      () =>
        stageTerminalWorkspace({
          ...options,
          expectedManifestSha256: "b".repeat(64),
        }),
      /TERMINAL_STAGE_MANIFEST_MISMATCH/,
    );
    assert.throws(
      () => stageTerminalWorkspace({ ...options, approveLocalTransfer: false }),
      /TERMINAL_STAGE_OWNER_OPT_IN_REQUIRED/,
    );
    assert.throws(
      () =>
        stageTerminalWorkspace({ ...options, stateDir: options.files.root }),
      /TERMINAL_STAGE_ROOT_OVERLAP/,
    );
    fs.writeFileSync(path.join(options.files.root, "src", "a.txt"), "changed");
    assert.throws(() => stageTerminalWorkspace(options));
    assert.deepEqual(fs.readdirSync(options.stateDir), []);
  },
);

test(
  "unverified Windows private staging is denied",
  { skip: process.platform === "linux" },
  (t) => {
    const { options } = fixture(t);
    assert.throws(
      () => stageTerminalWorkspace(options),
      /TERMINAL_STAGE_PRIVATE_STORAGE_UNVERIFIED/,
    );
  },
);

test(
  "stage disposal removes only the owned directory and is idempotent",
  { skip: process.platform !== "linux" },
  (t) => {
    const { options } = fixture(t);
    const result = stageTerminalWorkspace(options);
    const neighbor = path.join(options.stateDir, "neighbor");
    fs.mkdirSync(neighbor);
    assert.deepEqual(result.dispose(), {
      removed: true,
      alreadyDisposed: false,
    });
    assert.deepEqual(result.dispose(), {
      removed: false,
      alreadyDisposed: true,
    });
    assert.equal(fs.existsSync(result.directory), false);
    assert.equal(fs.existsSync(neighbor), true);
  },
);

test(
  "stage disposal refuses a substituted directory",
  { skip: process.platform !== "linux" },
  (t) => {
    const { options } = fixture(t);
    const result = stageTerminalWorkspace(options);
    fs.renameSync(result.directory, result.directory + "-original");
    fs.mkdirSync(result.directory, { mode: 0o700 });
    const marker = path.join(result.directory, "preserve.txt");
    fs.writeFileSync(marker, "unrelated");
    assert.throws(
      () => result.dispose(),
      /TERMINAL_STAGE_CLEANUP_IDENTITY_CHANGED/,
    );
    assert.equal(fs.readFileSync(marker, "utf8"), "unrelated");
    assert.equal(fs.existsSync(result.directory + "-original"), true);
  },
);
