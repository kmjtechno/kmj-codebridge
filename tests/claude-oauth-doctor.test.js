import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseClaudeOAuth,
  validateDiscovery,
} from "../scripts/diagnose-claude-oauth.mjs";

const origin = "https://kmjtechno.com";
const resource = {
  resource: `${origin}/mcp`,
  authorization_servers: [origin],
};
const auth = {
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  code_challenge_methods_supported: ["S256"],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
};

test("Claude OAuth discovery confirms PKCE and public dynamic registration", () => {
  assert.deepEqual(validateDiscovery(resource, auth), { ok: true, issues: [] });
});

test("OAuth discovery refuses misconfigured issuer, redirect or missing PKCE", () => {
  const result = validateDiscovery(
    { resource: "https://evil.example/mcp", authorization_servers: [] },
    {
      ...auth,
      issuer: "https://evil.example",
      code_challenge_methods_supported: [],
    },
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("RESOURCE_MISMATCH"));
  assert.ok(result.issues.includes("AUTHORIZATION_SERVER_MISSING"));
  assert.ok(result.issues.includes("ISSUER_MISMATCH"));
  assert.ok(result.issues.includes("PKCE_S256_MISSING"));
});

test("Read-only doctor fetches only two public metadata URLs; never tokens", async () => {
  const seen = [];
  const fakeFetch = async (url, options) => {
    seen.push({ url, options });
    const data = url.includes("protected-resource") ? resource : auth;
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => data,
    };
  };
  assert.deepEqual(await diagnoseClaudeOAuth(fakeFetch), {
    ok: true,
    issues: [],
  });
  assert.equal(seen.length, 2);
  for (const { url, options } of seen) {
    assert.match(url, /^https:\/\/kmjtechno\.com\/\.well-known\/oauth-/);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.accept, "application/json");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.authorization, undefined);
  }
});

test("Read-only doctor fails closed when OAuth discovery is non-JSON or unavailable", async () => {
  await assert.rejects(
    diagnoseClaudeOAuth(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      json: async () => ({}),
    })),
    /NON_JSON_RESPONSE/,
  );
});
