import test from "node:test";
import assert from "node:assert/strict";
import { checkNativeAdmission } from "../scripts/native-modelfabric-admission-check.mjs";

const args = ["--confirm-readonly-native-admission"];
const token = "kmjmf_" + "a".repeat(48);
const now = () => 100_000;

function receipt(options) {
  return Response.json({
    object: "list",
    modelfabric: {
      scope: "private-source-coding",
      policy: "strict-free-cloud",
      native_admission: {
        source: "kmj_native_provider_admission",
        request_digest: options.headers["X-ModelFabric-Request-Digest"],
        ticket: "t".repeat(64),
        requests_remaining: 1,
        issued_at_ms: now(),
        expires_at_ms: now() + 20_000,
      },
    },
  });
}

test("operator check requires explicit confirmation and a scoped token", async () => {
  let calls = 0;
  const request = () => {
    calls++;
    throw Error("unexpected request");
  };
  assert.equal(
    await checkNativeAdmission({ token, request }),
    "EXPLICIT_READONLY_CONFIRMATION_REQUIRED",
  );
  assert.equal(
    await checkNativeAdmission({ args: [...args, token], token, request }),
    "EXPLICIT_READONLY_CONFIRMATION_REQUIRED",
  );
  assert.equal(
    await checkNativeAdmission({ args, request }),
    "SCOPED_TOKEN_NOT_CONFIGURED",
  );
  assert.equal(
    await checkNativeAdmission({ args, token: token + "\n", request }),
    "SCOPED_TOKEN_NOT_CONFIGURED",
  );
  assert.equal(calls, 0);
});

test("operator check verifies only a fresh synthetic GET admission", async () => {
  const calls = [];
  const result = await checkNativeAdmission({
    args,
    token,
    now,
    request: async (url, options) => {
      calls.push(options.method);
      assert.equal(url, "https://kmjtechno.com/api/modelfabric/v1/models");
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer " + token);
      return receipt(options);
    },
  });
  assert.equal(result, "FREE_ADMISSION_VERIFIED_AT_CHECK");
  assert.deepEqual(calls, ["GET"]);
  assert.ok(!result.includes(token));
});

test("planning, expired quota and upstream errors never pass admission", async () => {
  for (const request of [
    async () => Response.json({ object: "list", modelfabric: { routes: 2 } }),
    async (_, options) => {
      const body = await receipt(options).json();
      body.modelfabric.native_admission.requests_remaining = 0;
      return Response.json(body);
    },
    async (_, options) => {
      const body = await receipt(options).json();
      body.modelfabric.native_admission.expires_at_ms = now();
      return Response.json(body);
    },
    async () => {
      throw Error(token);
    },
  ]) {
    assert.equal(
      await checkNativeAdmission({ args, token, now, request }),
      "FREE_ADMISSION_NOT_VERIFIED",
    );
  }
});
