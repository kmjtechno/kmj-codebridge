import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { signerEnrollmentMessage } from "../src/receipt-enrollment-proof.js";

test("signer enrollment proof binds exact device, activation, nonce and expiry", () => {
  const config = {
    tenant: "c5f71b5e-955b-4d85-a63e-60310777a52c",
    id: "desk-a",
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const key = raw.toString("base64");
  const challenge = {
    organization_id: config.tenant,
    device_id: config.id,
    activation_id: "10004e25-8a92-4cf1-804c-3ed3f03b22cb",
    credential_id: "10004e25-8a92-4cf1-804c-3ed3f03b22ca",
    owner_id: "17",
    nonce: "a".repeat(64),
    expires_at: 1200,
  };
  const message = signerEnrollmentMessage(challenge, config, key, 1000);
  const signature = sign(null, Buffer.from(message), privateKey);
  assert.equal(verify(null, Buffer.from(message), publicKey, signature), true);
  for (const invalid of [
    { ...challenge, device_id: "other" },
    { ...challenge, expires_at: 999 },
    { ...challenge, expires_at: 1301 },
    { ...challenge, nonce: "invalid" },
  ]) {
    assert.throws(
      () => signerEnrollmentMessage(invalid, config, key, 1000),
      /SCOPE_INVALID/,
    );
  }
});
