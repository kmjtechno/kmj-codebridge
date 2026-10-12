#!/usr/bin/env node
// Opt-in P720 latency/VRAM experiment. Fixed loopback Ollama targets only.
// No model pulls, external URLs, paid inference, environment credentials, or
// changes to enrolled agents. Run from the authorized P720, never on a VPS.
import http from "node:http";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const TARGETS = Object.freeze([
  { port: 11435, model: "qwen2.5-coder:7b" },
  { port: 11436, model: "qwen3:4b" },
  // 8B runs only if already present on the standard P720 local instance.
  { port: 11434, model: "qwen3:8b", optional: true },
]);
const PROMPT = "Write only JavaScript: function add(a, b) that returns a + b.";
const MAX_BYTES = 131072;

export function localJson(port, endpoint, body, timeoutMs = 90000) {
  if (!TARGETS.some((t) => t.port === port))
    throw Error("BENCH_PORT_NOT_APPROVED");
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method: payload === null ? "GET" : "POST",
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        headers:
          payload === null
            ? { accept: "application/json" }
            : {
                accept: "application/json",
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error("BENCH_LOCAL_HTTP_ERROR"));
          return;
        }
        const parts = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(Error("BENCH_RESPONSE_TOO_LARGE"));
            return;
          }
          parts.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
          } catch {
            reject(Error("BENCH_RESPONSE_INVALID"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

export function nanosToMs(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.round(value / 1000000)
    : null;
}

export function inferenceRecord(value) {
  if (
    !value ||
    value.done !== true ||
    typeof value.response !== "string" ||
    !value.response.trim()
  )
    throw Error("BENCH_NO_VISIBLE_OUTPUT");
  const count = value.eval_count;
  const duration = value.eval_duration;
  return {
    outputPresent: true,
    codingSmokePass: /return\s+a\s*\+\s*b\s*;?/i.test(value.response),
    totalMs: nanosToMs(value.total_duration),
    loadMs: nanosToMs(value.load_duration),
    promptMs: nanosToMs(value.prompt_eval_duration),
    evalMs: nanosToMs(duration),
    tokensPerSecond:
      Number.isSafeInteger(count) &&
      count >= 0 &&
      Number.isSafeInteger(duration) &&
      duration > 0
        ? Number(((count * 1e9) / duration).toFixed(2))
        : null,
    generatedTokens:
      Number.isSafeInteger(count) && count >= 0
        ? Math.min(count, 1000000)
        : null,
  };
}

export async function benchmarkTarget(target, request = localJson) {
  const { port, model } = target;
  // A benchmark may unload only a model whose cold run it owns.
  let startedGeneration = false;
  try {
    const tags = await request(port, "/api/tags");
    if (
      !Array.isArray(tags?.models) ||
      !tags.models.some(
        (entry) => entry?.name === model || entry?.model === model,
      )
    )
      return {
        model,
        port,
        state: "NOT_INSTALLED",
        optional: !!target.optional,
      };
    // Do not evict any already-loaded model: it may belong to Claude or
    // another concurrent local workload. A verified-empty /api/ps snapshot
    // is the only safe starting point for an opt-in cold benchmark.
    const coldStart = await request(port, "/api/ps");
    if (!Array.isArray(coldStart?.models))
      throw Error("BENCH_BASELINE_UNAVAILABLE");
    if (coldStart.models.length > 0) throw Error("BENCH_OTHER_WORKLOAD_ACTIVE");

    // Cold request explicitly asks Ollama to release the model afterward.
    // Warm priming and warm repeat are back-to-back within a 30s bounded TTL.
    const requestBody = (keep_alive) => ({
      model,
      prompt: PROMPT,
      stream: false,
      ...(model.startsWith("qwen3:") ? { think: false } : {}),
      keep_alive,
      options: { num_ctx: 2048, num_predict: 64, temperature: 0 },
    });
    startedGeneration = true;
    const cold = inferenceRecord(
      await request(port, "/api/generate", requestBody(0)),
    );
    const priming = inferenceRecord(
      await request(port, "/api/generate", requestBody("30s")),
    );
    const warm = inferenceRecord(
      await request(port, "/api/generate", requestBody("30s")),
    );
    let observedVramBytes = null;
    try {
      const running = await request(port, "/api/ps");
      const entry = Array.isArray(running?.models)
        ? running.models.find(
            (item) => item.name === model || item.model === model,
          )
        : null;
      if (Number.isSafeInteger(entry?.size_vram) && entry.size_vram >= 0)
        observedVramBytes = entry.size_vram;
    } catch {
      // No VRAM observation is not evidence of absent GPU use.
    }
    // Total latency alone can be present even when Ollama provides no
    // generation telemetry. Refuse to claim measured performance unless
    // all three stages have complete positive duration/token counters.
    const measured = [cold, priming, warm].every(
      (row) =>
        row.totalMs !== null &&
        row.totalMs > 0 &&
        row.loadMs !== null &&
        row.evalMs !== null &&
        row.evalMs > 0 &&
        row.generatedTokens !== null &&
        row.generatedTokens > 0 &&
        row.tokensPerSecond !== null &&
        row.tokensPerSecond > 0,
    );
    const allCodingSmokesPass =
      cold.codingSmokePass && priming.codingSmokePass && warm.codingSmokePass;
    return {
      model,
      port,
      state: !measured
        ? "INCOMPLETE_TIMING"
        : allCodingSmokesPass
          ? "MEASURED"
          : "INVALID_CODING_OUTPUT",
      cold,
      priming,
      warm,
      observedVramBytes,
      warmLatencyChangePercent: measured
        ? Number(
            (((warm.totalMs - cold.totalMs) / cold.totalMs) * 100).toFixed(1),
          )
        : null,
      allCodingSmokesPass,
      note: "Negative latency change is faster. GPU process attribution and GPU free VRAM are not asserted.",
    };
  } catch (error) {
    return {
      model,
      port,
      state: "BLOCKED",
      error:
        error?.message === "BENCH_NO_VISIBLE_OUTPUT"
          ? "BENCH_NO_VISIBLE_OUTPUT"
          : error?.message === "BENCH_BASELINE_UNAVAILABLE"
            ? "BENCH_BASELINE_UNAVAILABLE"
            : error?.message === "BENCH_OTHER_WORKLOAD_ACTIVE"
              ? "BENCH_OTHER_WORKLOAD_ACTIVE"
              : "BENCH_LOCAL_ENDPOINT_OR_INFERENCE_FAILED",
    };
  } finally {
    // Clean up only a generation that this benchmark actually started.
    // On preflight failure, never unload another engineer's loaded model.
    if (startedGeneration) {
      try {
        await request(
          port,
          "/api/generate",
          {
            model,
            prompt: "",
            stream: false,
            keep_alive: 0,
          },
          10000,
        );
      } catch {
        // Best effort, never hide the benchmark's own outcome.
      }
    }
  }
}

export async function benchmarkFleet(request = localJson) {
  if (os.freemem() < 2 * 1024 ** 3)
    return { state: "BLOCKED", reason: "LOW_FREE_RAM" };
  const results = [];
  for (const target of TARGETS) {
    results.push(await benchmarkTarget(target, request));
  }
  return {
    device: "P720",
    mode: "local-only-cold-warm-benchmark",
    noModelDownload: true,
    paidInference: false,
    cloudFallback: false,
    results,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3 || process.argv[2] !== "--run") {
    console.error(
      "Run only on authorized P720: node scripts/p720-local-benchmark.mjs --run",
    );
    process.exitCode = 2;
  } else {
    const result = await benchmarkFleet();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.results?.every(
      (row) =>
        row.state === "MEASURED" ||
        (row.optional && row.state === "NOT_INSTALLED"),
    )
      ? 0
      : 2;
  }
}
