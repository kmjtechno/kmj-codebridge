import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyEntitlement } from "../src/license.js";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }) };
const now = 1800000000;
const binding = { tenant: "t1", device: "d1" };
const base = {
  v: 1,
  product: "KMJ_CODEBRIDGE",
  tenant: "t1",
  device: "d1",
  license_id: "l1",
  activation_id: "a1",
  jti: "j1",
  sequence: 1,
  iat: now - 100,
  nbf: now - 100,
  exp: now + 100,
  grace_until: now + 200,
  features: ["read", "write", "execute"],
  limits: { devices: 3, concurrent_jobs: 2 },
};
function token(
  payload = base,
  header = { alg: "EdDSA", kid: "k1", typ: "JWT" },
) {
  const body = [header, payload]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    body + "." + sign(null, Buffer.from(body), privateKey).toString("base64url")
  );
}
test("accepts authentic entitlement bound to tenant and device", () => {
  assert.equal(verifyEntitlement(token(), keys, binding, now).state, "ACTIVE");
});
for (const [name, change] of Object.entries({
  product: { product: "OTHER" },
  tenant: { tenant: "other" },
  device: { device: "other" },
  future: { nbf: now + 10 },
  expired: { exp: now - 20, grace_until: now - 10 },
  invalid_limits: { limits: { concurrent_jobs: -1 } },
  missing_id: { license_id: "" },
  bad_time: { exp: "tomorrow" },
}))
  test("rejects " + name, () =>
    assert.throws(
      () =>
        verifyEntitlement(token({ ...base, ...change }), keys, binding, now),
      /LICENSE/,
    ),
  );
test("rejects tampered payload", () => {
  let parts = token().split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...base, tenant: "other" })).toString(
    "base64url",
  );
  assert.throws(
    () => verifyEntitlement(parts.join("."), keys, binding, now),
    /LICENSE/,
  );
});
test("rejects wrong algorithm and unknown key", () => {
  assert.throws(
    () =>
      verifyEntitlement(
        token(base, { alg: "none", kid: "k1" }),
        keys,
        binding,
        now,
      ),
    /LICENSE/,
  );
  assert.throws(
    () =>
      verifyEntitlement(
        token(base, { alg: "EdDSA", kid: "unknown" }),
        keys,
        binding,
        now,
      ),
    /LICENSE/,
  );
});
test("grace must be signed and bounded to 48 hours", () => {
  assert.equal(
    verifyEntitlement(token({ ...base, exp: now - 1 }), keys, binding, now)
      .state,
    "GRACE",
  );
  assert.throws(
    () =>
      verifyEntitlement(
        token({ ...base, grace_until: now + 200000 }),
        keys,
        binding,
        now,
      ),
    /LICENSE/,
  );
});
test("rejects unsupported version and oversized token", () => {
  assert.throws(
    () => verifyEntitlement(token({ ...base, v: 2 }), keys, binding, now),
    /LICENSE/,
  );
  assert.throws(
    () => verifyEntitlement("x".repeat(20000), keys, binding, now),
    /LICENSE/,
  );
});
