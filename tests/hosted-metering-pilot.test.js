import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  createHostedMeteringPilot,
  pilotReceiptMessage,
  pilotRequestHash,
} from "../src/hosted-metering-pilot.js";

const tenant = "c5f71b5e-955b-4d85-a63e-60310777a52c";
const execution = "10004e25-8a92-4cf1-804c-3ed3f03b22cb";
const device = "device-one";
const project = "project-one";
const config = { tenant, id: device, projects: [{ id: project }] };
const work = {
  id: execution,
  tool: "git_status",
  args: { device, project },
};
const binding = {
  organization_id: tenant,
  subject_key: "account",
  execution_id: execution,
  device_id: device,
  project_id: project,
  request_sha256: pilotRequestHash(device, project),
};

test("receipt contract signs only the exact authorized device execution", () => {
  const message = pilotReceiptMessage(binding, work, config);
  assert.equal(
    message,
    [
      "KMJ_CODEBRIDGE_HOSTED_RECEIPT_V1",
      tenant,
      "account",
      execution,
      device,
      project,
      binding.request_sha256,
      "succeeded",
      "",
    ].join("\n"),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(message), privateKey);
  assert.equal(verify(null, Buffer.from(message), publicKey, signature), true);
  for (const invalid of [
    { ...binding, project_id: "other" },
    { ...binding, request_sha256: "a".repeat(64) },
    { ...binding, subject_key: "seat:other" },
    { ...binding, extra: true },
  ]) {
    assert.throws(
      () => pilotReceiptMessage(invalid, work, config),
      /HOSTED_METERING_SCOPE_INVALID/,
    );
  }
  assert.throws(
    () => pilotReceiptMessage(binding, { ...work, tool: "git_diff" }, config),
    /HOSTED_METERING_SCOPE_INVALID/,
  );
});

test("metering is disabled without explicit configuration and rejects foreign endpoints", () => {
  assert.equal(createHostedMeteringPilot(undefined), null);
  assert.throws(
    () =>
      createHostedMeteringPilot(
        {
          endpoint:
            "https://other.example/api/codebridge/v1/hosted-metering-pilot",
          tenant,
          tokenEnv: "METER_TOKEN",
        },
        { issuer: "https://kmjtechno.com" },
        { METER_TOKEN: "a".repeat(43) },
      ),
    /HOSTED_METERING_PILOT_CONFIG_INVALID/,
  );
});

test("gateway verifies reservation hash and settlement acknowledgment", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    const payload =
      body.action === "reserve"
        ? { reserved: true, request_sha256: binding.request_sha256 }
        : { settled: true };
    return new Response(JSON.stringify(payload));
  });
  const meter = createHostedMeteringPilot(
    {
      endpoint: "https://kmjtechno.com/api/codebridge/v1/hosted-metering-pilot",
      tenant,
      tokenEnv: "METER_TOKEN",
    },
    { issuer: "https://kmjtechno.com" },
    { METER_TOKEN: "a".repeat(43) },
  );
  const user = { dynamic: true, subject: "kmj-user:17" };
  const agent = { dynamic: true, id: device, tenant };
  assert.deepEqual(
    await meter.reserve(user, agent, execution, work.args),
    binding,
  );
  await assert.rejects(meter.settle(binding, "invalid"), /SIGNATURE_REQUIRED/);
  await meter.settle(binding, Buffer.alloc(64).toString("base64"));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].action, "reserve");
  assert.equal(seen[1].action, "settle");
  await assert.rejects(
    meter.reserve({ ...user, dynamic: false }, agent, execution, work.args),
    /SCOPE_INVALID/,
  );
});
