import http from "node:http";
import { fail } from "./errors.js";
import { localModelReceipt } from "./model-attribution.js";

const MODEL = "Qwen3.5-9B-Q4_K_M.gguf";
const PORT = 20145;
const MAX_RESPONSE_BYTES = 131072;

export function useP520LlamaCpp({
  enabled,
  platform,
  hostname,
  deviceId,
}) {
  return (
    enabled === "1" &&
    platform === "win32" &&
    hostname.toUpperCase() === "DESKTOP-5FVJMET" &&
    deviceId === "kmj-kmj-codebridge-desktop-5fvjmet"
  );
}

// The port is injectable for bounded localhost-only mock tests, never through
// an MCP request. Production always uses the fixed owner-installed port 20145.
function request({ port, endpoint, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: endpoint,
        method: payload === undefined ? "GET" : "POST",
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        headers:
          payload === undefined
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
          reject(new Error("LOCAL_MODEL_HTTP_ERROR"));
          return;
        }
        const parts = [];
        let bytes = 0;
        res.on("data", (part) => {
          bytes += part.length;
          if (bytes > maxBytes) {
            req.destroy(new Error("LOCAL_MODEL_RESPONSE_TOO_LARGE"));
            return;
          }
          parts.push(part);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
          } catch {
            reject(new Error("LOCAL_MODEL_RESPONSE_INVALID"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("LOCAL_MODEL_TIMEOUT")));
    req.on("error", reject);
    req.end(payload);
  });
}

function modelMatches(value) {
  if (typeof value !== "string" || value.length > 1024) return false;
  return value.split(/[\\/]/).at(-1) === MODEL;
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1000000)
    : null;
}

function boundedMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(Math.min(value, 3600000))
    : null;
}

export function createLlamaCppLocalModelClient({ port = PORT } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail("LOCAL_MODEL_INVALID_PORT");
  let busy = false;

  async function available() {
    const [health, models] = await Promise.all([
      request({
        port,
        endpoint: "/health",
        timeoutMs: 1800,
        maxBytes: 4096,
      }),
      request({
        port,
        endpoint: "/v1/models",
        timeoutMs: 1800,
        maxBytes: 65536,
      }),
    ]);
    return (
      ["ok", "no slot available"].includes(health?.status) &&
      Array.isArray(models?.data) &&
      models.data.length === 1 &&
      modelMatches(models.data[0]?.id)
    );
  }

  return {
    async status() {
      let valid = false;
      try {
        valid = await available();
      } catch {
        // A non-llama.cpp listener, cold startup or outage is not a model.
      }
      return {
        available: valid,
        provider: "local-llamacpp",
        models: valid ? [MODEL] : [],
        activeRequest: busy,
        cloudFallback: false,
        paidInference: false,
        readyForOnDemandUse: valid,
        ...(valid ? {} : { reason: "LOCAL_MODEL_NOT_RUNNING_OR_INVALID" }),
      };
    },
    async generate({ model, prompt, maxTokens = 192, timeoutSeconds = 45 }) {
      if (
        model !== MODEL ||
        typeof prompt !== "string" ||
        prompt.length < 1 ||
        prompt.length > 4096 ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 16 ||
        maxTokens > 512 ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 5 ||
        timeoutSeconds > 90
      )
        fail("LOCAL_MODEL_REQUEST_INVALID");
      if (busy) fail("LOCAL_MODEL_BUSY");
      busy = true;
      try {
        let valid = false;
        try {
          valid = await available();
        } catch {
          fail("LOCAL_MODEL_NOT_RUNNING");
        }
        if (!valid) fail("LOCAL_MODEL_NOT_INSTALLED");
        let value;
        const start = Date.now();
        try {
          value = await request({
            port,
            endpoint: "/completion",
            body: {
              prompt,
              n_predict: maxTokens,
              temperature: 0,
              seed: 42,
              stream: false,
            },
            timeoutMs: timeoutSeconds * 1000,
            maxBytes: MAX_RESPONSE_BYTES,
          });
        } catch {
          fail("LOCAL_MODEL_INFERENCE_FAILED");
        }
        const elapsedMs = Date.now() - start;
        if (typeof value?.content !== "string")
          fail("LOCAL_MODEL_RESPONSE_INVALID");
        if (!value.content.trim()) fail("LOCAL_MODEL_NO_VISIBLE_OUTPUT");
        const tokens = boundedCount(value.tokens_predicted);
        const predictedMs = boundedMs(value.timings?.predicted_ms);
        const promptMs = boundedMs(value.timings?.prompt_ms);
        const reportedRate = value.timings?.predicted_per_second;
        return {
          provider: "local-llamacpp",
          model: MODEL,
          modelUsage: localModelReceipt(MODEL, "local_model_generate", "local-llamacpp"),
          response: value.content.slice(0, 8192),
          truncated: value.content.length > 8192,
          hitTokenLimit: value.stopped_limit === true ||
            (tokens !== null && tokens >= maxTokens),
          paidInference: false,
          cloudFallback: false,
          outputIsUntrusted: true,
          modelUnloadRequested: false,
          modelWarmSeconds: null,
          evaluatedTokens: tokens,
          timing: {
            totalMs: elapsedMs,
            loadMs: null,
            promptMs,
            generationMs: predictedMs,
            promptTokens: boundedCount(value.tokens_evaluated),
            generationTokens: tokens,
            generationTokensPerSecond:
              typeof reportedRate === "number" &&
              Number.isFinite(reportedRate) &&
              reportedRate >= 0 &&
              reportedRate <= 100000
                ? Number(reportedRate.toFixed(2))
                : null,
          },
        };
      } finally {
        busy = false;
      }
    },
  };
}
