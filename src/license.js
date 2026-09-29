import { createPublicKey, verify } from "node:crypto";
import { fail } from "./errors.js";
export function verifyEntitlement(
  token,
  keys,
  binding,
  now = Math.floor(Date.now() / 1000),
) {
  try {
    if (typeof token !== "string" || token.length > 16384)
      fail("LICENSE_INVALID");
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
    )
      fail("LICENSE_INVALID");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (
      header.alg !== "EdDSA" ||
      typeof header.kid !== "string" ||
      !Object.hasOwn(keys, header.kid) ||
      header.crit
    )
      fail("LICENSE_KEY");
    const key = createPublicKey(keys[header.kid]);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(parts.slice(0, 2).join(".")),
        key,
        Buffer.from(parts[2], "base64url"),
      )
    )
      fail("LICENSE_SIGNATURE");
    if (
      p.v !== 1 ||
      p.product !== "KMJ_CODEBRIDGE" ||
      p.tenant !== binding.tenant ||
      p.device !== binding.device
    )
      fail("LICENSE_BINDING");
    if (
      ["license_id", "activation_id", "jti"].some(
        (k) => typeof p[k] !== "string" || !p[k] || p[k].length > 200,
      )
    )
      fail("LICENSE_CLAIMS");
    if (
      ["iat", "nbf", "exp", "grace_until", "sequence"].some(
        (k) => !Number.isSafeInteger(p[k]),
      ) ||
      p.sequence < 0
    )
      fail("LICENSE_TIME");
    if (
      p.iat > now ||
      p.nbf > now ||
      p.iat > p.exp ||
      p.nbf > p.exp ||
      p.exp > p.grace_until ||
      p.grace_until - p.exp > 172800 ||
      now >= p.grace_until
    )
      fail("LICENSE_EXPIRED");
    if (
      !Array.isArray(p.features) ||
      p.features.some((f) => !["read", "write", "execute"].includes(f))
    )
      fail("LICENSE_FEATURES");
    if (
      !p.limits ||
      !Number.isInteger(p.limits.concurrent_jobs) ||
      p.limits.concurrent_jobs < 1 ||
      p.limits.concurrent_jobs > 16 ||
      !Number.isInteger(p.limits.devices) ||
      p.limits.devices < 1
    )
      fail("LICENSE_LIMITS");
    return { ...p, state: now < p.exp ? "ACTIVE" : "GRACE" };
  } catch {
    fail("LICENSE_INVALID");
  }
}
