import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { ReleaseStore } from "../src/release-store.js";
import {
  runStableUpdate,
  readAcceptedUpdateState,
} from "../src/stable-updater.js";

for (const failure of [
  "new-runtime-unhealthy",
  "restart-rejected",
  "wrong-rollback-identity",
]) {
  test(`signed update recovery checks the previous identity after ${failure}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-signed-recovery-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const manifest = {
      schema: 1,
      product: "KMJ CodeBridge",
      channel: "beta",
      sequence: 4,
      version: "0.3.2",
      revision: "b".repeat(40),
      archive: "https://updates.example/runtime.tar.gz",
      sha256: "c".repeat(64),
      bytes: 100,
      nodeMajor: 24,
      publishedAt: "2026-10-16T00:00:00Z",
      keyId: "beta",
    };
    const previous = {
      ...manifest,
      sequence: 3,
      revision: "a".repeat(40),
      sha256: "d".repeat(64),
    };
    const cfg = {
      schema: 1,
      channel: "beta",
      manifestUrl: "https://updates.example/manifest.json",
      signatureUrl: "https://updates.example/manifest.sig",
      trustedKeys: { beta: publicKey.export({ type: "spki", format: "pem" }) },
      installRoot: path.join(root, "install"),
      stateDir: path.join(root, "state"),
      agentStateDir: path.join(root, "agent-state"),
      workDir: path.join(root, "work"),
      health: { attempts: 1, delayMs: 100 },
    };
    fs.mkdirSync(cfg.agentStateDir);
    const store = new ReleaseStore(cfg);
    const stage = (m) => {
      const name = `${m.version}-${m.revision.slice(0, 12)}`;
      const target = path.join(store.releases, name);
      fs.mkdirSync(target);
      fs.writeFileSync(
        path.join(target, ".codebridge-release.json"),
        JSON.stringify({
          schema: 1,
          version: m.version,
          revision: m.revision,
          sequence: m.sequence,
          sha256: m.sha256,
        }),
      );
      return { name, target };
    };
    const old = stage(previous);
    store.activate(old.name);
    const rawManifest = Buffer.from(JSON.stringify(manifest));
    const signature = sign(null, rawManifest, privateKey).toString("base64url");
    let restarts = 0;
    await assert.rejects(
      runStableUpdate(cfg, {
        createStore: () => store,
        fetchBytes: async (url) =>
          url === cfg.manifestUrl ? rawManifest : Buffer.from(signature),
        prepare: async () => ({ release: stage(manifest) }),
        restartRequest: async (_socket, request) => {
          assert.deepEqual(request, { op: "restart", service: "agent" });
          restarts++;
          if (restarts === 1 && failure === "restart-rejected")
            throw Error("restart rejected");
          const identity =
            store.status().current === old.name ? previous : manifest;
          const invalid =
            restarts === 1 || failure === "wrong-rollback-identity";
          fs.writeFileSync(
            path.join(cfg.agentStateDir, "connection.json"),
            JSON.stringify({
              connectedAt: new Date(2000).toISOString(),
              version: identity.version,
              release: {
                sequence: identity.sequence,
                version: identity.version,
                revision: identity.revision,
                sha256: invalid ? "e".repeat(64) : identity.sha256,
              },
            }),
          );
          return { accepted: true, service: "agent" };
        },
        now: () => 1000,
        sleep: async () => {},
        nodeMajor: 24,
      }),
      failure === "wrong-rollback-identity"
        ? /UPDATE_ROLLBACK_HEALTH_FAILED/
        : /UPDATE_ACTIVATION_ROLLED_BACK/,
    );
    assert.equal(restarts, 2);
    assert.equal(store.status().current, "0.3.2-aaaaaaaaaaaa");
    assert.equal(store.status().previous, "0.3.2-bbbbbbbbbbbb");
    assert.equal(readAcceptedUpdateState(cfg.stateDir), null);
  });
}
