import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { verify, createPublicKey } from "node:crypto";
import { provisionReceiptKey } from "../src/hosted-receipt-key.js";
import { loadPilotSigner } from "../src/hosted-metering-pilot.js";
import {
  privateWindowsReceiptPath,
  windowsReceiptPathStatus,
} from "../src/receipt-windows-custody.js";

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

test(
  "native Windows custody rejects inherited or broad ACLs before key creation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "kmj-receipt-acl-")),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    const custody = path.join(root, "custody");
    for (const dir of [project, state, custody]) fs.mkdirSync(dir);
    const keyFile = path.join(custody, "receipt.key");
    const config = {
      id: "device-a",
      tenant: "tenant-a",
      stateDir: state,
      projects: [{ id: "project-a", root: project }],
    };
    const system32 = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
    );
    const run = (exe, args) => {
      const result = spawnSync(path.join(system32, exe), args, {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      });
      assert.equal(result.error?.code, undefined, "fixture command failed");
      assert.equal(result.status, 0, "fixture ACL setup failed");
      return result.stdout;
    };
    const identity = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = identity.match(/"(S-1-[0-9-]+)"\s*$/)?.[1];
    assert.ok(sid, "fixture owner SID missing");
    run("icacls.exe", [custody, "/setowner", "*" + sid]);
    run("icacls.exe", [custody, "/grant:r", "*" + sid + ":(OI)(CI)F"]);
    run("icacls.exe", [custody, "/inheritance:r"]);
    const setAcl = (broad) => {
      if (broad) {
        run("icacls.exe", [custody, "/grant:r", "*S-1-1-0:(OI)(CI)RX"]);
      } else {
        run("icacls.exe", [custody, "/remove:g", "*S-1-1-0"]);
      }
    };
    setAcl(true);
    assert.equal(windowsReceiptPathStatus(custody, true), "PRINCIPAL_UNSAFE");
    await assert.rejects(provisionReceiptKey(config, keyFile), /PATH_UNSAFE/);
    assert.equal(fs.existsSync(keyFile), false);
    setAcl(false);
    assert.equal(windowsReceiptPathStatus(custody, true), "PRIVATE");
    const first = await provisionReceiptKey(config, keyFile);
    assert.equal(first.created, true);
    assert.equal(first.publicKey.length, 44);
    assert.equal(privateWindowsReceiptPath(keyFile), true);
    const repeat = await provisionReceiptKey(config, keyFile);
    assert.equal(repeat.created, false);
    assert.equal(repeat.publicKey, first.publicKey);
  },
);
