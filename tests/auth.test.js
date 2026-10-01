import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";\nimport { createServer } from "node:http";
import { createOAuthVerifier } from "../src/auth.js";
const pair = await generateKeyPair("EdDSA");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
const config = {
  issuer: "https://identity.example",
  resource: "https://bridge.example/mcp",
  jwks: { keys: [jwk] },
};
const users = [
  {
    id: "alice",
    subject: "subject-1",
    tenant: "t1",
    permissions: ["read", "write"],
    devices: { d: ["p"] },
  },
];
const verify = createOAuthVerifier(config, users);
async function token(overrides = {}) {
  return new SignJWT({
    scope: "codebridge:read codebridge:execute",
    ...overrides,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" })
    .setSubject("subject-1")
    .setIssuer(config.issuer)
    .setAudience(config.resource)
    .setIssuedAt()
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
}
test("OAuth permissions intersect scopes and server ACL", async () => {
  const user = await verify("Bearer " + (await token()));
  assert.deepEqual(user.permissions, ["read"]);
  assert.equal(user.tenant, "t1");
});

test("OAuth verifier loads and caches public keys from a remote JWKS endpoint", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const remote = createOAuthVerifier(
      {
        issuer: config.issuer,
        resource: config.resource,
        jwksUri: `http://127.0.0.1:${address.port}/jwks.json`,
      },
      users,
    );
    assert.equal((await remote("Bearer " + (await token()))).id, "alice");
    assert.equal((await remote("Bearer " + (await token()))).id, "alice");
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("OAuth refuses forged, expired, missing expiry, unknown subject and wrong audience tokens", async () => {
  const valid = await token();
  for (const jwt of [
    valid.slice(0, -8) + "aaaaaaaa",
    await new SignJWT({ scope: "codebridge:read" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(config.issuer)
      .setAudience(config.resource)
      .setSubject("subject-1")
      .sign(pair.privateKey),
    await new SignJWT({ scope: "codebridge:read" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(config.issuer)
      .setAudience("wrong")
      .setSubject("subject-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey),
    await new SignJWT({ scope: "codebridge:read" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(config.issuer)
      .setAudience(config.resource)
      .setSubject("unknown")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey),
    await new SignJWT({ scope: "codebridge:read" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .setIssuer(config.issuer)
      .setAudience(config.resource)
      .setSubject("subject-1")
      .setIssuedAt()
      .setExpirationTime(1)
      .sign(pair.privateKey),
  ])
    assert.equal(await verify("Bearer " + jwt), null);
});
test("OAuth ignores token-supplied ACL and rejects malformed authorization", async () => {
  assert.equal(await verify("Basic x"), null);
  const user = await verify(
    "Bearer " +
      (await token({
        tenant: "evil",
        devices: { all: ["all"] },
        scope: "codebridge:write",
      })),
  );
  assert.equal(user.tenant, "t1");
  assert.deepEqual(user.devices, { d: ["p"] });
  assert.deepEqual(user.permissions, ["write"]);
});
import { startGateway } from "../src/gateway.js";
import { createHash } from "node:crypto";
import { gatewaySchema } from "../src/config.js";
const gatewayConfig = {
  port: 0,
  oauth: config,
  users,
  agents: [
    {
      id: "d",
      tenant: "t1",
      tokenHash: createHash("sha256").update("agent").digest("hex"),
    },
  ],
};
test("gateway advertises metadata and fails closed without valid OAuth", async () => {
  const gateway = await startGateway(gatewayConfig);
  try {
    const metadata = await fetch(
      gateway.url + "/.well-known/oauth-protected-resource",
    );
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).resource, config.resource);
    const denied = await fetch(gateway.url + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer agent" },
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate"), /resource_metadata=/);
    const allowed = await fetch(gateway.url + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (await token()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_devices", arguments: {} },
      }),
    });
    assert.equal(allowed.status, 200);
    const result = await allowed.json();
    assert.equal(JSON.parse(result.result.content[0].text).devices[0].id, "d");
    const scoped = await fetch(gateway.url + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (await token({ scope: "codebridge:write" })),
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
    const error = await scoped.json();
    assert.equal(error.result.isError, true);
    assert.match(
      error.result._meta["mcp/www_authenticate"][0],
      /insufficient_scope/,
    );
    const acl = await fetch(gateway.url + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + (await token()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "run_quality_gate",
          arguments: {
            device: "d",
            project: "p",
            gate: "test",
            requestKey: "test-key",
          },
        },
      }),
    });
    const aclResult = await acl.json();
    assert.equal(aclResult.result.isError, true);
    assert.equal(aclResult.result._meta, undefined);
  } finally {
    await gateway.close();
  }
});
test("OAuth config rejects private keys, duplicate subjects and insecure URLs", () => {
  for (const oauth of [
    { ...config, issuer: "http://identity.example" },
    { ...config, jwks: { keys: [{ ...jwk, d: "secret" }] } },
    { ...config, jwks: undefined, jwksUri: "http://identity.example/jwks" },
    {
      ...config,
      jwks: undefined,
      jwksUri: "https://keys.example/.well-known/jwks.json",
    },
    {
      ...config,
      jwksUri: "https://identity.example/.well-known/jwks.json",
    },
  ])
    assert.equal(
      gatewaySchema.safeParse({ ...gatewayConfig, oauth }).success,
      false,
    );
  assert.equal(
    gatewaySchema.safeParse({
      ...gatewayConfig,
      oauth: {
        ...config,
        jwks: undefined,
        jwksUri: "https://identity.example/.well-known/jwks.json",
      },
    }).success,
    true,
  );
  assert.equal(
    gatewaySchema.safeParse({
      ...gatewayConfig,
      users: [...users, { ...users[0], id: "other" }],
    }).success,
    false,
  );
});

test("future issued-at, wrong issuer and future not-before are rejected", async () => {
  for (const claims of [
    { iss: "https://wrong.example" },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ]) {
    const jwt = await new SignJWT({
      iss: config.issuer,
      aud: config.resource,
      sub: "subject-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7200,
      scope: "codebridge:read",
      ...claims,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "test" })
      .sign(pair.privateKey);
    assert.equal(await verify("Bearer " + jwt), null);
  }
});
