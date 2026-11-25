import test from "node:test";
import assert from "node:assert/strict";
import { createNativeModelFabricWorkerModel } from "../src/native-modelfabric-worker-model.js";
import { codingRouteApproved } from "../src/autopilot-coding-worker.js";
import { normalizeModelReceipt } from "../src/model-attribution.js";

const token = "kmjmf_" + "a".repeat(48);
const now = () => 100_000;
const config = {
  enabled: true,
  inferenceRoute: "native-verified-free-cloud-only",
  nativeModelFabricApproved: true,
  cloudSourceTransferApproved: true,
  cloudProxyApproved: false,
  localProcessingApproved: false,
  model: "modelfabric-auto",
  nativeTokenEnv: "CODEBRIDGE_KMJ_MODELFABRIC_TOKEN",
};

test("native worker route forbids legacy and local fallback", () => {
  assert.equal(codingRouteApproved(config), true);
  for (const change of [
    { nativeModelFabricApproved: false },
    { cloudSourceTransferApproved: false },
    { cloudProxyApproved: true },
    { localProcessingApproved: true },
    { model: "auto:code" },
    { nativeTokenEnv: "GITHUB_TOKEN" },
  ])
    assert.equal(codingRouteApproved({ ...config, ...change }), false);
});

test("native worker consumes fresh request-bound ticket without legacy calls", async () => {
  const calls = [];
  const model = createNativeModelFabricWorkerModel({
    token,
    authorized: () => true,
    now,
    request: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "GET") {
        return Response.json({
          object: "list",
          modelfabric: {
            scope: "private-source-coding",
            policy: "strict-free-cloud",
            native_admission: {
              source: "kmj_native_provider_admission",
              request_digest: options.headers["X-ModelFabric-Request-Digest"],
              ticket: "t".repeat(64),
              requests_remaining: 5,
              issued_at_ms: now(),
              expires_at_ms: now() + 20_000,
            },
          },
        });
      }
      assert.equal(
        options.headers["X-ModelFabric-Admission-Ticket"],
        "t".repeat(64),
      );
      return Response.json({
        object: "chat.completion",
        modelfabric: { policy: "strict-free-cloud" },
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "patch" },
          },
        ],
      });
    },
  });
  assert.equal((await model.status()).available, true);
  const result = await model.generate({
    model: config.model,
    prompt: "synthetic task",
    authorizeRequest: () => true,
  });
  assert.equal(result.response, "patch");
  assert.equal(
    normalizeModelReceipt(result.modelUsage).provider,
    "kmj-modelfabric",
  );
  assert.equal(result.modelUsage.paidInference, null);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "GET", "POST"],
  );
  assert.ok(calls.every((c) => c.url.startsWith("https://kmjtechno.com/")));
});

test("planning-only response cannot activate or send source", async () => {
  let posts = 0;
  const model = createNativeModelFabricWorkerModel({
    token,
    authorized: () => true,
    now,
    request: async (_, options) => {
      if (options.method === "POST") posts++;
      return Response.json({
        object: "list",
        modelfabric: { routes: 2, free_routes: 2 },
      });
    },
  });
  assert.equal((await model.status()).available, false);
  await assert.rejects(
    model.generate({
      model: config.model,
      prompt: "synthetic task",
      authorizeRequest: () => true,
    }),
  );
  assert.equal(posts, 0);
});

test("native worker exposes busy state and refuses overlapping probes or generation", async () => {
  let resolveProbe;
  let calls = 0;
  const model = createNativeModelFabricWorkerModel({
    token,
    authorized: () => true,
    now,
    request: () => {
      calls++;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
  });
  const input = {
    model: config.model,
    prompt: "synthetic task",
    authorizeRequest: () => true,
  };
  const pending = model.status();
  assert.deepEqual(await model.status(), {
    available: false,
    activeRequest: true,
    models: [],
  });
  await assert.rejects(model.generate(input), /NATIVE_MODEL_FABRIC_BUSY/);
  assert.equal(calls, 1);
  resolveProbe(Response.json({ object: "list" }));
  assert.equal((await pending).activeRequest, false);

  const generation = model.generate(input);
  assert.equal((await model.status()).activeRequest, true);
  await assert.rejects(model.generate(input), /NATIVE_MODEL_FABRIC_BUSY/);
  assert.equal(calls, 2);
  resolveProbe(Response.json({ object: "list" }));
  await assert.rejects(generation, /NATIVE_MODEL_FABRIC_NOT_AUTHORIZED/);
  const next = model.status();
  assert.equal(calls, 3);
  resolveProbe(Response.json({ object: "list" }));
  assert.equal((await next).activeRequest, false);
});
