// Development-only, short-lived, scope-limited OAuth tokens for a LOOPBACK
// gateway. Tokens are real EdDSA JWTs verified by the normal verifier in
// auth.js; nothing here skips verification. Refused in production and for any
// issuer/resource that is not a loopback http(s) origin.
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { scopes as allScopes } from "./auth.js";

export const DEV_TOKEN_MAX_TTL_SECONDS = 3600;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function assertLoopback(label, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`DEV_TOKEN_${label}_INVALID`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(`DEV_TOKEN_${label}_INVALID`);
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(`DEV_TOKEN_${label}_NOT_LOOPBACK`);
}

export async function createDevKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "EdDSA",
    use: "sig",
    kid: "dev",
  };
  return { privateKey, jwks: { keys: [jwk] } };
}

export async function mintDevToken({
  privateKey,
  issuer,
  resource,
  subject,
  scopes = ["codebridge:read"],
  ttlSeconds = 900,
  env = process.env,
  now = Math.floor(Date.now() / 1000),
}) {
  // Callers may supply an env snapshot in tests, but must never be able to
  // override the actual runtime's production deny rule with { env: {} }.
  if (process.env.NODE_ENV === "production" || env?.NODE_ENV === "production")
    throw new Error("DEV_TOKEN_FORBIDDEN_IN_PRODUCTION");
  assertLoopback("ISSUER", issuer);
  assertLoopback("RESOURCE", resource);
  if (typeof subject !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(subject))
    throw new Error("DEV_TOKEN_SUBJECT_INVALID");
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((s) => allScopes.includes(s))
  )
    throw new Error("DEV_TOKEN_SCOPE_INVALID");
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > DEV_TOKEN_MAX_TTL_SECONDS
  )
    throw new Error("DEV_TOKEN_TTL_INVALID");
  return new SignJWT({ scope: [...new Set(scopes)].join(" ") })
    .setProtectedHeader({ alg: "EdDSA", kid: "dev" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(privateKey);
}
