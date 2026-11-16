// Zero-dependency routing policy. This module never stores API keys or calls a provider.
// Admission, real provider calls, credential vault and durable persistence belong to the host.

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
// Provider model names (including OpenRouter's "vendor/model:free") are
// opaque identifiers, never filesystem paths or request URLs.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_MODELS = 64;
const MAX_RETRY_MS = 3_600_000;

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function retryDelay(headers, nowMs) {
  const raw = header(headers, "retry-after");
  if (!raw) return 60_000;
  if (/^\d{1,6}$/.test(raw))
    return Math.min(MAX_RETRY_MS, Math.max(1000, Number(raw) * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_MS, Math.max(1000, date - nowMs))
    : 60_000;
}

function header(headers, key) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(key);
  const pair = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === key,
  );
  return pair ? String(pair[1]) : null;
}

function quotaResetMs(headers, key, nowMs) {
  const raw = header(headers, key);
  if (!raw) return null;
  // Common providers report relative times like "1m20s", "7.66s".
  if (/^(?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?$/.test(raw) && /\d/.test(raw)) {
    const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
    const duration = matches.reduce(
      (sum, [, value, unit]) =>
        sum + Number(value) * { h: 3600000, m: 60000, s: 1000 }[unit],
      0,
    );
    return nowMs + Math.min(MAX_RETRY_MS, Math.max(1000, duration));
  }
  return null;
}

function quotaHeader(headers, key) {
  const value = header(headers, key);
  return value !== null && /^\d+$/.test(value)
    ? safeCount(Number(value))
    : null;
}

// Optional owner-declared free-tier ceilings for providers that report no
// rate-limit headers (e.g. OpenRouter :free = 20/min, 50/day). They let the
// policy count its own observed requests and move away BEFORE a 429.
function validLimits(limits) {
  if (limits === undefined) return true;
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    return false;
  if (Object.keys(limits).some((k) => k !== "perMinute" && k !== "perDay"))
    return false;
  return ["perMinute", "perDay"].every(
    (k) =>
      limits[k] === undefined ||
      (Number.isSafeInteger(limits[k]) &&
        limits[k] >= 1 &&
        limits[k] <= 1_000_000),
  );
}

function validateModel(model) {
  if (
    !model ||
    !MODEL_ID.test(model.id ?? "") ||
    (typeof model.id === "string" &&
      (model.id.includes("//") ||
        model.id.split("/").some((part) => part === "." || part === ".."))) ||
    !ID.test(model.provider ?? "") ||
    !["local", "cloud"].includes(model.kind) ||
    typeof model.free !== "boolean" ||
    typeof model.privateCodeAllowed !== "boolean" ||
    !validLimits(model.limits) ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1 ||
    !Array.isArray(model.capabilities) ||
    model.capabilities.length > 16 ||
    model.capabilities.some((c) => !CAPABILITY.test(c))
  )
    throw new Error("MODEL_POLICY_INVALID_CONFIG");
  return Object.freeze({
    ...model,
    capabilities: Object.freeze([...model.capabilities]),
  });
}

export class ModelFailoverPolicy {
  constructor(models, { now = Date.now, state = {}, headroom = 0.15 } = {}) {
    if (
      !Array.isArray(models) ||
      models.length < 1 ||
      models.length > MAX_MODELS ||
      typeof now !== "function" ||
      typeof headroom !== "number" ||
      !(headroom >= 0 && headroom < 1)
    )
      throw new Error("MODEL_POLICY_INVALID_CONFIG");
    // Fraction of a known limit that must stay free; at or below it a model
    // is "low" and is used only after every healthy alternative.
    this.headroom = headroom;
    this.models = models.map(validateModel);
    if (new Set(this.models.map((m) => m.id)).size !== this.models.length)
      throw new Error("MODEL_POLICY_DUPLICATE_ID");
    this.now = now;
    this.runtime = new Map();
    for (const m of this.models) {
      const prior = state[m.id] ?? {};
      const nowMs = this.now();
      this.runtime.set(m.id, {
        remainingRequests: safeCount(prior.remainingRequests),
        remainingTokens: safeCount(prior.remainingTokens),
        resetRequestsAt: safeCount(prior.resetRequestsAt),
        resetTokensAt: safeCount(prior.resetTokensAt),
        limitRequests: safeCount(prior.limitRequests),
        dayKey:
          typeof prior.dayKey === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(prior.dayKey)
            ? prior.dayKey
            : null,
        dayCount: safeCount(prior.dayCount) ?? 0,
        hits: Array.isArray(prior.hits)
          ? prior.hits
              .filter(
                (t) =>
                  Number.isSafeInteger(t) && t > nowMs - 60_000 && t <= nowMs,
              )
              .slice(-1000)
          : [],
        cooldownUntil:
          Number.isSafeInteger(prior.cooldownUntil) &&
          prior.cooldownUntil > nowMs &&
          prior.cooldownUntil < nowMs + MAX_RETRY_MS
            ? prior.cooldownUntil
            : 0,
      });
    }
  }

  // Combines declared limits, own request counters and provider headers.
  capacity(m, status) {
    const nowMs = this.now();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (status.dayKey !== today) {
      status.dayKey = today;
      status.dayCount = 0;
    }
    status.hits = status.hits.filter((t) => t > nowMs - 60_000);
    const parts = [];
    if (m.limits?.perDay)
      parts.push({
        left: m.limits.perDay - status.dayCount,
        limit: m.limits.perDay,
      });
    if (m.limits?.perMinute)
      parts.push({
        left: m.limits.perMinute - status.hits.length,
        limit: m.limits.perMinute,
      });
    if (status.remainingRequests !== null)
      parts.push({
        left: status.remainingRequests,
        limit: status.limitRequests,
      });
    const exhausted = parts.some((x) => x.left < 1);
    const low = parts.some((x) =>
      x.limit ? x.left / x.limit <= this.headroom : x.left <= 2,
    );
    const ratios = parts
      .filter((x) => x.limit)
      .map((x) => Math.max(0, x.left) / x.limit);
    return {
      exhausted,
      low: low && !exhausted,
      score: ratios.length ? Math.min(...ratios) : 0.5,
    };
  }

  // Caller must preserve the exact conversation/checkpoint. Never silently
  // truncate context, summarize without verification, or export private code.
  select({
    capability = "coding",
    inputTokens,
    maxOutputTokens,
    cloudApproved = false,
    privateCode = true,
    excluded = [],
  }) {
    if (
      !CAPABILITY.test(capability) ||
      safeCount(inputTokens) === null ||
      safeCount(maxOutputTokens) === null ||
      maxOutputTokens < 1 ||
      !Array.isArray(excluded) ||
      excluded.length > MAX_MODELS
    )
      throw new Error("MODEL_POLICY_INVALID_TASK");
    const required = inputTokens + maxOutputTokens;
    if (!Number.isSafeInteger(required))
      throw new Error("MODEL_POLICY_INVALID_TASK");
    const excludedSet = new Set(excluded);
    const eligible = this.models
      .filter((m) => {
        const status = this.runtime.get(m.id);
        if (
          status.resetRequestsAt !== null &&
          this.now() >= status.resetRequestsAt
        ) {
          status.remainingRequests = null;
          status.resetRequestsAt = null;
        }
        if (
          status.resetTokensAt !== null &&
          this.now() >= status.resetTokensAt
        ) {
          status.remainingTokens = null;
          status.resetTokensAt = null;
        }
        // Unknown cloud billing or pricing is denied even if cloud is approved.
        if (!m.free || excludedSet.has(m.id)) return false;
        if (m.kind === "cloud" && !cloudApproved) return false;
        if (m.kind === "cloud" && privateCode && !m.privateCodeAllowed)
          return false;
        if (!m.capabilities.includes(capability)) return false;
        if (m.contextWindow < required) return false;
        if (status.cooldownUntil > this.now()) return false;
        if (status.remainingRequests !== null && status.remainingRequests < 1)
          return false;
        if (this.capacity(m, status).exhausted) return false;
        // Reserve capacity for the full bounded request.
        if (
          status.remainingTokens !== null &&
          status.remainingTokens < required
        )
          return false;
        return true;
      })
      .sort((a, b) => {
        // Local-first even when cloud quota/latency would look more attractive.
        if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
        const ac = this.capacity(a, this.runtime.get(a.id));
        const bc = this.capacity(b, this.runtime.get(b.id));
        // Healthy before low-headroom: switch away before the limit is hit.
        if (ac.low !== bc.low) return ac.low ? 1 : -1;
        const aq = this.runtime.get(a.id).remainingRequests !== null;
        const bq = this.runtime.get(b.id).remainingRequests !== null;
        if (aq !== bq) return aq ? -1 : 1;
        // More remaining headroom first spreads load across providers.
        if (Math.abs(ac.score - bc.score) > 0.05) return bc.score - ac.score;
        return a.id.localeCompare(b.id);
      });
    return eligible.length
      ? {
          modelId: eligible[0].id,
          provider: eligible[0].provider,
          kind: eligible[0].kind,
          headroom: this.capacity(eligible[0], this.runtime.get(eligible[0].id))
            .low
            ? "low"
            : "ok",
        }
      : { modelId: null, reason: "NO_FREE_AUTHORIZED_CAPABLE_MODEL" };
  }

  // Feed ONLY trusted response headers from an authenticated provider transport.
  // A generic provider API does not expose a standard free-credit balance.
  observe(modelId, { statusCode, headers = null } = {}) {
    if (!this.runtime.has(modelId) || !Number.isInteger(statusCode))
      throw new Error("MODEL_POLICY_INVALID_OBSERVATION");
    const state = this.runtime.get(modelId);
    const requestRemaining =
      quotaHeader(headers, "x-ratelimit-remaining-requests") ??
      quotaHeader(headers, "x-ratelimit-remaining");
    const tokenRemaining = quotaHeader(headers, "x-ratelimit-remaining-tokens");
    const requestLimit =
      quotaHeader(headers, "x-ratelimit-limit-requests") ??
      quotaHeader(headers, "x-ratelimit-limit");
    if (requestLimit !== null && requestLimit > 0)
      state.limitRequests = requestLimit;
    // Every provider response (including 429) consumed one request.
    this.capacity(
      this.models.find((x) => x.id === modelId),
      state,
    );
    state.dayCount += 1;
    state.hits.push(this.now());
    if (state.hits.length > 1000)
      state.hits.splice(0, state.hits.length - 1000);
    if (requestRemaining !== null) state.remainingRequests = requestRemaining;
    if (tokenRemaining !== null) state.remainingTokens = tokenRemaining;
    const requestReset = quotaResetMs(
      headers,
      "x-ratelimit-reset-requests",
      this.now(),
    );
    const tokenReset = quotaResetMs(
      headers,
      "x-ratelimit-reset-tokens",
      this.now(),
    );
    // Provider responses often omit reset headers. Do not drop an existing
    // observed reset window when processing a partial quota update.
    if (requestReset !== null) state.resetRequestsAt = requestReset;
    if (tokenReset !== null) state.resetTokensAt = tokenReset;
    if (statusCode === 429) {
      state.cooldownUntil = this.now() + retryDelay(headers, this.now());
    } else if (statusCode === 401 || statusCode === 403) {
      // Invalid/forbidden keys should not be hot-looped.
      state.cooldownUntil = this.now() + MAX_RETRY_MS;
    } else if (statusCode >= 200 && statusCode < 300) {
      state.cooldownUntil = 0;
    }
    return this.status(modelId);
  }

  status(modelId) {
    const m = this.models.find((entry) => entry.id === modelId);
    if (!m) throw new Error("MODEL_POLICY_UNKNOWN_MODEL");
    const s = this.runtime.get(modelId);
    return {
      modelId,
      kind: m.kind,
      free: m.free,
      remainingRequests: s.remainingRequests,
      remainingTokens: s.remainingTokens,
      quotaKnown:
        s.remainingRequests !== null ||
        s.remainingTokens !== null ||
        Boolean(m.limits),
      headroom: this.capacity(m, s).low ? "low" : "ok",
      requestsUsedToday: s.dayCount,
      cooldownUntil: s.cooldownUntil > this.now() ? s.cooldownUntil : null,
    };
  }

  snapshot() {
    // Store this safe metadata via host-owned atomic persistence; never API keys.
    return Object.fromEntries(
      [...this.runtime].map(([id, value]) => [id, { ...value }]),
    );
  }
}
