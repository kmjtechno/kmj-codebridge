// Loopback-only client for a locally installed FreeLLMAPI router
// (OpenAI-compatible, default http://127.0.0.1:31415/v1). Device-owner config
// only: the key comes from the environment, never from an MCP caller or chat.
// Only `auto:<chain>` model names are accepted so a request cannot pick a
// specific (possibly paid) upstream; the owner defines the chain in FreeLLMAPI.
import http from "node:http";

const CHAIN = /^auto:[A-Za-z0-9_-]{1,20}$/;
const KEY = /^[A-Za-z0-9._-]{8,200}$/;
const MAX_PROMPT = 32768;
const MAX_RESPONSE_BYTES = 262144;

const fail = (code) => {
  throw new Error(code);
};

export function createFreeLlmApiClient({
  port = 31415,
  apiKey = process.env.CODEBRIDGE_FREELLMAPI_KEY,
  request = httpRequest,
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail("FREELLMAPI_INVALID_PORT");
  if (typeof apiKey !== "string" || !KEY.test(apiKey))
    fail("FREELLMAPI_KEY_NOT_CONFIGURED");
  const call = (method, path, body, timeoutMs) =>
    request({ port, method, path, apiKey, body, timeoutMs });
  return {
    async status() {
      const res = await call("GET", "/v1/models", undefined, 5000);
      const ids = (res?.data ?? [])
        .map((m) => m?.id)
        .filter((id) => typeof id === "string");
      return {
        available: true,
        provider: "freellmapi-loopback",
        chains: ids.filter((id) => CHAIN.test(id)).slice(0, 20),
        modelCount: ids.length,
        cloudFallback: false,
        paidInference: false,
      };
    },
    async generate({
      chain = "auto:default",
      prompt,
      maxTokens = 256,
      timeoutSeconds = 60,
      localProcessingApproved,
    }) {
      if (localProcessingApproved !== true) fail("FREELLMAPI_CONSENT_REQUIRED");
      if (!CHAIN.test(chain)) fail("FREELLMAPI_CHAIN_NOT_ALLOWED");
      if (typeof prompt !== "string" || !prompt || prompt.length > MAX_PROMPT)
        fail("FREELLMAPI_INVALID_PROMPT");
      if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 2048)
        fail("FREELLMAPI_INVALID_MAX_TOKENS");
      if (
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 5 ||
        timeoutSeconds > 90
      )
        fail("FREELLMAPI_INVALID_TIMEOUT");
      const res = await call(
        "POST",
        "/v1/chat/completions",
        {
          model: chain,
          stream: false,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        },
        timeoutSeconds * 1000,
      );
      const choice = res?.choices?.[0];
      return {
        provider: "freellmapi-loopback",
        chain,
        response: String(choice?.message?.content ?? "").slice(0, 65536),
        hitTokenLimit: choice?.finish_reason === "length",
        outputIsUntrusted: true,
        cloudFallback: false,
        paidInference: false,
        writesApplied: false,
      };
    },
  };
}

function httpRequest({ port, method, path, apiKey, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES)
            req.destroy(new Error("FREELLMAPI_TOO_LARGE"));
          else chunks.push(c);
        });
        res.on("end", () => {
          if (res.statusCode === 429)
            return reject(new Error("FREELLMAPI_QUOTA_EXHAUSTED"));
          if (res.statusCode < 200 || res.statusCode > 299)
            return reject(new Error(`FREELLMAPI_HTTP_${res.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("FREELLMAPI_BAD_RESPONSE"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("FREELLMAPI_TIMEOUT")));
    req.on("error", reject);
    req.end(payload);
  });
}
