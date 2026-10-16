import http from "node:http";

// Optional local-only inference adapter. Not wired into MCP tool discovery or
// auto-routing: the device owner must explicitly opt in after compatibility
// checks. Kyojin's published AMD gfx1151 performance is NOT a P720 benchmark.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const MAX_RESPONSE_BYTES = 65536;
const MAX_MODELS = 32;
const MAX_OUTPUT_CHARS = 16384;

function invalid(code) {
  throw new Error("KYOJIN_" + code);
}

function requestJson(port, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: payload === null ? "GET" : "POST",
        timeout: timeoutMs,
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
        // Never follow redirects or trust remote URLs/alternative hosts.
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("KYOJIN_HTTP_NOT_OK"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("KYOJIN_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("KYOJIN_RESPONSE_INVALID"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("KYOJIN_TIMEOUT")));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

function parseModels(payload) {
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    payload.data.length > MAX_MODELS
  ) {
    invalid("CATALOG_INVALID");
  }
  const names = payload.data.map((entry) => entry?.id);
  if (
    names.some((name) => typeof name !== "string" || !MODEL_ID.test(name)) ||
    new Set(names).size !== names.length
  ) {
    invalid("CATALOG_INVALID");
  }
  return names;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000
    ? value
    : null;
}

// Port is local administrator configuration, never an MCP request parameter.
// Enabled=false makes zero HTTP calls and never loads/downloads any model.
export function createKyojinLocalBackend({
  enabled = false,
  port = 8000,
} = {}) {
  if (
    typeof enabled !== "boolean" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    invalid("CONFIG_INVALID");
  }
  let busy = false;

  async function models() {
    return parseModels(await requestJson(port, "/v1/models", undefined, 1800));
  }

  return {
    async status() {
      if (!enabled) {
        return {
          enabled: false,
          available: false,
          reason: "KYOJIN_NOT_ENABLED",
          modelExecution: "NOT_EXECUTED",
        };
      }
      try {
        const names = await models();
        return {
          enabled: true,
          available: names.length > 0,
          models: names,
          provider: "kyojin-loopback",
          backendIdentityVerified: false,
          modelExecution: "NOT_EXECUTED",
          activeRequest: busy,
        };
      } catch {
        return {
          enabled: true,
          available: false,
          reason: "KYOJIN_BACKEND_UNAVAILABLE_OR_INVALID",
          modelExecution: "NOT_EXECUTED",
          activeRequest: busy,
        };
      }
    },

    async generate({
      model,
      prompt,
      localProcessingApproved = false,
      maxTokens = 192,
      timeoutSeconds = 45,
    } = {}) {
      if (!enabled) invalid("NOT_ENABLED");
      if (localProcessingApproved !== true) invalid("APPROVAL_REQUIRED");
      if (
        typeof model !== "string" ||
        !MODEL_ID.test(model) ||
        typeof prompt !== "string" ||
        prompt.length < 1 ||
        prompt.length > 4096 ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 16 ||
        maxTokens > 512 ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 5 ||
        timeoutSeconds > 90
      ) {
        invalid("REQUEST_INVALID");
      }
      if (busy) invalid("BUSY");
      busy = true;
      try {
        // Never generate with a model missing from this local catalog.
        const availableModels = await models();
        if (!availableModels.includes(model)) invalid("MODEL_NOT_INSTALLED");
        const result = await requestJson(
          port,
          "/v1/chat/completions",
          {
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
            stream: false,
          },
          timeoutSeconds * 1000,
        );
        const answer = result?.choices?.[0]?.message?.content;
        if (
          result?.model !== model ||
          typeof answer !== "string" ||
          answer.length < 1 ||
          answer.length > MAX_OUTPUT_CHARS
        ) {
          invalid("GENERATION_INVALID");
        }
        return {
          provider: "kyojin-loopback",
          model,
          output: answer,
          promptTokens: tokenCount(result?.usage?.prompt_tokens),
          completionTokens: tokenCount(result?.usage?.completion_tokens),
          transport: "LOCAL_LOOPBACK_ONLY",
          modelExecution: "LOCAL_BACKEND_RESPONDED",
          backendIdentityVerified: false,
          billingVerified: false,
          cloudFallbackByAdapter: false,
          toolCallsExecuted: false,
        };
      } catch (error) {
        if (
          error?.message === "KYOJIN_MODEL_NOT_INSTALLED" ||
          error?.message === "KYOJIN_GENERATION_INVALID"
        ) {
          throw error;
        }
        invalid("BACKEND_UNAVAILABLE_OR_INVALID");
      } finally {
        busy = false;
      }
    },
  };
}
