import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { hostedConfig, startHostedGateway } from "../src/hosted.js";
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
test("hosted gateway starts, serves the OpenAI challenge and protects MCP", async () => {
  const gateway = await startHostedGateway(JSON.stringify(config), "0");
  const url = gateway.url.replace("0.0.0.0", "127.0.0.1");
  try {
    const health = await httpRequest(url + "/healthz", {
      headers: { host: "bridge.example" },
    });
    assert.equal(health.status, 200);
    const challenge = await httpRequest(
      url + "/.well-known/openai-apps-challenge",
      { headers: { host: "bridge.example" } },
    );
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body, "openai-test-challenge");
    assert.match(challenge.headers.get("content-type"), /^text\/plain/);
    const denied = await httpRequest(url + "/mcp", {
      method: "POST",
      headers: { host: "bridge.example" },
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate"), /resource_metadata/);
    const badHost = await fetch(url + "/healthz");
    assert.equal(badHost.status, 403);
  } finally {
    await gateway.close();
  }
});

function httpRequest(url, options) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
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
    request.end();
  });
}
