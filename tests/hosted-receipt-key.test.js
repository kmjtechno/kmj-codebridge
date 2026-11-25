import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verify, createPublicKey } from "node:crypto";
import { provisionReceiptKey } from "../src/hosted-receipt-key.js";
import { loadPilotSigner } from "../src/hosted-metering-pilot.js";

test(
  "private POSIX signer provisioning is idempotent and never returns private key",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-receipt-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const custody = path.join(root, "custody");
    for (const dir of [project, state, custody])
      fs.mkdirSync(dir, { mode: 0o700 });
    const keyFile = path.join(custody, "receipt.key");
    const config = {
      id: "device-a",
      tenant: "tenant-a",
      stateDir: state,
      projects: [{ id: "project-a", root: project }],
    };
    const first = await provisionReceiptKey(config, keyFile);
    const original = fs.readFileSync(keyFile);
    assert.equal(first.created, true);
    assert.equal(first.enrollment, "OWNER_PIN_REQUIRED");
    assert.equal(first.publicKey.length, 44);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    const repeat = await provisionReceiptKey(config, keyFile);
    assert.equal(repeat.created, false);
    assert.equal(repeat.publicKey, first.publicKey);
    assert.deepEqual(fs.readFileSync(keyFile), original);
    const signer = await loadPilotSigner({
      ...config,
      hostedReceiptKeyFile: keyFile,
    });
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(first.publicKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    assert.equal(
      verify(
        null,
        Buffer.from("receipt"),
        key,
        Buffer.from(signer("receipt"), "base64"),
      ),
      true,
    );
    await assert.rejects(
      provisionReceiptKey(config, path.join(project, "receipt.key")),
      /PATH_UNSAFE/,
    );
    await assert.rejects(
      provisionReceiptKey(config, path.join(state, "receipt.key")),
      /PATH_UNSAFE/,
    );
  },
);
