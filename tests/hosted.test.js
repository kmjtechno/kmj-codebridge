import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { hostedConfig, startHostedGateway } from "../src/hosted.js";
import { VERSION } from "../src/version.js";
import { generateKeyPairSync } from "node:crypto";
const { publicKey } = generateKeyPairSync("ed25519");
const config = {
  allowedHosts: ["bridge.example"],
  openaiAppsChallenge: "openai-test-challenge",
  oauth: {
    issuer: "https://identity.example",
    resource: "https://bridge.example/mcp",
    jwks: { keys: [publicKey.export({ format: "jwk" })] },
  },
  users: [
    {
      id: "u1",
      subject: "user1",
      tenant: "t1",
      devices: { d1: ["p1"] },
      permissions: ["read"],
    },
  ],
  agents: [{ id: "d1", tenant: "t1", tokenHash: "a".repeat(64) }],
};
test("hosted config can enable the GitHub bridge from private environment settings", () => {
  const parsed = hostedConfig(JSON.stringify(config), "10000", {
    CODEBRIDGE_GITHUB_API_BASE:
      "https://kmj-autonomous-dev-controller.onrender.com/codebridge/github/",
    CODEBRIDGE_GITHUB_PROXY_TOKEN: "x".repeat(48),
    CODEBRIDGE_GITHUB_REPOSITORIES:
      "kmjtechno/kmj-codebridge,kmjtechno/kmj-main-platform",
  });
  assert.deepEqual(parsed.github, {
    apiBase:
      "https://kmj-autonomous-dev-controller.onrender.com/codebridge/github/",
    tokenEnv: "CODEBRIDGE_GITHUB_PROXY_TOKEN",
    repositories: ["kmjtechno/kmj-codebridge", "kmjtechno/kmj-main-platform"],
    cacheSeconds: 30,
  });
});

test("hosted config supports explicit public read-only GitHub mode without a credential", () => {
  const parsed = hostedConfig(JSON.stringify(config), "10000", {
    CODEBRIDGE_GITHUB_PUBLIC_READ_ONLY: "true",
    CODEBRIDGE_GITHUB_REPOSITORIES: "kmjtechno/kmj-codebridge",
  });
  assert.deepEqual(parsed.github, {
    apiBase: "https://api.github.com/",
    publicReadOnly: true,
    repositories: ["kmjtechno/kmj-codebridge"],
    cacheSeconds: 30,
  });
});

test("hosted config can switch OAuth user grants to the issuer introspection endpoint", () => {
  const parsed = hostedConfig(JSON.stringify(config), "10000", {
    CODEBRIDGE_USER_INTROSPECTION_ENDPOINT:
      "https://identity.example/api/codebridge/v1/user-access/introspect",
  });
  assert.deepEqual(parsed.userIntrospection, {
    endpoint:
      "https://identity.example/api/codebridge/v1/user-access/introspect",
    cacheSeconds: 30,
  });
  assert.throws(
    () =>
      hostedConfig(JSON.stringify(config), "10000", {
        CODEBRIDGE_USER_INTROSPECTION_ENDPOINT:
          "https://other.example/api/codebridge/v1/user-access/introspect",
      }),
    /HOSTED_CONFIG_INVALID/,
  );
});

test("hosted config auto-discovers same-origin user introspection even with static users", () => {
  const sameOrigin = {
    ...config,
    oauth: {
      ...config.oauth,
      issuer: "https://kmjtechno.com",
      resource: "https://kmjtechno.com/mcp",
    },
    allowedHosts: ["kmjtechno.com"],
  };
  const parsed = hostedConfig(JSON.stringify(sameOrigin), "10000", {});
  assert.deepEqual(parsed.userIntrospection, {
    endpoint: "https://kmjtechno.com/api/codebridge/v1/user-access/introspect",
    cacheSeconds: 30,
  });
});

test("hosted config rejects partial GitHub environment settings", () => {
  assert.throws(
    () =>
      hostedConfig(JSON.stringify(config), "10000", {
        CODEBRIDGE_GITHUB_API_BASE: "https://proxy.example/",
      }),
    /HOSTED_CONFIG_INVALID/,
  );
});

test("hosted health proves the configured GitHub bridge can reach an allowed repository", async (t) => {
  const previous = {
    apiBase: process.env.CODEBRIDGE_GITHUB_API_BASE,
    token: process.env.CODEBRIDGE_GITHUB_PROXY_TOKEN,
    repositories: process.env.CODEBRIDGE_GITHUB_REPOSITORIES,
    fetch: globalThis.fetch,
  };
  process.env.CODEBRIDGE_GITHUB_API_BASE = "https://github-proxy.example/";
  process.env.CODEBRIDGE_GITHUB_PROXY_TOKEN = "x".repeat(48);
  process.env.CODEBRIDGE_GITHUB_REPOSITORIES = "kmjtechno/kmj-codebridge";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (
      !url.startsWith(
        "https://github-proxy.example/repos/kmjtechno/kmj-codebridge/",
      )
    )
      throw new Error("unexpected GitHub probe URL");
    return new Response(
      JSON.stringify({
        full_name: "kmjtechno/kmj-codebridge",
        default_branch: "main",
        private: true,
        archived: false,
        visibility: "private",
        updated_at: "2026-10-03T00:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    for (const [name, value] of [
      ["CODEBRIDGE_GITHUB_API_BASE", previous.apiBase],
      ["CODEBRIDGE_GITHUB_PROXY_TOKEN", previous.token],
      ["CODEBRIDGE_GITHUB_REPOSITORIES", previous.repositories],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = previous.fetch;
  });

  const gateway = await startHostedGateway(JSON.stringify(config), "0");
  const url = gateway.url.replace("0.0.0.0", "127.0.0.1");
  try {
    const health = await httpRequest(url + "/healthz", {
      headers: { host: "bridge.example" },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), {
      status: "ok",
      version: VERSION,
      capabilities: { github: true, githubReady: true },
    });
  } finally {
    await gateway.close();
  }
});

test("hosted static OAuth users default omitted device grants to deny-all", () => {
  const { devices: _devices, ...userWithoutDevices } = config.users[0];
  const parsed = hostedConfig(
    JSON.stringify({ ...config, users: [userWithoutDevices] }),
    "10000",
    {},
  );
  assert.deepEqual(parsed.users[0].devices, {});
});

test("hosted mode requires OAuth and matching public hostname", () => {
  for (const value of [
    { ...config, oauth: undefined },
    { ...config, allowedHosts: ["wrong.example"] },
  ])
    assert.throws(() => hostedConfig(JSON.stringify(value), "10000"));
});
test("hosted mode rejects malformed config and unsafe ports without exposing credentials", () => {
  for (const port of ["-1", "1.5", "65536", "10000garbage", ""])
    assert.throws(() => hostedConfig(JSON.stringify(config), port));
  assert.throws(
    () => hostedConfig("secret-invalid-json", "10000"),
    /HOSTED_CONFIG_INVALID/,
  );
});
test("hosted config binds platform port and all interfaces", () => {
  const parsed = hostedConfig(JSON.stringify(config), "10000");
  assert.equal(parsed.port, 10000);
  assert.equal(parsed.host, "0.0.0.0");
  assert.deepEqual(parsed.allowedHosts, ["bridge.example"]);
});
test("hosted gateway serves the OpenAI domain challenge and protects MCP", async () => {
  const gateway = await startHostedGateway(JSON.stringify(config), "0");
  const url = gateway.url.replace("0.0.0.0", "127.0.0.1");
  try {
    const health = await httpRequest(url + "/healthz", {
      headers: { host: "bridge.example" },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), {
      status: "ok",
      version: VERSION,
      capabilities: { github: false, githubReady: false },
    });
    const challenge = await httpRequest(
      url + "/.well-known/openai-apps-challenge",
      { headers: { host: "bridge.example" } },
    );
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body, "openai-test-challenge");
    assert.match(challenge.headers.get("content-type"), /^text\/plain/);
    assert.equal(challenge.headers.get("cache-control"), "no-store");

    const deniedDiscovery = await httpRequest(url + "/mcp", {
      method: "POST",
      headers: {
        host: "bridge.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-probe", version: "1.0.0" },
        },
      }),
    });
    assert.equal(deniedDiscovery.status, 200);

    const denied = await httpRequest(url + "/mcp", {
      method: "POST",
      headers: {
        host: "bridge.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_devices", arguments: {} },
      }),
    });
    assert.equal(denied.status, 200);
    const deniedResult = JSON.parse(denied.body);
    assert.equal(deniedResult.result.isError, true);
    assert.match(
      deniedResult.result._meta["mcp/www_authenticate"][0],
      /resource_metadata/,
    );
    const badHost = await fetch(url + "/healthz");
    assert.equal(badHost.status, 403);
  } finally {
    await gateway.close();
  }
});

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options;
    const request = http.request(url, requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: { get: (key) => response.headers[key] },
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}
