import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectP720Fleet,
  inspectP720Target,
  inspectP720PhysicalGpu,
} from "../scripts/p720-ai-check.mjs";

function fakeOllama(model, { vram = 4000000000, available = true } = {}) {
  return async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.equal(options.redirect, "error");
    let value;
    if (endpoint.pathname === "/api/version") {
      value = { version: "0.40.1" };
    } else if (endpoint.pathname === "/api/tags") {
      value = { models: available ? [{ name: model }] : [] };
    } else if (endpoint.pathname === "/api/generate") {
      assert.equal(options.method, "POST");
      const request = JSON.parse(options.body);
      assert.equal(request.model, model);
      assert.equal(request.stream, false);
      assert.equal(request.think, false);
      value = {
        done: true,
        response: "function add(a, b) { return a + b; }",
        eval_count: 24,
        eval_duration: 1000000000,
      };
    } else if (endpoint.pathname === "/api/ps") {
      value = { models: [{ name: model, size_vram: vram }] };
    } else {
      throw new Error("Unexpected endpoint");
    }
    return { ok: true, json: async () => value };
  };
}

test("P720 verifier confirms real generation and GPU offload bytes", async () => {
  const model = "qwen2.5-coder:7b";
  const result = await inspectP720Target(
    { port: 11435, model },
    fakeOllama(model),
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.tokensPerSecond, 24);
  assert.equal(result.gpuOffloadBytes, 4000000000);
});

test("P720 verifier never pulls a missing model", async () => {
  const model = "qwen3:4b";
  const calls = [];
  const fake = fakeOllama(model, { available: false });
  const result = await inspectP720Target(
    { port: 11436, model },
    async (...args) => {
      calls.push(new URL(args[0]).pathname);
      return fake(...args);
    },
  );
  assert.equal(result.reason, "MODEL_NOT_INSTALLED");
  assert.deepEqual(calls, ["/api/version", "/api/tags"]);
});

test("P720 verifier reports generation without GPU as warning", async () => {
  const model = "qwen3:4b";
  const result = await inspectP720Target(
    { port: 11436, model },
    fakeOllama(model, { vram: 0 }),
  );
  assert.equal(result.status, "WARN");
  assert.equal(result.reason, "GENERATION_OK_GPU_OFFLOAD_NOT_VERIFIED");
});

test("P720 verifier checks workers sequentially and requires both green", async () => {
  const targets = [
    { port: 11435, model: "qwen3:4b" },
    { port: 11436, model: "qwen3:4b" },
  ];
  let active = 0;
  let peak = 0;
  const fake = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await fakeOllama("qwen3:4b")(...args);
    } finally {
      active--;
    }
  };
  const report = await inspectP720Fleet(targets, fake);
  assert.equal(report.allPassed, true);
  assert.equal(report.results.length, 2);
  assert.equal(peak, 1);
});

test("P720 verifier rejects invalid network ports", async () => {
  const result = await inspectP720Target(
    { port: 80, model: "qwen3:4b" },
    fakeOllama("qwen3:4b"),
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "ENDPOINT_OR_INFERENCE_FAILED");
  assert.equal(result.error, "INVALID_LOCAL_PORT");
});

test("P720 verifier diagnoses thinking-only output without false PASS", async () => {
  const model = "qwen3:4b";
  const base = fakeOllama(model);
  const result = await inspectP720Target(
    { port: 11436, model },
    async (url, opts) => {
      if (new URL(url).pathname === "/api/generate") {
        return {
          ok: true,
          json: async () => ({
            done: true,
            response: "",
            thinking: "reasoning text",
            eval_count: 48,
            eval_duration: 1000000000,
          }),
        };
      }
      return base(url, opts);
    },
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "THINKING_ONLY_NO_VISIBLE_TEXT");
  assert.equal(result.evalTokens, 48);
});

test("P720 GPU verification reads physical NVIDIA identity using fixed executable and arguments", () => {
  const runs = [];
  const inventory = inspectP720PhysicalGpu({
    platform: "win32",
    exists: (binary) => binary.endsWith("\\nvidia-smi.exe"),
    run: (binary, args, opts) => {
      runs.push({ binary, args });
      assert.equal(opts.shell, false);
      assert.equal(opts.timeout, 3500);
      if (args[0].startsWith("--query-gpu="))
        return "0, NVIDIA RTX A4000, 573.86, 16376, 21\n";
      if (args[0].startsWith("--query-compute-apps="))
        return "C:\\Program Files\\Ollama\\ollama.exe\n";
      throw Error("unexpected request");
    },
  });
  assert.equal(inventory.verification, "WINDOWS_NVIDIA_GPU_INVENTORY_VERIFIED");
  assert.deepEqual(inventory.devices, [
    {
      index: 0,
      name: "NVIDIA RTX A4000",
      driver: "573.86",
      memoryMiB: 16376,
      utilizationPercent: 21,
    },
  ]);
  assert.equal(inventory.ollamaComputeProcessObserved, true);
  assert.equal(inventory.modelGpuMappingVerified, false);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((v) => v.binary.startsWith("C:\\Windows\\System32\\")));
});

test("P720 GPU fallback reports Windows adapter identity without claiming model attribution", () => {
  const gpu = inspectP720PhysicalGpu({
    platform: "win32",
    exists: (p) => p.endsWith("\\powershell.exe"),
    run: (_bin, args) => {
      assert.equal(args[0], "-NoProfile");
      return JSON.stringify({
        Name: "AMD Radeon PRO",
        DriverVersion: "32.0.12011",
      });
    },
  });
  assert.equal(gpu.verification, "WINDOWS_DISPLAY_ADAPTER_INVENTORY_ONLY");
  assert.equal(gpu.devices[0].name, "AMD Radeon PRO");
  assert.equal(gpu.modelGpuMappingVerified, false);
});

test("P720 GPU verifier fails closed for unknown hardware and keeps inference independent", async () => {
  const missing = inspectP720PhysicalGpu({
    platform: "win32",
    exists: () => false,
  });
  assert.equal(missing.verification, "GPU_IDENTITY_NOT_VERIFIED");
  const report = await inspectP720Fleet(
    [{ port: 11435, model: "qwen3:4b" }],
    fakeOllama("qwen3:4b"),
    () => missing,
  );
  assert.equal(report.allPassed, true);
  assert.equal(report.gpuHardware.verification, "GPU_IDENTITY_NOT_VERIFIED");
  assert.equal(report.results[0].gpuOffloadBytes, 4000000000);
  assert.equal(report.gpuHardware.modelGpuMappingVerified, false);
});
