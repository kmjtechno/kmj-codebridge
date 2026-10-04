import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activateReleaseWithHealthCheck,
  prepareVerifiedRelease,
} from "../src/update-orchestrator.js";

function manifest() {
  return {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 7,
    version: "0.2.3",
    revision: "a".repeat(40),
    archive: "https://downloads.kmjtechno.com/codebridge/0.2.3.tar.gz",
    sha256: "b".repeat(64),
    bytes: 123,
    nodeMajor: 24,
    publishedAt: "2026-10-04T00:00:00Z",
    keyId: "release-2026",
  };
}

test("prepareVerifiedRelease composes verify, download, extract and immutable finalize", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orchestrator-"));
  const workDir = path.join(root, "work");
  const staging = path.join(root, "staging");
  fs.mkdirSync(workDir);
  fs.mkdirSync(staging);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const archive = path.join(workDir, "runtime.tar.gz");
  fs.writeFileSync(archive, "archive");
  const m = manifest();
  const calls = [];
  const store = {
    staging(value) {
      calls.push(["staging", value.version]);
      return { name: "0.2.3-aaaaaaaaaaaa", staging };
    },
    finalize(value, target) {
      calls.push(["finalize", value.version, target]);
      return {
        name: "0.2.3-aaaaaaaaaaaa",
        target: path.join(root, "releases", "0.2.3-aaaaaaaaaaaa"),
      };
    },
  };

  const result = await prepareVerifiedRelease({
    rawManifest: Buffer.from(JSON.stringify(m)),
    signature: "signature",
    trustedKeys: { "release-2026": "key" },
    minimumSequence: 6,
    store,
    workDir,
    verifyManifest: () => {
      calls.push(["verify"]);
      return m;
    },
    download: async () => {
      calls.push(["download"]);
      return { path: archive, bytes: 7, sha256: m.sha256 };
    },
    extract: (archivePath, target, value) => {
      calls.push(["extract", archivePath, target, value.version]);
      fs.mkdirSync(path.join(target, "src"));
      fs.writeFileSync(path.join(target, "package.json"), "{}");
      fs.writeFileSync(path.join(target, "src", "cli.js"), "export {};\n");
      return { root: "kmj-codebridge-0.2.3-aaaaaaaaaaaa", entries: 3 };
    },
  });

  assert.equal(result.manifest, m);
  assert.equal(result.release.name, "0.2.3-aaaaaaaaaaaa");
  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ["verify", "staging", "download", "extract", "finalize"],
  );
  assert.equal(
    fs.existsSync(archive),
    false,
    "verified download is cleaned up",
  );
});

test("prepareVerifiedRelease removes partial staging and download after failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orchestrator-fail-"));
  const workDir = path.join(root, "work");
  const staging = path.join(root, "staging");
  fs.mkdirSync(workDir);
  fs.mkdirSync(staging);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const archive = path.join(workDir, "runtime.tar.gz");
  fs.writeFileSync(archive, "archive");
  const m = manifest();
  const store = {
    staging: () => ({ name: "0.2.3-aaaaaaaaaaaa", staging }),
    finalize: () => assert.fail("finalize must not run"),
  };

  await assert.rejects(
    prepareVerifiedRelease({
      rawManifest: Buffer.from("{}"),
      signature: "signature",
      trustedKeys: {},
      store,
      workDir,
      verifyManifest: () => m,
      download: async () => ({ path: archive }),
      extract: () => {
        fs.writeFileSync(path.join(staging, "partial"), "x");
        throw new Error("extract failed");
      },
    }),
    /extract failed/,
  );
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(staging), false);
});

function fakeStore({ current = "0.2.2-aaaaaaaaaaaa", previous = null } = {}) {
  const state = { current, previous };
  const actions = [];
  return {
    actions,
    state,
    status: () => ({ ...state, history: [] }),
    activate(name) {
      actions.push(["activate", name]);
      if (state.current === name)
        return {
          changed: false,
          current: state.current,
          previous: state.previous,
        };
      const old = state.current;
      state.previous = old;
      state.current = name;
      return { changed: true, current: name, previous: old };
    },
    rollback() {
      actions.push(["rollback"]);
      if (!state.previous) throw new Error("no previous");
      const old = state.current;
      state.current = state.previous;
      state.previous = old;
      return { current: state.current, previous: state.previous };
    },
  };
}

test("healthy activation restarts once and keeps the new release", async () => {
  const store = fakeStore();
  let restarts = 0;
  let checks = 0;
  const result = await activateReleaseWithHealthCheck({
    store,
    releaseName: "0.2.3-bbbbbbbbbbbb",
    restart: async () => {
      restarts += 1;
    },
    healthCheck: async () => {
      checks += 1;
      return true;
    },
    attempts: 3,
    sleep: async () => {},
  });
  assert.deepEqual(result, {
    changed: true,
    current: "0.2.3-bbbbbbbbbbbb",
    previous: "0.2.2-aaaaaaaaaaaa",
    healthy: true,
  });
  assert.equal(restarts, 1);
  assert.equal(checks, 1);
  assert.deepEqual(store.actions, [["activate", "0.2.3-bbbbbbbbbbbb"]]);
});

test("failed new release rolls back, restarts previous and reports failure", async () => {
  const store = fakeStore();
  let restarts = 0;
  const health = [false, false, true];
  await assert.rejects(
    activateReleaseWithHealthCheck({
      store,
      releaseName: "0.2.3-bbbbbbbbbbbb",
      restart: async () => {
        restarts += 1;
      },
      healthCheck: async () => health.shift() ?? false,
      attempts: 2,
      sleep: async () => {},
    }),
    /UPDATE_ACTIVATION_ROLLED_BACK/,
  );
  assert.equal(restarts, 2);
  assert.equal(store.state.current, "0.2.2-aaaaaaaaaaaa");
  assert.deepEqual(store.actions, [
    ["activate", "0.2.3-bbbbbbbbbbbb"],
    ["rollback"],
  ]);
});

test("rollback health failure fails closed", async () => {
  const store = fakeStore();
  await assert.rejects(
    activateReleaseWithHealthCheck({
      store,
      releaseName: "0.2.3-bbbbbbbbbbbb",
      restart: async () => {},
      healthCheck: async () => false,
      attempts: 1,
      sleep: async () => {},
    }),
    /UPDATE_ROLLBACK_HEALTH_FAILED/,
  );
  assert.equal(store.state.current, "0.2.2-aaaaaaaaaaaa");
});

test("unhealthy activation without previous release cannot pretend rollback", async () => {
  const store = fakeStore({ current: null, previous: null });
  await assert.rejects(
    activateReleaseWithHealthCheck({
      store,
      releaseName: "0.2.3-bbbbbbbbbbbb",
      restart: async () => {},
      healthCheck: async () => false,
      attempts: 1,
      sleep: async () => {},
    }),
    /UPDATE_ACTIVATION_HEALTH_FAILED/,
  );
});

test("prepareVerifiedRelease runs preflight before immutable finalize", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-preflight-"));
  const workDir = path.join(root, "work");
  const staging = path.join(root, "staging");
  fs.mkdirSync(workDir);
  fs.mkdirSync(staging);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const archive = path.join(workDir, "runtime.tar.gz");
  fs.writeFileSync(archive, "archive");
  const m = manifest();
  let finalized = false;

  await assert.rejects(
    prepareVerifiedRelease({
      rawManifest: Buffer.from("{}"),
      signature: "signature",
      trustedKeys: {},
      store: {
        staging: () => ({ name: "0.2.3-aaaaaaaaaaaa", staging }),
        finalize: () => {
          finalized = true;
        },
      },
      workDir,
      verifyManifest: () => m,
      download: async () => ({ path: archive }),
      extract: () => {
        fs.mkdirSync(path.join(staging, "src"));
        fs.writeFileSync(path.join(staging, "package.json"), "{}");
        fs.writeFileSync(path.join(staging, "src", "cli.js"), "export {};\n");
      },
      preflight: async () => false,
    }),
    /UPDATE_PREFLIGHT_FAILED/,
  );

  assert.equal(finalized, false);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(archive), false);
});

test("rollback operation failure returns a structured fail-closed error", async () => {
  const store = fakeStore();
  store.rollback = () => {
    throw new Error("disk failure");
  };
  await assert.rejects(
    activateReleaseWithHealthCheck({
      store,
      releaseName: "0.2.3-bbbbbbbbbbbb",
      restart: async () => {},
      healthCheck: async () => false,
      attempts: 1,
      sleep: async () => {},
    }),
    /UPDATE_ROLLBACK_FAILED/,
  );
});
