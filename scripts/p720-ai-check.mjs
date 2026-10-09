#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

export const P720_TARGETS = Object.freeze([
  { port: 11435, model: "qwen2.5-coder:7b" },
  { port: 11436, model: "qwen3:4b" },
]);

function loopbackUrl(port, route) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("INVALID_LOCAL_PORT");
  }
  return `http://127.0.0.1:${port}${route}`;
}

async function jsonRequest(fetchImpl, port, route, init = {}) {
  const response = await fetchImpl(loopbackUrl(port, route), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

export async function inspectP720Target(target, fetchImpl = fetch) {
  const { port, model } = target;
  const record = { port, model, status: "BLOCKED" };
  try {
    const version = await jsonRequest(fetchImpl, port, "/api/version");
    record.ollamaVersion = String(version.version ?? "unknown");

    const tags = await jsonRequest(fetchImpl, port, "/api/tags");
    const installed = Array.isArray(tags.models)
      ? tags.models.some((item) => item.name === model || item.model === model)
      : false;
    if (!installed) {
      record.reason = "MODEL_NOT_INSTALLED";
      return record;
    }

    const generated = await jsonRequest(fetchImpl, port, "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "Write a JavaScript function that adds two integers.",
        stream: false,
        keep_alive: "30s",
        options: { num_ctx: 2048, num_predict: 48, temperature: 0 },
      }),
    });
    if (
      generated.done !== true ||
      !String(generated.response ?? "").trim() ||
      !(Number(generated.eval_count) > 0) ||
      !(Number(generated.eval_duration) > 0)
    ) {
      record.reason = "GENERATION_NOT_VERIFIED";
      return record;
    }

    record.evalTokens = Number(generated.eval_count);
    record.tokensPerSecond = Number(
      (
        (record.evalTokens * 1000000000) /
        Number(generated.eval_duration)
      ).toFixed(2),
    );

    const running = await jsonRequest(fetchImpl, port, "/api/ps");
    const loaded = Array.isArray(running.models)
      ? running.models.find(
          (item) => item.name === model || item.model === model,
        )
      : null;
    const vramBytes = loaded ? Number(loaded.size_vram) : NaN;
    record.gpuOffloadBytes = Number.isFinite(vramBytes) ? vramBytes : null;
    if (Number.isFinite(vramBytes) && vramBytes > 0) {
      record.status = "PASS";
      record.reason = "GENERATION_AND_GPU_OFFLOAD_VERIFIED";
    } else {
      record.status = "WARN";
      record.reason = "GENERATION_OK_GPU_OFFLOAD_NOT_VERIFIED";
    }
  } catch (error) {
    record.reason = "ENDPOINT_OR_INFERENCE_FAILED";
    record.error = String(error?.message ?? error).slice(0, 180);
  }
  return record;
}

export async function inspectP720Fleet(
  targets = P720_TARGETS,
  fetchImpl = fetch,
) {
  const results = [];
  // Sequential loads avoid memory-pressure spikes on a 32 GB workstation.
  for (const target of targets) {
    results.push(await inspectP720Target(target, fetchImpl));
  }
  return {
    device: "P720",
    mode: "readiness-only",
    note: "GPU offload bytes do not prove which physical GPU executed a model. No model downloads, deployments, merges or paid APIs are used.",
    results,
    allPassed: results.every((result) => result.status === "PASS"),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await inspectP720Fleet();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.allPassed ? 0 : 2;
}
