import http from "node:http";
import { fail } from "./errors.js";

const MAX_TAGS_BYTES = 65536;
const MAX_REPLY_BYTES = 131072;
const MAX_MODEL_RESULTS = 32;
const MODEL = /^[A-Za-z0-9._:/-]{1,96}$/;

// Always use Node's direct loopback HTTP client: no proxy, DNS, redirects,
// external host, arbitrary API URL, installed-model pull or paid fallback.
function jsonRequest({ port, endpoint, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: payload === null ? "GET" : "POST",
        path: endpoint,
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
          reject(new Error("LOCAL_MODEL_HTTP_ERROR"));
          return;
        }
        const parts = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error("LOCAL_MODEL_RESPONSE_TOO_LARGE"));
            return;
          }
          parts.push(chunk);
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
    req.end(payload ?? undefined);
  });
}

export function createLocalModelClient({ port = 11434 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail("LOCAL_MODEL_INVALID_PORT");
  let busy = false;
  async function tags() {
    const body = await jsonRequest({
      port,
      endpoint: "/api/tags",
      timeoutMs: 1800,
      maxBytes: MAX_TAGS_BYTES,
    });
    if (!Array.isArray(body?.models)) fail("LOCAL_MODEL_RESPONSE_INVALID");
    return body.models
      .filter((entry) => MODEL.test(entry?.name ?? ""))
      .map((entry) => entry.name)
      .slice(0, MAX_MODEL_RESULTS);
  }
  return {
    async status() {
      try {
        return {
          available: true,
          provider: "local-ollama",
          models: await tags(),
          activeRequest: busy,
          cloudFallback: false,
          paidInference: false,
          readyForOnDemandUse: true,
        };
      } catch {
        return {
          available: false,
          provider: "local-ollama",
          models: [],
          activeRequest: busy,
          cloudFallback: false,
          paidInference: false,
          readyForOnDemandUse: false,
          reason: "LOCAL_MODEL_NOT_RUNNING_OR_INVALID",
        };
      }
    },
    async generate({ model, prompt, maxTokens = 192, timeoutSeconds = 45 }) {
      if (
        !MODEL.test(model) ||
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
        let available;
        try {
          available = await tags();
        } catch {
          fail("LOCAL_MODEL_NOT_RUNNING");
        }
        if (!available.includes(model)) fail("LOCAL_MODEL_NOT_INSTALLED");
        let result;
        try {
          result = await jsonRequest({
            port,
            endpoint: "/api/generate",
            body: {
              model,
              prompt,
              stream: false,
              keep_alive: 0,
              options: { num_predict: maxTokens },
            },
            timeoutMs: timeoutSeconds * 1000,
            maxBytes: MAX_REPLY_BYTES,
          });
        } catch {
          fail("LOCAL_MODEL_INFERENCE_FAILED");
        }
        if (
          typeof result?.response !== "string" ||
          typeof result?.done !== "boolean" ||
          !result.done
        )
          fail("LOCAL_MODEL_RESPONSE_INVALID");
        return {
          provider: "local-ollama",
          model,
          response: result.response.slice(0, 8192),
          truncated: result.response.length > 8192,
          paidInference: false,
          cloudFallback: false,
          outputIsUntrusted: true,
          modelUnloadRequested: true,
          evaluatedTokens: Number.isSafeInteger(result.eval_count)
            ? Math.min(result.eval_count, 1000000)
            : null,
        };
      } finally {
        busy = false;
      }
    },
  };
}
