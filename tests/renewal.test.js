import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { requestRenewal } from "../src/renewal.js";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = 1800000000;
const binding = { tenant: "t1", device: "d1" };
const config = {
  endpoint: "https://licenses.example/renew",
  credential: "x".repeat(32),
};
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }) };
function issue(change = {}) {
  const claims = {
    v: 1,
    product: "KMJ_CODEBRIDGE",
    ...binding,
    license_id: "l1",
    activation_id: "a1",
    jti: "j2",
    sequence: 2,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 100,
    grace_until: now + 200,
    features: ["read"],
    limits: { devices: 1, concurrent_jobs: 1 },
    ...change,
  };
  const body = [{ alg: "EdDSA", kid: "k1" }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    body + "." + sign(null, Buffer.from(body), privateKey).toString("base64url")
  );
}
test("renewal sends minimal binding and validates signed result", async () => {
  const token = issue();
  let sent;
  const result = await requestRenewal(config, keys, binding, 1, {
    now,
    fetch: async (url, options) => {
      sent = { url, options };
      return Response.json({ token });
    },
  });
  assert.equal(result.token, token);
  assert.equal(result.claims.sequence, 2);
  assert.equal(sent.options.redirect, "error");
  assert.equal(
    sent.options.headers.authorization,
    "Bearer " + config.credential,
  );
  assert.deepEqual(JSON.parse(sent.options.body), {
    product: "KMJ_CODEBRIDGE",
    ...binding,
    sequence: 1,
  });
});
for (const [name, response] of Object.entries({
  replay: () => Response.json({ token: issue({ sequence: 1 }) }),
  wrong_device: () => Response.json({ token: issue({ device: "other" }) }),
  tampered: () => Response.json({ token: "invalid" }),
  revoked: () => new Response("", { status: 403 }),
  oversized: () => new Response("x".repeat(40000)),
}))
  test("renewal rejects " + name, async () => {
    await assert.rejects(
      requestRenewal(config, keys, binding, 1, {
        now,
        fetch: async () => response(),
      }),
    );
  });
test("renewal refuses non-HTTPS and credential-bearing URLs before sending", async () => {
  for (const endpoint of [
    "http://licenses.example/renew",
    "https://user:pass@licenses.example/renew",
    "https://licenses.example/renew?token=secret",
  ])
    await assert.rejects(
      requestRenewal({ ...config, endpoint }, keys, binding, 1, {
        now,
        fetch: async () => {
          assert.fail("must not send");
        },
      }),
    );
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAgent } from "../src/agent.js";
for (const outcome of ["renewed", "outage", "invalid", "symlink"])
  test("agent preserves or replaces cache: " + outcome, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-renew-"));
    const root = path.join(dir, "project");
    fs.mkdirSync(root);
    const tokenFile = path.join(dir, "license.jws");
    const current = Math.floor(Date.now() / 1000);
    const times = {
      iat: current - 10,
      nbf: current - 10,
      exp: current + 3600,
      grace_until: current + 7200,
    };
    const before = issue({ ...times, sequence: 1 });
    const after = issue(times);
    fs.writeFileSync(tokenFile, before);
    const alias = path.join(root, "lease.jws");
    if (outcome === "symlink") {
      try {
        fs.symlinkSync(tokenFile, alias);
      } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        if (error.code === "EPERM") {
          t.skip("Symlink privilege unavailable");
          return;
        }
        throw error;
      }
    }
    let signalPoll;
    const polled = new Promise((resolve) => {
      signalPoll = resolve;
    });
    t.mock.method(globalThis, "fetch", async (url) => {
      if (String(url) === config.endpoint) {
        if (outcome === "outage") throw Error("offline");
        return Response.json({
          token: outcome === "invalid" ? "invalid" : after,
        });
      }
      signalPoll();
      return Response.json(null);
    });
    let agent;
    try {
      agent = await startAgent({
        gateway: "https://gateway.example",
        token: "a".repeat(32),
        id: "d1",
        tenant: "t1",
        stateDir: path.join(dir, "state"),
        projects: [{ id: "p1", root }],
        license: { mode: "signed", tokenFile, keys, renewal: config },
      });
      await polled;
      if (outcome === "symlink")
        assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
      assert.equal(
        fs.readFileSync(tokenFile, "utf8"),
        ["renewed", "symlink"].includes(outcome) ? after : before,
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(dir, "state", "license-state.json"),
            "utf8",
          ),
        ).sequence,
        ["renewed", "symlink"].includes(outcome) ? 2 : 1,
      );
    } finally {
      await agent?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
