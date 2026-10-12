import http from "node:http";
import { fail } from "./errors.js";

const MAX_TAGS_BYTES = 65536;
const MAX_REPLY_BYTES = 131072;
const MAX_MODEL_RESULTS = 32;
const MAX_WARM_SECONDS = 60;
const MODEL = /^[A-Za-z0-9._:/-]{1,96}$/;
// Qwen3 can spend the entire bounded prediction allowance in its thinking
// channel and return no visible text. Ask Ollama to skip reasoning for these
// local, tool-oriented short responses without changing the user's prompt.
const NON_THINKING_MODEL = /^qwen3(?::|$)/i;

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

// Fixed loopback-only ports verified on KMJ P720 plus the standard Ollama port.
// Explicit ports are accepted only by the locally configured agent factory
// (not supplied by an arbitrary MCP chat/tool invocation).
const DEFAULT_PORTS = Object.freeze([11434, 11435, 11436]);

export function createLocalModelClient(options = {}) {
  // Opt-in, owner-local warm retention avoids paying cold model-load cost
  // between nearby requests. Default 0 preserves low idle VRAM usage.
  const warmSeconds =
    options.warmSeconds ??
    (process.env.CODEBRIDGE_LOCAL_MODEL_WARM_SECONDS === undefined
      ? 0
      : Number(process.env.CODEBRIDGE_LOCAL_MODEL_WARM_SECONDS));
  if (!Number.isInteger(warmSeconds) || warmSeconds < 0 || warmSeconds > MAX_WARM_SECONDS)
    fail("LOCAL_MODEL_INVALID_WARM_SECONDS");
  const configured = options.ports ?? [options.port ?? DEFAULT_PORTS[0]];
  const ports =
    options.ports === undefined && options.port === undefined
      ? [...DEFAULT_PORTS]
      : configured;
  if (
    !Array.isArray(ports) ||
    ports.length < 1 ||
    ports.length > 3 ||
    new Set(ports).size !== ports.length ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  )
    fail("LOCAL_MODEL_INVALID_PORT");
  let busy = false;
  async function tags(port) {
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
  async function discover() {
    // Independent local instances are probed concurrently, with a strict
    // per-port deadline. An offline instance does not block another instance.
    const found = await Promise.all(
      ports.map(async (port) => {
        try {
          return { port, models: await tags(port) };
        } catch {
          return null;
        }
      }),
    );
    return found.filter(Boolean);
  }
  return {
    async status() {
      const found = await discover();
      const models = [...new Set(found.flatMap((row) => row.models))].slice(
        0,
        MAX_MODEL_RESULTS,
      );
      return {
        available: found.length > 0,
        provider: "local-ollama",
        models,
        activeRequest: busy,
        cloudFallback: false,
        paidInference: false,
        readyForOnDemandUse: found.length > 0 && models.length > 0,
        ...(found.length === 0
          ? { reason: "LOCAL_MODEL_NOT_RUNNING_OR_INVALID" }
          : {}),
      };
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
        const found = await discover();
        if (found.length === 0) fail("LOCAL_MODEL_NOT_RUNNING");
        const selected = found.find((row) => row.models.includes(model));
        if (!selected) fail("LOCAL_MODEL_NOT_INSTALLED");
        let result;
        try {
          result = await jsonRequest({
            port: selected.port,
            endpoint: "/api/generate",
            body: {
              model,
              prompt,
              stream: false,
              // Qwen3's thinking tokens otherwise can exhaust the limit
              // before any user-visible answer (e.g. qwen3:8b).
              ...(NON_THINKING_MODEL.test(model) ? { think: false } : {}),
              keep_alive: warmSeconds === 0 ? 0 : `${warmSeconds}s`,
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
        // A done:true response with only internal thinking is not a usable
        // output. Fail closed instead of claiming successful generation.
        if (result.response.trim().length === 0)
          fail("LOCAL_MODEL_NO_VISIBLE_OUTPUT");
        return {
          provider: "local-ollama",
          model,
          response: result.response.slice(0, 8192),
          truncated: result.response.length > 8192,
          paidInference: false,
          cloudFallback: false,
          outputIsUntrusted: true,
          modelUnloadRequested: warmSeconds === 0,
          modelWarmSeconds: warmSeconds,
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
