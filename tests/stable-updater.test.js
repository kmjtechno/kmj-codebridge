import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  freshAuthenticatedConnection,
  readAcceptedUpdateState,
  runStableUpdate,
} from "../src/stable-updater.js";
import { releaseDirectoryName } from "../src/update.js";

function signedFixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 42,
    version: "0.2.3",
    revision: "a".repeat(40),
    archive: "https://downloads.kmjtechno.com/codebridge/runtime.tar.gz",
    sha256: "b".repeat(64),
    bytes: 123,
    nodeMajor: 24,
    publishedAt: "2026-10-05T00:00:00Z",
    keyId: "release-2026",
    ...overrides,
  };
  const rawManifest = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, rawManifest, privateKey).toString("base64url");
  return {
    manifest,
    rawManifest,
    signature,
    trustedKeys: {
      "release-2026": publicKey.export({ type: "spki", format: "pem" }),
    },
  };
}

function config(root, trustedKeys, overrides = {}) {
  return {
    schema: 1,
    channel: "stable",
    manifestUrl: "https://updates.example/codebridge/manifest.json",
    signatureUrl: "https://updates.example/codebridge/manifest.sig",
    trustedKeys,
    installRoot: path.join(root, "install"),
    stateDir: path.join(root, "state"),
    workDir: path.join(root, "work"),
    supervisorSocket: "/run/kmj-codebridge/supervisor.sock",
    health: { attempts: 3, delayMs: 100 },
    ...overrides,
  };
}

function fakeStore(root, current = null) {
  const releases = path.join(root, "install", "releases");
  fs.mkdirSync(releases, { recursive: true });
  return {
    releases,
    status: () => ({ current, previous: null, history: [] }),
  };
}

function writeMarker(store, manifest) {
  const name = releaseDirectoryName(manifest);
  const target = path.join(store.releases, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, ".codebridge-release.json"),
    JSON.stringify({
      schema: 1,
      version: manifest.version,
      revision: manifest.revision,
      sequence: manifest.sequence,
      sha256: manifest.sha256,
    }) + "\n",
  );
  return name;
}

test("stable updater uses fixed Supervisor restart and fresh authenticated reconnect", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stable-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const cfg = config(root, signed.trustedKeys);
  const store = fakeStore(root);
  const fetches = [];
  const restarts = [];
  let nowCall = 0;

  const result = await runStableUpdate(cfg, {
    fetchBytes: async (url) => {
      fetches.push(url);
      return Buffer.from(
        url.endsWith(".sig") ? signed.signature : signed.rawManifest,
      );
    },
    createStore: () => store,
    prepare: async ({ preflight }) => {
      const staging = path.join(root, "staging");
      fs.mkdirSync(path.join(staging, "src"), { recursive: true });
      for (const relative of [
        "cli.js",
        "agent.js",
        "supervisor.js",
        "supervisor-client.js",
      ])
        fs.writeFileSync(
          path.join(staging, "src", relative),
          "export {};\n",
        );
      assert.equal(await preflight({ stagingDir: staging }), true);
      return {
        release: {
          name: releaseDirectoryName(signed.manifest),
          target: path.join(store.releases, releaseDirectoryName(signed.manifest)),
        },
      };
    },
    activate: async ({
      releaseName,
      restart,
      healthCheck,
    }) => {
      await restart();
      fs.writeFileSync(
        path.join(cfg.stateDir, "connection.json"),
        JSON.stringify({
          connectedAt: new Date(2000).toISOString(),
          version: signed.manifest.version,
          release: {
            sequence: signed.manifest.sequence,
            version: signed.manifest.version,
            revision: signed.manifest.revision,
            sha256: signed.manifest.sha256,
          },
        }) + "\n",
      );
      assert.equal(await healthCheck(), true);
      return {
        changed: true,
        current: releaseName,
        previous: "0.2.2-cccccccccccc",
        healthy: true,
      };
    },
    restartRequest: async (socket, request) => {
      restarts.push([socket, request]);
      return { service: "agent", accepted: true };
    },
    now: () => (nowCall++ === 0 ? 1000 : 3000),
    sleep: async () => {},
  });

  assert.deepEqual(fetches, [
    cfg.manifestUrl,
    cfg.signatureUrl,
  ]);
  assert.deepEqual(restarts, [
    [
      "/run/kmj-codebridge/supervisor.sock",
      { op: "restart", service: "agent" },
    ],
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.healthy, true);
  assert.equal(result.sequence, 42);
  assert.equal(result.version, "0.2.3");

  const accepted = readAcceptedUpdateState(cfg.stateDir);
  assert.equal(accepted.sequence, 42);
  assert.equal(accepted.version, "0.2.3");
  assert.equal(accepted.revision, signed.manifest.revision);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(path.join(cfg.stateDir, "stable-update-state.json")).mode & 0o777, 0o600);
});

test("stable updater is idempotent for the exact already-current signed release", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stable-current-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const cfg = config(root, signed.trustedKeys);
  const store = fakeStore(root);
  const name = writeMarker(store, signed.manifest);
  store.status = () => ({ current: name, previous: null, history: [] });
  let prepared = false;
  let activated = false;

  const result = await runStableUpdate(cfg, {
    fetchBytes: async (url) =>
      Buffer.from(url.endsWith(".sig") ? signed.signature : signed.rawManifest),
    createStore: () => store,
    prepare: async () => {
      prepared = true;
      throw new Error("must not prepare current release");
    },
    activate: async () => {
      activated = true;
      throw new Error("must not activate current release");
    },
  });

  assert.deepEqual(result, {
    updated: false,
    current: name,
    sequence: 42,
    version: "0.2.3",
  });
  assert.equal(prepared, false);
  assert.equal(activated, false);
});

test("stable updater rejects channel mismatch and replay", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stable-reject-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const store = fakeStore(root);

  await assert.rejects(
    runStableUpdate(config(root, signed.trustedKeys, { channel: "beta" }), {
      fetchBytes: async (url) =>
        Buffer.from(url.endsWith(".sig") ? signed.signature : signed.rawManifest),
      createStore: () => store,
    }),
    /UPDATE_CHANNEL_MISMATCH/,
  );

  const newer = signedFixture({ sequence: 43, revision: "c".repeat(40) });
  const currentName = writeMarker(store, newer.manifest);
  store.status = () => ({
    current: currentName,
    previous: null,
    history: [],
  });

  await assert.rejects(
    runStableUpdate(config(root, signed.trustedKeys), {
      fetchBytes: async (url) =>
        Buffer.from(url.endsWith(".sig") ? signed.signature : signed.rawManifest),
      createStore: () => store,
    }),
    /UPDATE_ROLLBACK_REJECTED/,
  );
});

test("stable updater fails closed on malformed accepted state before network fetch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stable-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const cfg = config(root, signed.trustedKeys);
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfg.stateDir, "stable-update-state.json"),
    "{broken\n",
  );
  let fetched = false;

  await assert.rejects(
    runStableUpdate(cfg, {
      fetchBytes: async () => {
        fetched = true;
        return Buffer.alloc(0);
      },
      createStore: () => fakeStore(root),
    }),
    /UPDATE_STATE_INVALID/,
  );
  assert.equal(fetched, false);
});

test("fresh authenticated connection requires time and expected signed runtime identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-stable-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signed = signedFixture();
  fs.writeFileSync(
    path.join(root, "connection.json"),
    JSON.stringify({
      connectedAt: new Date(1000).toISOString(),
      version: signed.manifest.version,
      release: {
        sequence: signed.manifest.sequence,
        version: signed.manifest.version,
        revision: signed.manifest.revision,
        sha256: signed.manifest.sha256,
      },
    }) + "\n",
  );
  assert.equal(freshAuthenticatedConnection(root, 1000), true);
  assert.equal(freshAuthenticatedConnection(root, 1001), false);
  assert.equal(
    freshAuthenticatedConnection(root, 1000, signed.manifest),
    true,
  );
  assert.equal(
    freshAuthenticatedConnection(root, 1000, {
      ...signed.manifest,
      revision: "d".repeat(40),
    }),
    false,
  );
});
