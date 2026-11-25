import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { verify, createPublicKey } from "node:crypto";
import { provisionReceiptKey } from "../src/hosted-receipt-key.js";
import { loadPilotSigner } from "../src/hosted-metering-pilot.js";
import { privateWindowsReceiptPath } from "../src/receipt-windows-custody.js";

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
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$ownerRule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)
$acl.AddAccessRule($ownerRule)
if ($env:KMJ_TEST_BROAD -eq '1') {
    $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', $inherit, $propagate, $allow)
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:KMJ_TEST_CUSTODY -AclObject $acl
`;
    const setAcl = (broad) => {
      const result = spawnSync(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          env: {
            SystemRoot: "C:\\Windows",
            KMJ_TEST_CUSTODY: custody,
            KMJ_TEST_BROAD: broad ? "1" : "0",
          },
          timeout: 15000,
          windowsHide: true,
          stdio: "ignore",
        },
      );
      assert.equal(result.status, 0, "fixture ACL setup failed");
    };
    setAcl(true);
    assert.equal(privateWindowsReceiptPath(custody, true), false);
    await assert.rejects(provisionReceiptKey(config, keyFile), /PATH_UNSAFE/);
    assert.equal(fs.existsSync(keyFile), false);
    setAcl(false);
    assert.equal(privateWindowsReceiptPath(custody, true), true);
    const first = await provisionReceiptKey(config, keyFile);
    assert.equal(first.created, true);
    assert.equal(first.publicKey.length, 44);
    assert.equal(privateWindowsReceiptPath(keyFile), true);
    const repeat = await provisionReceiptKey(config, keyFile);
    assert.equal(repeat.created, false);
    assert.equal(repeat.publicKey, first.publicKey);
  },
);
