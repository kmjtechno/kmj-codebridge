import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ReleaseStore } from "../src/release-store.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-release-store-"));
  const installRoot = path.join(root, "install");
  const stateDir = path.join(root, "state");
  const store = new ReleaseStore({ installRoot, stateDir, maxHistory: 10 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, installRoot, stateDir, store };
}

function manifest(version, revisionChar) {
  const archive = Buffer.from(`archive-${version}`);
  return {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: Number(version.split(".")[1] ?? 0),
    version,
    revision: revisionChar.repeat(40),
    archive: `https://downloads.kmjtechno.com/codebridge/${version}.tar.gz`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt: "2026-10-03T00:00:00Z",
    keyId: "release-2026",
  };
}

function stageRuntime(store, releaseManifest) {
  const staged = store.staging(releaseManifest);
  fs.mkdirSync(path.join(staged.staging, "src"));
  fs.writeFileSync(
    path.join(staged.staging, "package.json"),
    JSON.stringify({
      name: "@kmjtechno/codebridge",
      version: releaseManifest.version,
    }),
  );
  fs.writeFileSync(path.join(staged.staging, "src", "cli.js"), "export {};\n");
  return store.finalize(releaseManifest, staged.staging);
}

test("finalizes a validated staged runtime into an immutable release identity", (t) => {
  const { store } = setup(t);
  const m = manifest("0.2.0", "a");
  const finalized = stageRuntime(store, m);
  assert.match(finalized.name, /^0\.2\.0-a{12}$/);
  assert.equal(
    fs.existsSync(path.join(finalized.target, "src", "cli.js")),
    true,
  );
  const marker = JSON.parse(
    fs.readFileSync(path.join(finalized.target, ".codebridge-release.json")),
  );
  assert.equal(marker.revision, m.revision);
  assert.equal(marker.sequence, m.sequence);
  assert.equal(marker.sha256, m.sha256);
});

test("rejects malformed staged runtime and staging paths outside release root", (t) => {
  const { store, root } = setup(t);
  const m = manifest("0.2.0", "b");
  const staged = store.staging(m);
  fs.writeFileSync(path.join(staged.staging, "package.json"), "{}");
  assert.throws(
    () => store.finalize(m, staged.staging),
    /UPDATE_STAGED_RUNTIME_INVALID/,
  );
  assert.throws(
    () => store.finalize(m, path.join(root, "outside")),
    /UPDATE_STAGING_PATH_INVALID/,
  );
});

test(
  "activation is atomic, idempotent and preserves previous known-good",
  { skip: process.platform === "win32" },
  (t) => {
    const { store } = setup(t);
    const first = stageRuntime(store, manifest("0.2.0", "c"));
    const second = stageRuntime(store, manifest("0.3.0", "d"));

    assert.deepEqual(store.activate(first.name), {
      changed: true,
      current: first.name,
      previous: null,
    });
    assert.deepEqual(store.activate(second.name), {
      changed: true,
      current: second.name,
      previous: first.name,
    });
    assert.deepEqual(store.activate(second.name), {
      changed: false,
      current: second.name,
      previous: first.name,
    });
    assert.equal(store.status().current, second.name);
    assert.equal(store.status().previous, first.name);
  },
);

test(
  "rollback swaps current and previous release and records bounded history",
  { skip: process.platform === "win32" },
  (t) => {
    const { store } = setup(t);
    const first = stageRuntime(store, manifest("0.2.0", "e"));
    const second = stageRuntime(store, manifest("0.3.0", "f"));
    store.activate(first.name);
    store.activate(second.name);

    assert.deepEqual(store.rollback(), {
      current: first.name,
      previous: second.name,
    });
    const status = store.status();
    assert.equal(status.current, first.name);
    assert.equal(status.previous, second.name);
    assert.equal(status.history.at(-1).action, "rollback");
  },
);

test("Windows activation fails closed rather than using a non-atomic replacement", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific contract");
    return;
  }
  const { store } = setup(t);
  const first = stageRuntime(store, manifest("0.2.0", "9"));
  assert.throws(
    () => store.activate(first.name),
    /UPDATE_ACTIVATION_UNSUPPORTED/,
  );
});

test("managed links fail closed when replaced by an ordinary file", (t) => {
  const { store, installRoot } = setup(t);
  fs.writeFileSync(path.join(installRoot, "current"), "not-a-managed-link");
  assert.throws(() => store.status(), /UPDATE_RELEASE_LINK_INVALID/);
});

test("finalize refuses duplicate immutable release directories", (t) => {
  const { store } = setup(t);
  const m = manifest("0.2.0", "1");
  stageRuntime(store, m);
  assert.throws(() => store.staging(m), /UPDATE_RELEASE_EXISTS/);
});
