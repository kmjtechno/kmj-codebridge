import assert from "node:assert/strict";
import test from "node:test";
import {
  readOnlyClaudeOAuthProbe,
  validateClaudeOAuthDiscovery,
} from "../scripts/diagnose-claude-desktop-oauth.mjs";

const resource = {
  resource: "https://kmjtechno.com/mcp",
  authorization_servers: ["https://kmjtechno.com"],
};
const auth = {
  issuer: "https://kmjtechno.com",
  authorization_endpoint: "https://kmjtechno.com/oauth/authorize",
  token_endpoint: "https://kmjtechno.com/oauth/token",
  registration_endpoint: "https://kmjtechno.com/oauth/register",
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
};

test("correct protected-resource and OAuth metadata mean discovery only", () => {
  const report = validateClaudeOAuthDiscovery(resource, auth);
  assert.equal(report.status, "DISCOVERY_READY_ONLY");
  assert.deepEqual(report.problems, []);
  assert.equal(report.oauthConnectionEstablished, false);
  assert.equal(report.clientRegistered, false);
});

test("wrong issuer, callback endpoint and missing PKCE fail closed", () => {
  const broken = validateClaudeOAuthDiscovery(
    { ...resource, authorization_servers: ["https://evil.example"] },
    {
      ...auth,
      issuer: "https://evil.example",
      token_endpoint: "http://kmjtechno.com/oauth/token",
      code_challenge_methods_supported: ["plain"],
    },
  );
  assert.equal(broken.status, "BLOCKED");
  assert.ok(broken.problems.includes("ISSUER_NOT_ADVERTISED"));
  assert.ok(broken.problems.includes("AUTH_ISSUER_MISMATCH"));
  assert.ok(broken.problems.includes("TOKEN_ENDPOINT_INVALID"));
  assert.ok(broken.problems.includes("PKCE_S256_MISSING"));
});

test("non-200 discovery never reports connected or ready", async () => {
  const report = await readOnlyClaudeOAuthProbe({
    fetcher: async () => ({
      status: 404,
      text: async () => "Not found",
    }),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.oauthConnectionEstablished, false);
  assert.deepEqual(report.requestStatus.map((row) => row.status), [404, 404]);
});

test("read-only probe never posts registration or follows login redirects", async () => {
  const requests = [];
  const values = [resource, auth];
  const report = await readOnlyClaudeOAuthProbe({
    fetcher: async (url, options) => {
      requests.push({ url, options });
      const data = values.shift();
      return {
        status: 200,
        text: async () => JSON.stringify(data),
      };
    },
  });
  assert.equal(report.status, "DISCOVERY_READY_ONLY");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((x) => x.options.method === "GET"));
  assert.ok(requests.every((x) => x.options.redirect === "manual"));
  assert.ok(
    requests.every(
      (x) => !JSON.stringify(x.options).includes("Authorization"),
    ),
  );
  assert.equal(report.oauthConnectionEstablished, false);
  assert.equal(report.toolCallsExecuted, false);
});

test("missing authorization server client registration blocks OAuth discovery", () => {
  const report = validateClaudeOAuthDiscovery(resource, {
    ...auth,
    registration_endpoint: null,
  });
  assert.equal(report.status, "BLOCKED");
  assert.ok(report.problems.includes("REGISTRATION_ENDPOINT_INVALID"));
});
