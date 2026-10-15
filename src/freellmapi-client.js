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
const STATUS_TTL_MS = 60000;
export const TASKS = Object.freeze(["code", "fast", "reasoning", "general"]);
// Owner-defined FreeLLMAPI fallback chains, in preference order per task.
// Only chains FreeLLMAPI actually reports are used; "auto:default" is last.
const CHAIN_PREFERENCE = Object.freeze({
  code: ["auto:code", "auto:coder", "auto:default"],
  fast: ["auto:fast", "auto:default"],
  reasoning: ["auto:smart", "auto:reasoning", "auto:default"],
  general: ["auto:default"],
});

export function candidateChains(task, available) {
  const preferred = CHAIN_PREFERENCE[task] ?? CHAIN_PREFERENCE.general;
  const found = preferred.filter((c) => available.includes(c));
  return found;
}

const fail = (code) => {
  throw new Error(code);
};

export function createFreeLlmApiClient({
  port = 31415,
  apiKey = process.env.CODEBRIDGE_FREELLMAPI_KEY,
  request = httpRequest,
  approvedFreeChains = process.env.CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS
    ? process.env.CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS.split(",")
    : [],
  now = Date.now,
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail("FREELLMAPI_INVALID_PORT");
  if (typeof apiKey !== "string" || !KEY.test(apiKey))
    fail("FREELLMAPI_KEY_NOT_CONFIGURED");
  if (typeof now !== "function") fail("FREELLMAPI_INVALID_CLOCK");
  if (
    !Array.isArray(approvedFreeChains) ||
    approvedFreeChains.length > 20 ||
    approvedFreeChains.some(
      (name) => typeof name !== "string" || !CHAIN.test(name),
    )
  )
    fail("FREELLMAPI_INVALID_APPROVED_CHAINS");
  // Owner approved != audited free pricing; upstream may still use cloud.
  const approved = new Set(approvedFreeChains);
  let cached = null;
  const call = (method, path, body, timeoutMs) =>
    request({ port, method, path, apiKey, body, timeoutMs });
  const client = {
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
        // Loopback only proves the local proxy address, not its upstream.
        cloudFallback: null,
        paidInference: null,
        upstreamProviderVerified: false,
        billingVerified: false,
        approvedFreeChains: ids.filter((id) => approved.has(id)).slice(0, 20),
      };
    },
    async generate({
      chain = "auto:default",
      prompt,
      maxTokens = 256,
      timeoutSeconds = 60,
      localProcessingApproved,
      upstreamCloudApproved,
    }) {
      if (localProcessingApproved !== true) fail("FREELLMAPI_CONSENT_REQUIRED");
      if (upstreamCloudApproved !== true)
        fail("FREELLMAPI_CLOUD_CONSENT_REQUIRED");
      if (!CHAIN.test(chain)) fail("FREELLMAPI_CHAIN_NOT_ALLOWED");
      if (!approved.has(chain)) fail("FREELLMAPI_CHAIN_NOT_APPROVED");
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
        cloudFallback: null,
        paidInference: null,
        upstreamProviderVerified: false,
        billingVerified: false,
        actualUpstreamModel: null,
        writesApplied: false,
      };
    },
    // Smart routing: pick the owner's best-matching free chain for the task
    // and, if its quota is exhausted, try the next candidate chain once.
    async generateRouted({ task = "general", chain, ...rest }) {
      if (!TASKS.includes(task)) fail("FREELLMAPI_INVALID_TASK");
      if (rest.localProcessingApproved !== true)
        fail("FREELLMAPI_CONSENT_REQUIRED");
      if (rest.upstreamCloudApproved !== true)
        fail("FREELLMAPI_CLOUD_CONSENT_REQUIRED");
      // One end-to-end time budget shared by discovery AND every attempted
      // chain. This must fit the gateway's timeoutSeconds + 15s allowance.
      const totalSeconds = rest.timeoutSeconds ?? 60;
      if (
        !Number.isInteger(totalSeconds) ||
        totalSeconds < 5 ||
        totalSeconds > 90
      )
        fail("FREELLMAPI_INVALID_TIMEOUT");
      const startedAt = now();
      const deadline = startedAt + totalSeconds * 1000;
      // Even explicit chains must be advertised, approved and discovered.
      if (!cached || startedAt - cached.at > STATUS_TTL_MS)
        cached = { at: startedAt, chains: (await client.status()).chains };
      const candidates = (
        chain === undefined
          ? candidateChains(task, cached.chains)
          : cached.chains.includes(chain)
            ? [chain]
            : []
      ).filter((name) => approved.has(name));
      if (candidates.length === 0) fail("FREELLMAPI_NO_APPROVED_CHAIN");
      const attempts = [];
      for (const candidate of candidates.slice(0, 2)) {
        const remainingMs = deadline - now();
        // Reserve enough for one meaningful request; do not begin a second
        // cloud request with only milliseconds remaining after a 429.
        if (remainingMs < 4500)
          fail("FREELLMAPI_DEADLINE_EXCEEDED");
        const remainingSeconds = Math.min(
          totalSeconds,
          Math.ceil(remainingMs / 1000),
        );
        try {
          const out = await client.generate({
            ...rest,
            chain: candidate,
            timeoutSeconds: remainingSeconds,
          });
          return {
            ...out,
            routing: { task, chosen: candidate, attempts },
          };
        } catch (error) {
          if (error.message !== "FREELLMAPI_QUOTA_EXHAUSTED") throw error;
          attempts.push({ chain: candidate, outcome: "quota_exhausted" });
        }
      }
      fail("FREELLMAPI_QUOTA_EXHAUSTED");
    },
  };
  return client;
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
