import test from "node:test";
import assert from "node:assert/strict";
import { createOAuthVerifier } from "../src/auth.js";
import { createDevKeyPair, mintDevToken } from "../src/dev-token.js";

const issuer = "http://127.0.0.1:8787";
const resource = "http://127.0.0.1:8787/mcp";
const users = [
  { subject: "dev", permissions: ["read", "write", "execute"] },
];

async function setup() {
  const { privateKey, jwks } = await createDevKeyPair();
  const verify = createOAuthVerifier({ jwks, issuer, resource }, users);
  return { privateKey, verify };
}
const mint = (privateKey, extra = {}) =>
  mintDevToken({ privateKey, issuer, resource, subject: "dev", env: {}, ...extra });

test("minted token passes the real verifier with only the requested scope", async () => {
  const { privateKey, verify } = await setup();
  const user = await verify(`Bearer ${await mint(privateKey)}`);
  assert.deepEqual(user.permissions, ["read"]);
});

test("token for another audience or an expired token is rejected", async () => {
  const { privateKey, verify } = await setup();
  const wrong = await mintDevToken({
    privateKey, issuer, resource: "http://127.0.0.1:9999/mcp", subject: "dev", env: {},
  });
  assert.equal(await verify(`Bearer ${wrong}`), null);
  const old = await mint(privateKey, { now: Math.floor(Date.now() / 1000) - 7200 });
  assert.equal(await verify(`Bearer ${old}`), null);
});

test("token from a different key is rejected", async () => {
  const { verify } = await setup();
  const other = await createDevKeyPair();
  assert.equal(await verify(`Bearer ${await mint(other.privateKey)}`), null);
});

test("refuses production, non-loopback, bad subject, scope and ttl", async () => {
  const { privateKey } = await setup();
  const base = { privateKey, issuer, resource, subject: "dev", env: {} };
  const bad = (patch, code) =>
    assert.rejects(mintDevToken({ ...base, ...patch }), { message: code });
  await bad({ env: { NODE_ENV: "production" } }, "DEV_TOKEN_FORBIDDEN_IN_PRODUCTION");
  await bad({ issuer: "https://kmjtechno.com" }, "DEV_TOKEN_ISSUER_NOT_LOOPBACK");
  await bad({ resource: "http://evil.example/mcp" }, "DEV_TOKEN_RESOURCE_NOT_LOOPBACK");
  await bad({ issuer: "http://127.0.0.1@evil.example" }, "DEV_TOKEN_ISSUER_INVALID");
  await bad({ subject: "a b" }, "DEV_TOKEN_SUBJECT_INVALID");
  await bad({ scopes: ["admin"] }, "DEV_TOKEN_SCOPE_INVALID");
  await bad({ ttlSeconds: 86400 }, "DEV_TOKEN_TTL_INVALID");
});
