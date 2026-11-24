// Loopback-only client for a locally installed FreeLLMAPI router
// (OpenAI-compatible, default http://127.0.0.1:31415/v1). Device-owner config
// only: the key comes from the environment, never from an MCP caller or chat.
// Only `auto:<chain>` model names are accepted so a request cannot pick a
// specific (possibly paid) upstream; the owner defines the chain in FreeLLMAPI.
import http from "node:http";
import { CodeBridgeError } from "./errors.js";
import {
  inspectFabricCatalog,
  selectFabricCandidates,
  TASK_ROUTE_PREFERENCES,
} from "./freellmapi-fabric-policy.js";

const CHAIN = /^auto:[A-Za-z0-9_-]{1,20}$/;
const KEY = /^[A-Za-z0-9._-]{8,200}$/;
const MAX_PROMPT = 32768;
const MAX_RESPONSE_BYTES = 262144;
const STATUS_TTL_MS = 60000;
export const TASKS = Object.freeze(["code", "fast", "reasoning", "general"]);
// Owner-defined FreeLLMAPI fallback chains, in preference order per task.
// Only chains FreeLLMAPI actually reports are used; "auto:default" is last.
const CHAIN_PREFERENCE = TASK_ROUTE_PREFERENCES;

export function candidateChains(task, available) {
  const preferred = CHAIN_PREFERENCE[task] ?? CHAIN_PREFERENCE.general;
  const found = preferred.filter((c) => available.includes(c));
  return found;
}

// The MCP boundary exposes only typed CodeBridgeError codes; an arbitrary
// Error with a string .code is intentionally not public to prevent leaks.
const codedError = (code) => new CodeBridgeError(code);
const fail = (code) => {
  throw codedError(code);
};

export function createFreeLlmApiClient({
  port = 31415,
  apiKey = process.env.CODEBRIDGE_FREELLMAPI_KEY,
  request = httpRequest,
  approvedFreeChains = process.env.CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS
    ? process.env.CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS.split(",")
    : [],
  now = Date.now,
  // Must be supplied by trusted device code, never an MCP caller or env flag.
  // The default is NO provider calls until zero-cost account/route proof exists.
  verifyZeroCostChain = null,
  // Optional live owner-consent callback, supplied only by trusted device code.
  authorizeGeneration = null,
} = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    fail("FREELLMAPI_INVALID_PORT");
  if (typeof apiKey !== "string" || !KEY.test(apiKey))
    fail("FREELLMAPI_KEY_NOT_CONFIGURED");
  if (typeof now !== "function") fail("FREELLMAPI_INVALID_CLOCK");
  if (verifyZeroCostChain !== null && typeof verifyZeroCostChain !== "function")
    fail("FREELLMAPI_INVALID_BILLING_ADMISSION");
  if (authorizeGeneration !== null && typeof authorizeGeneration !== "function")
    fail("FREELLMAPI_INVALID_GENERATION_AUTHORIZATION");
  const requireCurrentGenerationConsent = () => {
    if (authorizeGeneration === null) return;
    let authorized = false;
    try {
      authorized = authorizeGeneration() === true;
    } catch {
      // Never let a failing consent lookup authorize a cloud request.
    }
    if (!authorized) fail("FREELLMAPI_CLOUD_CONSENT_REQUIRED");
  };
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
  const cooldowns = new Map();
  const COOLDOWN_MS = 30000;
  const call = (method, path, body, timeoutMs, taskType) =>
    request({ port, method, path, apiKey, body, timeoutMs, taskType });
  // Read-only proof can be checked BEFORE claiming a coding task or reading
  // private project source. A second check ALWAYS runs before each POST.
  const verifyChainAdmission = async (chain) => {
    if (!CHAIN.test(chain) || !approved.has(chain))
      fail("FREELLMAPI_CHAIN_NOT_APPROVED");
    // An owner-allowed chain is NOT proof of free provider billing.
    // Require independent account + immutable route binding attestation
    // again immediately before every generation or 429 fallback attempt.
    if (!verifyZeroCostChain) fail("FREELLMAPI_ZERO_COST_NOT_ATTESTED");
    const observedAt = now();
    // Never ask an attestor to authorize an invalid wall-clock reading.
    if (!Number.isSafeInteger(observedAt)) fail("FREELLMAPI_INVALID_CLOCK");
    let proof;
    try {
      proof = await verifyZeroCostChain({
        chain,
        observedAtEpochMs: observedAt,
      });
    } catch {
      fail("FREELLMAPI_ZERO_COST_NOT_ATTESTED");
    }
    const checkedAt = now();
    // A rollback during an async billing lookup invalidates its freshness.
    if (!Number.isSafeInteger(checkedAt) || checkedAt < observedAt)
      fail("FREELLMAPI_INVALID_CLOCK");
    const ready =
      proof?.source === "authenticated_provider_billing_and_route_binding" &&
      proof.chain === chain &&
      proof.routeBindingVerified === true &&
      proof.accountNoChargeVerified === true &&
      proof.noPaidFallback === true &&
      proof.inputPriceUsdPerToken === 0 &&
      proof.outputPriceUsdPerToken === 0 &&
      Number.isSafeInteger(proof.requestsRemaining) &&
      proof.requestsRemaining > 0 &&
      Number.isSafeInteger(proof.observedAtEpochMs) &&
      proof.observedAtEpochMs <= observedAt &&
      proof.observedAtEpochMs > observedAt - 60000 &&
      Number.isSafeInteger(proof.expiresAtEpochMs) &&
      proof.expiresAtEpochMs > checkedAt &&
      proof.expiresAtEpochMs <= observedAt + 60000;
    if (!ready) fail("FREELLMAPI_ZERO_COST_NOT_ATTESTED");
    return true;
  };
  // An incomplete or malformed catalog cannot prove a chain exists.
  // Do not treat HTTP 200 without a strict model array as an empty,
  // apparently healthy catalog, nor keep valid entries beside corrupt ones.
  const readCatalogRows = async () => {
    const res = await call("GET", "/v1/models", undefined, 5000);
    if (
      !Array.isArray(res?.data) ||
      res.data.some(
        (m) =>
          !m ||
          typeof m !== "object" ||
          Array.isArray(m) ||
          typeof m.id !== "string",
      )
    )
      fail("FREELLMAPI_BAD_RESPONSE");
    return res;
  };
  const client = {
    // Read-only live catalog rows (id, availability, execution status) for
    // planning only. It proves neither zero cost nor a working generation.
    async catalog() {
      return readCatalogRows();
    },
    async checkZeroCostChain({ chain }) {
      await verifyChainAdmission(chain);
      return { admitted: true, chain };
    },
    async status({ includeUsage = false } = {}) {
      if (typeof includeUsage !== "boolean")
        fail("FREELLMAPI_INVALID_USAGE_OPTION");
      const res = await readCatalogRows();
      const ids = res.data.map((m) => m.id);
      if (new Set(ids).size !== ids.length) fail("FREELLMAPI_BAD_RESPONSE");
      const inspectedAt = now();
      if (!Number.isSafeInteger(inspectedAt) || inspectedAt < 0)
        fail("FREELLMAPI_INVALID_CLOCK");
      const fabric = inspectFabricCatalog(
        res.data,
        [...approved],
        inspectedAt,
        cooldowns,
      );
      // The router catalog may list unavailable models and does NOT prove
      // source-transfer consent, pricing, or an account's free allowance.
      cached = { at: inspectedAt, rows: res.data };
      let usage;
      if (includeUsage) {
        try {
          const raw = await call("GET", "/v1/usage", undefined, 5000);
          const valid = (n) => Number.isSafeInteger(n) && n >= 0;
          usage =
            raw &&
            /^\d{4}-\d{2}$/.test(raw.month) &&
            valid(raw.requests) &&
            valid(raw.tokens)
              ? {
                  state: "ROUTER_USAGE_OBSERVED",
                  month: raw.month,
                  requests: raw.requests,
                  tokens: raw.tokens,
                  keyDetails: "REDACTED",
                  spendOrBillingProof: "NOT_VERIFIED",
                }
              : {
                  state: "ROUTER_USAGE_UNAVAILABLE",
                  spendOrBillingProof: "NOT_VERIFIED",
                };
        } catch {
          usage = {
            state: "ROUTER_USAGE_UNAVAILABLE",
            spendOrBillingProof: "NOT_VERIFIED",
          };
        }
      }
      return {
        available: true,
        provider: "freellmapi-loopback",
        chains: ids.filter((id) => CHAIN.test(id)).slice(0, 20),
        modelCount: ids.length,
        cloudFallback: null,
        paidInference: null,
        upstreamProviderVerified: false,
        billingVerified: false,
        approvedFreeChains: ids.filter((id) => approved.has(id)).slice(0, 20),
        fabric,
        ...(includeUsage ? { usage } : {}),
      };
    },
    async generate({
      chain = "auto:default",
      prompt,
      maxTokens = 256,
      timeoutSeconds = 60,
      localProcessingApproved,
      upstreamCloudApproved,
      taskType,
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
      if (
        taskType !== undefined &&
        !["code", "chat", "auto"].includes(taskType)
      )
        fail("FREELLMAPI_INVALID_TASK_TYPE");
      requireCurrentGenerationConsent();
      await verifyChainAdmission(chain);
      // Billing and route attestation awaits can outlive owner consent.
      // Recheck synchronously at the outbound request boundary, without
      // another await between this check and the loopback transport call.
      requireCurrentGenerationConsent();
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
        taskType,
      );
      const choice = res?.choices?.[0];
      // A successful HTTP status is not proof of a valid completion.
      // Reject ambiguous/malformed bodies rather than reporting false
      // successful coding or discarding a provider-side error as empty text.
      if (
        !Array.isArray(res?.choices) ||
        res.choices.length !== 1 ||
        !choice ||
        typeof choice !== "object" ||
        Array.isArray(choice) ||
        typeof choice.message?.content !== "string" ||
        choice.message.content.length === 0 ||
        !["stop", "length"].includes(choice.finish_reason)
      )
        fail("FREELLMAPI_BAD_COMPLETION");
      return {
        provider: "freellmapi-loopback",
        chain,
        response: choice.message.content.slice(0, 65536),
        hitTokenLimit: choice.finish_reason === "length",
        outputIsUntrusted: true,
        cloudFallback: null,
        paidInference: null,
        upstreamProviderVerified: false,
        billingVerified: false,
        zeroCostRouteAdmissionVerified: true,
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
      // A safe start time can still overflow the exact integer range when
      // adding the request budget; reject before discovery or cloud POST.
      if (!Number.isSafeInteger(deadline)) fail("FREELLMAPI_INVALID_CLOCK");
      // Even explicit chains must be advertised, approved and discovered.
      // A non-monotonic clock must not extend the lifetime of a previously
      // discovered route catalog. Fail closed on invalid timestamps and
      // re-discover on rollback before selecting any cloud chain.
      if (!Number.isSafeInteger(startedAt)) fail("FREELLMAPI_INVALID_CLOCK");
      if (
        !cached ||
        startedAt < cached.at ||
        startedAt - cached.at > STATUS_TTL_MS
      )
        await client.status();
      const planningAt = now();
      if (!Number.isSafeInteger(planningAt) || planningAt < startedAt)
        fail("FREELLMAPI_INVALID_CLOCK");
      const fabric = inspectFabricCatalog(
        cached.rows,
        [...approved],
        planningAt,
        cooldowns,
      );
      const candidates = selectFabricCandidates(fabric, task, chain);
      if (candidates.length === 0) {
        if (
          fabric.routes.some(
            (r) =>
              r.reason === "RECENT_429_COOLDOWN" ||
              r.reason === "QUOTA_EXHAUSTED",
          )
        )
          fail("FREELLMAPI_QUOTA_EXHAUSTED");
        fail("FREELLMAPI_NO_APPROVED_CHAIN");
      }
      const attempts = [];
      let lastAttemptAt = startedAt;
      for (const candidate of candidates.slice(0, 2)) {
        const attemptAt = now();
        // A rollback or invalid clock after catalog discovery must never
        // extend a cloud route's budget or allow a fallback POST.
        if (!Number.isSafeInteger(attemptAt) || attemptAt < lastAttemptAt)
          fail("FREELLMAPI_INVALID_CLOCK");
        lastAttemptAt = attemptAt;
        const remainingMs = deadline - attemptAt;
        // Reserve enough for one meaningful request; do not begin a second
        // cloud request with only milliseconds remaining after a 429.
        if (remainingMs < 4500) fail("FREELLMAPI_DEADLINE_EXCEEDED");
        const remainingSeconds = Math.min(
          totalSeconds,
          Math.ceil(remainingMs / 1000),
        );
        try {
          const out = await client.generate({
            ...rest,
            chain: candidate,
            timeoutSeconds: remainingSeconds,
            taskType:
              task === "code" ? "code" : task === "reasoning" ? "auto" : "chat",
          });
          return {
            ...out,
            routing: { task, chosen: candidate, attempts },
          };
        } catch (error) {
          if (error.message !== "FREELLMAPI_QUOTA_EXHAUSTED") throw error;
          cooldowns.set(candidate, attemptAt + COOLDOWN_MS);
          attempts.push({ chain: candidate, outcome: "quota_exhausted" });
        }
      }
      fail("FREELLMAPI_QUOTA_EXHAUSTED");
    },
  };
  return client;
}

function httpRequest({
  port,
  method,
  path,
  apiKey,
  body,
  timeoutMs,
  taskType,
}) {
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
          ...(taskType ? { "x-freellm-task-type": taskType } : {}),
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
            req.destroy(codedError("FREELLMAPI_TOO_LARGE"));
          else chunks.push(c);
        });
        res.on("end", () => {
          if (res.statusCode === 429)
            return reject(codedError("FREELLMAPI_QUOTA_EXHAUSTED"));
          if (res.statusCode < 200 || res.statusCode > 299)
            return reject(codedError(`FREELLMAPI_HTTP_${res.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(codedError("FREELLMAPI_BAD_RESPONSE"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(codedError("FREELLMAPI_TIMEOUT")));
    req.on("error", reject);
    req.end(payload);
  });
}
