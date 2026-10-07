import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { activateOwnerAdmin } from "../src/owner-admin-activation.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { owner: publicKey.export({ type: "spki", format: "pem" }) };
const now = 1800000000;

function lease(overrides = {}) {
  const claims = {
    v: 1,
    product: "KMJ_CODEBRIDGE",
    tenant: "tenant1",
    device: "device1",
    license_id: "license1",
    activation_id: "activation1",
    jti: "owner-activation-1",
    sequence: 1,
    iat: now - 60,
    nbf: now - 60,
    exp: now + 3600,
    grace_until: now + 3660,
    features: ["read", "write", "execute"],
    limits: { devices: 2147483647, concurrent_jobs: 16 },
    ...overrides,
  };
  const encoded = [
    { alg: "EdDSA", kid: "owner", typ: "JWT" },
    claims,
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return encoded + "." + sign(null, Buffer.from(encoded), privateKey).toString("base64url");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-owner-"));
  const project = path.join(root, "project");
  const secrets = path.join(root, "private");
  fs.mkdirSync(project);
  fs.mkdirSync(secrets, { mode: 0o700 });
  const configPath = path.join(secrets, "agent.json");
  const publicKeysPath = path.join(secrets, "keys.json");
  const credentialPath = path.join(secrets, "credential");
  const original = {
    gateway: "https://kmjtechno.com/",
    token: "x".repeat(40),
    id: "device1",
    tenant: "tenant1",
    stateDir: path.join(secrets, "state"),
    pollMs: 100,
    projects: [{ id: "project1", root: project, writable: true, gates: {} }],
    license: { mode: "free" },
  };
  fs.writeFileSync(configPath, JSON.stringify(original), { mode: 0o600 });
  fs.writeFileSync(publicKeysPath, JSON.stringify(keys), { mode: 0o600 });
  fs.writeFileSync(credentialPath, "c".repeat(48), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, configPath, publicKeysPath, credentialPath, original };
}

function mockFetch(token = lease()) {
  return async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).sequence, -1);
    return new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("real signed owner lease switches free agent safely and preserves grants", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const result = await activateOwnerAdmin(f, { fetch: mockFetch(), now });
  assert.equal(result.activated, true);
  assert.equal(result.signedConcurrentJobs, 16);
  assert.equal(result.restartRequired, true);
  const config = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  assert.equal(config.license.mode, "signed");
  assert.deepEqual(config.projects, f.original.projects);
  assert.equal(config.token, f.original.token);
  assert.equal(config.license.renewal.endpoint, "https://kmjtechno.com/api/v1/codebridge/renew");
  assert.equal(config.license.renewal.credential, "c".repeat(48));
  assert.equal(fs.readFileSync(config.license.tokenFile, "utf8").trim(), lease());
  assert.equal(fs.statSync(config.license.tokenFile).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, "utf8")), f.original);
  await assert.rejects(() => activateOwnerAdmin(f, { fetch: mockFetch(), now }), /OWNER_ADMIN_ALREADY_SIGNED/);
});

test("rejects unapproved plan, wrong device, forged lease and bad credentials before any write", { skip: process.platform === "win32" }, async (t) => {
  const cases = [
    lease({ limits: { devices: 3, concurrent_jobs: 2 } }),
    lease({ device: "different" }),
    lease().slice(0, -4) + "abcd",
  ];
  for (const token of cases) {
    const f = fixture(t);
    await assert.rejects(() => activateOwnerAdmin(f, { fetch: mockFetch(token), now }), /LICENSE|OWNER_ADMIN/);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).license.mode, "free");
    assert.equal(fs.existsSync(f.configPath + ".entitlement.jws"), false);
    assert.equal(fs.existsSync(f.configPath + ".before-owner-admin.bak"), false);
  }
});

test("rejects insecure credential and symlink before making any renewal request", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.credentialPath, 0o644);
  let called = false;
  const fake = async () => { called = true; throw Error("should not call"); };
  await assert.rejects(() => activateOwnerAdmin(f, { fetch: fake, now }), /OWNER_ADMIN_INSECURE_PERMISSIONS/);
  assert.equal(called, false);
  fs.chmodSync(f.credentialPath, 0o600);
  fs.renameSync(f.credentialPath, f.credentialPath + ".real");
  fs.symlinkSync(f.credentialPath + ".real", f.credentialPath);
  await assert.rejects(() => activateOwnerAdmin(f, { fetch: fake, now }), /OWNER_ADMIN_INVALID_FILE/);
  assert.equal(called, false);
});

test("rejects missing owner entitlement and leaves original free mode untouched", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const fake = async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 });
  await assert.rejects(() => activateOwnerAdmin(f, { fetch: fake, now }), /LICENSE_RENEWAL_UNAVAILABLE/);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).license.mode, "free");
});
