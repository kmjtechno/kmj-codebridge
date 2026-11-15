import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { signInScope } from "../src/auth.js";
import { gatewaySchema } from "../src/config.js";
import { startGateway } from "../src/gateway.js";

const ALL = "codebridge:read codebridge:write codebridge:execute";
const pair = await generateKeyPair("EdDSA");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
const oauth = {
  issuer: "https://identity.example",
  resource: "https://bridge.example/mcp",
  jwks: { keys: [jwk] },
};
const base = {
  port: 0,
  users: [
    {
      id: "alice",
      subject: "subject-1",
      tenant: "t1",
      permissions: ["read", "write"],
      devices: { d: ["p"] },
    },
  ],
  agents: [
    {
      id: "d",
      tenant: "t1",
      tokenHash: createHash("sha256").update("agent").digest("hex"),
    },
  ],
};
const call = (gateway, name, authorization, args = {}) =>
  fetch(gateway.url + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
const readOnlyToken = () =>
  new SignJWT({ scope: "codebridge:read" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" })
    .setIssuer(oauth.issuer)
    .setAudience(oauth.resource)
    .setSubject("subject-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);

test("signInScope keeps the per-tool scope unless the option is all", () => {
  assert.equal(signInScope({}, "codebridge:read"), "codebridge:read");
  assert.equal(
    signInScope({ signInScopes: "requested-tool" }, "codebridge:write"),
    "codebridge:write",
  );
  assert.equal(signInScope({ signInScopes: "all" }, "codebridge:read"), ALL);
  assert.equal(signInScope(undefined, "codebridge:read"), "codebridge:read");
  // No tool known: the challenge helper falls back to every scope itself.
  assert.equal(signInScope({}, undefined), undefined);
});

test("config accepts only the two documented values", () => {
  for (const signInScopes of ["requested-tool", "all"])
    assert.equal(
      gatewaySchema.safeParse({ ...base, oauth: { ...oauth, signInScopes } })
        .success,
      true,
    );
  assert.equal(
    gatewaySchema.safeParse({
      ...base,
      oauth: { ...oauth, signInScopes: "everything" },
    }).success,
    false,
  );
});

test("default: an unauthenticated read call is challenged for read only", async (t) => {
  const gateway = await startGateway({ ...base, oauth });
  t.after(() => gateway.close());
  const denied = await call(gateway, "list_devices");
  assert.equal(denied.status, 401);
  assert.match(
    denied.headers.get("www-authenticate"),
    /scope="codebridge:read"/,
  );
});

test("all: sign-in asks for every scope, but grants nothing by itself", async (t) => {
  const gateway = await startGateway({
    ...base,
    oauth: { ...oauth, signInScopes: "all" },
  });
  t.after(() => gateway.close());

  for (const authorization of [undefined, "Bearer bad"]) {
    const denied = await call(gateway, "list_devices", authorization);
    assert.equal(denied.status, 401);
    const challenge = denied.headers.get("www-authenticate");
    assert.ok(challenge.includes(`scope="${ALL}"`), challenge);
    assert.match(challenge, /error="invalid_token"/);
  }

  // A token that was only granted read is still refused for a write tool,
  // and the step-up challenge still names exactly the missing scope.
  const refused = await call(
    gateway,
    "write_file",
    `Bearer ${await readOnlyToken()}`,
    {
      device: "d",
      project: "p",
      path: "a.txt",
      content: "x",
      expectedHash: "0".repeat(64),
    },
  );
  assert.equal(refused.status, 200);
  const text = await refused.text();
  assert.match(text, /ACCESS_DENIED/);
  assert.match(text, /OAUTH_SCOPE_NOT_GRANTED/);
  assert.match(text, /scope=\\"codebridge:write\\"/);
  assert.match(text, /insufficient_scope/);
  assert.ok(!text.includes(ALL));
});
