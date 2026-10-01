import test from "node:test";
import assert from "node:assert/strict";
import {
  beginDeviceEnrollment,
  pollDeviceEnrollment,
  createEnrollmentProof,
} from "../src/enrollment.js";

const base = "https://kmjtechno.com";
const request = {
  device: { id: "device1", name: "vps", platform: "linux", arch: "x64" },
  project: { id: "project1", name: "app" },
  permissions: ["read", "write", "execute"],
};

test("enrollment uses S256 verifier binding and accepts approved device", async () => {
  const proof = {
    verifier: "v".repeat(43),
    challenge: "challenge-value",
  };
  const calls = [];
  const handle = await beginDeviceEnrollment(base, request, {
    proof,
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json(
        {
          device_code: "d".repeat(48),
          user_code: "ABCD-EFGH",
          verification_uri: base + "/codebridge/pair",
          verification_uri_complete: base + "/codebridge/pair?code=ABCD-EFGH",
          expires_in: 300,
          interval: 2,
        },
        { status: 201 },
      );
    },
  });
  assert.equal(handle.verifier, proof.verifier);
  assert.equal(calls[0].body.code_challenge, proof.challenge);
  assert.equal(calls[0].body.code_challenge_method, "S256");
  assert.ok(!JSON.stringify(calls[0].body).includes(proof.verifier));

  const approved = await pollDeviceEnrollment(base, handle, request, {
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({
        agent: {
          token: "a".repeat(64),
          id: "device1",
          tenant: "tenant1",
        },
        projects: [{ id: "project1" }],
        permissions: ["read", "write", "execute"],
      });
    },
  });
  assert.equal(approved.state, "approved");
  assert.equal(calls[1].body.code_verifier, proof.verifier);
  assert.equal(calls[1].body.device_code, "d".repeat(48));
});

test("enrollment pending and slowdown are non-success states", async () => {
  const handle = {
    device_code: "d".repeat(48),
    verifier: "v".repeat(43),
    expires_at_ms: Date.now() + 60000,
  };
  for (const [status, state] of [
    [428, "pending"],
    [429, "slow_down"],
  ]) {
    const result = await pollDeviceEnrollment(base, handle, request, {
      fetch: async () => new Response("", { status }),
    });
    assert.equal(result.state, state);
  }
});

test("enrollment rejects expired denied reused-invalid and binding mismatch", async () => {
  const expired = {
    device_code: "d".repeat(48),
    verifier: "v".repeat(43),
    expires_at_ms: Date.now() - 1,
  };
  await assert.rejects(
    pollDeviceEnrollment(base, expired, request, {
      fetch: async () => assert.fail("must not send expired enrollment"),
    }),
    /ENROLLMENT_EXPIRED/,
  );

  const live = { ...expired, expires_at_ms: Date.now() + 60000 };
  for (const status of [403, 410, 400])
    await assert.rejects(
      pollDeviceEnrollment(base, live, request, {
        fetch: async () => new Response("", { status }),
      }),
    );

  await assert.rejects(
    pollDeviceEnrollment(base, live, request, {
      fetch: async () =>
        Response.json({
          agent: { token: "a".repeat(64), id: "other", tenant: "tenant1" },
          projects: [{ id: "project1" }],
          permissions: ["read", "write", "execute"],
        }),
    }),
    /ENROLLMENT_BINDING/,
  );
  await assert.rejects(
    pollDeviceEnrollment(base, live, request, {
      fetch: async () =>
        Response.json({
          agent: { token: "a".repeat(64), id: "device1", tenant: "tenant1" },
          projects: [{ id: "other" }],
          permissions: ["read", "write", "execute"],
        }),
    }),
    /ENROLLMENT_BINDING/,
  );
});

test("enrollment refuses insecure and cross-origin approval URLs", async () => {
  await assert.rejects(
    beginDeviceEnrollment("http://kmjtechno.com", request, {
      fetch: async () => assert.fail("must not send"),
    }),
    /ENROLLMENT_URL/,
  );
  await assert.rejects(
    beginDeviceEnrollment(base, request, {
      fetch: async () =>
        Response.json(
          {
            device_code: "d".repeat(48),
            user_code: "ABCD",
            verification_uri: "https://evil.example/pair",
            expires_in: 300,
            interval: 2,
          },
          { status: 201 },
        ),
    }),
    /ENROLLMENT_VERIFICATION_URL/,
  );
});

test("generated enrollment proof is high entropy and not self-equal", () => {
  const a = createEnrollmentProof();
  const b = createEnrollmentProof();
  assert.ok(a.verifier.length >= 43);
  assert.ok(a.challenge.length >= 43);
  assert.notEqual(a.verifier, a.challenge);
  assert.notEqual(a.verifier, b.verifier);
});
