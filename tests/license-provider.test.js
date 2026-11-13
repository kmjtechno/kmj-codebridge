import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { createLicenseProvider } from "../src/license-provider.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }) };
const T = 1800000000;
const base = {
  v: 1,
  product: "KMJ_CODEBRIDGE",
  tenant: "t1",
  device: "d1",
  license_id: "l1",
  activation_id: "a1",
  jti: "j1",
  sequence: 1,
  iat: T - 100,
  nbf: T - 100,
  exp: T + 100,
  grace_until: T + 200,
  features: ["read", "write", "execute"],
  limits: { devices: 3, concurrent_jobs: 4 },
};
function token(change = {}) {
  const body = [
    { alg: "EdDSA", kid: "k1", typ: "JWT" },
    { ...base, ...change },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    body + "." + sign(null, Buffer.from(body), privateKey).toString("base64url")
  );
}
function setup(fallbackToFree, jws, onTransition) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-licprov-"));
  const tokenFile = path.join(dir, "license.jws");
  if (jws !== undefined) fs.writeFileSync(tokenFile, jws);
  const clock = { now: T };
  const c = {
    id: "d1",
    tenant: "t1",
    license: { mode: "signed", tokenFile, keys, fallbackToFree },
  };
  const provider = createLicenseProvider(c, dir, {
    now: () => clock.now,
    onTransition,
  });
  return { dir, tokenFile, clock, provider };
}

test("active lease returns its own entitlement and persists the sequence", () => {
  const { dir, provider } = setup(false, token());
  const e = provider();
  assert.equal(e.state, "ACTIVE");
  assert.equal(e.limits.concurrent_jobs, 4);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "license-state.json"), "utf8"))
      .sequence,
    1,
  );
});

test("expired lease locks out unless fallbackToFree is set", () => {
  const lapsed = token({ exp: T - 20, grace_until: T - 10 });
  assert.throws(() => setup(false, lapsed).provider(), /LICENSE_EXPIRED/);
  const e = setup(true, lapsed).provider();
  assert.equal(e.state, "FREE_FALLBACK");
  assert.equal(e.reason, "LICENSE_EXPIRED");
  assert.equal(e.limits.concurrent_jobs, 1);
  assert.deepEqual(e.features, ["read", "write", "execute"]);
});

test("revoked lease falls back to Free and the revoke blocks an older token", () => {
  const { tokenFile, provider } = setup(
    true,
    token({ status: "REVOKED", sequence: 5 }),
  );
  const e = provider();
  assert.equal(e.state, "FREE_FALLBACK");
  assert.equal(e.reason, "LICENSE_REVOKED");
  // Swapping an older, still valid ACTIVE token back in must not undo the revoke.
  fs.writeFileSync(tokenFile, token({ sequence: 4 }));
  assert.throws(() => provider(), /LICENSE_REPLAY/);
  // A strictly newer ACTIVE token reactivates.
  fs.writeFileSync(tokenFile, token({ sequence: 6 }));
  assert.equal(provider().state, "ACTIVE");
});

test("revoked lease without fallback is refused", () => {
  assert.throws(
    () => setup(false, token({ status: "REVOKED", sequence: 2 })).provider(),
    /LICENSE_REVOKED/,
  );
});

test("fallback never masks tampering, wrong binding, rollback or a missing token", () => {
  const good = token();
  const parts = good.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...base, sequence: 99 })).toString(
    "base64url",
  );
  assert.throws(
    () => setup(true, parts.join(".")).provider(),
    /LICENSE_INVALID/,
  );
  assert.throws(
    () => setup(true, token({ device: "other" })).provider(),
    /LICENSE_INVALID/,
  );
  assert.throws(() => setup(true).provider(), /ENOENT/);
  const rolled = setup(true, token());
  rolled.provider();
  rolled.clock.now = T - 3600;
  assert.throws(() => rolled.provider(), /LICENSE_CLOCK_ROLLBACK/);
});

test("free mode is unchanged and returns fresh objects", () => {
  const p = createLicenseProvider(
    { id: "d1", tenant: "t1", license: { mode: "free" } },
    fs.mkdtempSync(path.join(os.tmpdir(), "cb-licprov-free-")),
  );
  const a = p();
  a.limits.concurrent_jobs = 99;
  assert.equal(p().limits.concurrent_jobs, 1);
});

test("state changes are reported once, first ACTIVE is silent, hook errors are ignored", () => {
  const events = [];
  const { tokenFile, clock, provider } = setup(true, token(), (e) =>
    events.push(e),
  );
  provider();
  provider();
  assert.deepEqual(events, []);
  fs.writeFileSync(tokenFile, token({ sequence: 2, status: "REVOKED" }));
  assert.equal(provider().state, "FREE_FALLBACK");
  provider();
  assert.deepEqual(events, [
    { from: "ACTIVE", to: "FREE_FALLBACK", code: "LICENSE_REVOKED" },
  ]);
  clock.now = T;
  const thrower = setup(true, token(), () => {
    throw new Error("boom");
  });
  assert.equal(thrower.provider().state, "ACTIVE");
});

test("hard failures are reported as DENIED with the code only", () => {
  const events = [];
  const { provider } = setup(false, "garbage", (e) => events.push(e));
  assert.throws(() => provider());
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "DENIED");
  assert.match(events[0].code, /^[A-Z0-9_]+$/);
});
