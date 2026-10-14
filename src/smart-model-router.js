import { ModelFailoverPolicy } from "./model-failover-policy.js";

// Advisory-only AI-chat route plan for CodeBridge-controlled inference.
// A host chat app (ChatGPT/Claude/Gemini) selects its own host model. This
// module cannot change it, execute prompts, check balances, or send API calls.
const STRATEGIES = new Set([
  "local-first",
  "approved-free-cloud-first",
  "fastest",
  "highest-quality",
]);
const SHA = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_MODELS = 64;
const MAX_ROUTE = 8;

function metric(value, max, name) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    throw new Error("SMART_MODEL_ROUTER_INVALID_" + name);
  return value;
}

function profile(model) {
  if (!model || typeof model !== "object") {
    throw new Error("SMART_MODEL_ROUTER_INVALID_MODEL");
  }
  // These are hints supplied by the authorized client; no claim of actual
  // benchmark proof is made. Unmeasured values use conservative defaults.
  const quality =
    model.qualityScore === undefined
      ? 50
      : metric(model.qualityScore, 100, "QUALITY");
  const reliability =
    model.reliabilityPct === undefined
      ? 70
      : metric(model.reliabilityPct, 100, "RELIABILITY");
  const latency =
    model.p95LatencyMs === undefined
      ? 120000
      : metric(model.p95LatencyMs, 120000, "LATENCY");
  if (
    model.kind === "cloud" &&
    (model.freeTierVerified !== true || model.costPerMillionTokensUsd !== 0)
  )
    return null;
  if (
    model.kind === "local" &&
    model.costPerMillionTokensUsd !== undefined &&
    model.costPerMillionTokensUsd !== 0
  )
    return null;
  return { quality, reliability, latency };
}

function score(model, m, strategy, tokens) {
  const fast = Math.max(0, 100 - (m.latency / 120000) * 100);
  const contextSlack = Math.max(
    0,
    Math.min(100, ((model.contextWindow - tokens) / model.contextWindow) * 100),
  );
  const weights =
    strategy === "fastest"
      ? [0.16, 0.58, 0.21, 0.05]
      : strategy === "highest-quality"
        ? [0.6, 0.1, 0.25, 0.05]
        : [0.38, 0.27, 0.3, 0.05];
  return (
    weights[0] * m.quality +
    weights[1] * fast +
    weights[2] * m.reliability +
    weights[3] * contextSlack
  );
}

// Routing permissions are fail-closed. Cloud providers must be explicitly
// approved AND have separately attested free-tier and zero-price metadata.
// A fabricated client assertion cannot authorize an actual cloud request:
// transport credentials, user consent and billing gates remain host-owned.
export function planSmartModelRoute({
  models,
  task,
  state = {},
  nowMs = Date.now(),
} = {}) {
  if (
    !Array.isArray(models) ||
    models.length < 1 ||
    models.length > MAX_MODELS ||
    !task ||
    typeof task !== "object" ||
    !STRATEGIES.has(task.strategy ?? "local-first") ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    typeof task.cloudApproved !== "boolean" ||
    typeof task.privateCode !== "boolean" ||
    !Number.isSafeInteger(task.inputTokens) ||
    !Number.isSafeInteger(task.maxOutputTokens) ||
    task.inputTokens < 0 ||
    task.maxOutputTokens < 1 ||
    !SHA.test(task.capability ?? "coding") ||
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  )
    throw new Error("SMART_MODEL_ROUTER_INVALID_TASK");
  const strategy = task.strategy ?? "local-first";
  // validate all hint data eagerly, not only the eventually eligible models
  const hintById = new Map(models.map((m) => [m.id, profile(m)]));
  const policy = new ModelFailoverPolicy(models, {
    now: () => nowMs,
    state,
  });
  const excluded = [];
  const options = [];
  while (excluded.length < models.length) {
    const selection = policy.select({
      capability: task.capability ?? "coding",
      inputTokens: task.inputTokens,
      maxOutputTokens: task.maxOutputTokens,
      cloudApproved: task.cloudApproved,
      privateCode: task.privateCode,
      excluded,
    });
    if (!selection.modelId) break;
    excluded.push(selection.modelId);
    const model = models.find(
      (candidate) => candidate.id === selection.modelId,
    );
    const hint = hintById.get(model.id);
    if (!hint) continue;
    options.push({
      modelId: model.id,
      provider: model.provider,
      kind: model.kind,
      rankScore:
        Math.round(
          score(
            model,
            hint,
            strategy,
            task.inputTokens + task.maxOutputTokens,
          ) * 100,
        ) / 100,
      latencyEstimateMs: hint.latency,
      qualityEstimate: hint.quality,
      reliabilityEstimatePct: hint.reliability,
    });
  }
  options.sort((a, b) => {
    if (strategy === "local-first" && a.kind !== b.kind)
      return a.kind === "local" ? -1 : 1;
    if (strategy === "approved-free-cloud-first" && a.kind !== b.kind)
      return a.kind === "cloud" ? -1 : 1;
    return b.rankScore - a.rankScore || a.modelId.localeCompare(b.modelId);
  });
  const ranked = options.slice(0, MAX_ROUTE).map((option, index) => ({
    ...option,
    order: index + 1,
  }));
  return {
    selected: ranked[0] ?? null,
    fallbacks: ranked.slice(1),
    eligibleCount: options.length,
    strategy,
    capability: task.capability ?? "coding",
    requiredContextTokens: task.inputTokens + task.maxOutputTokens,
    cloudAllowedForPlanning: task.cloudApproved,
    privateCode: task.privateCode,
    outcome:
      ranked.length > 0
        ? "ROUTE_PLAN_READY"
        : "NO_FREE_AUTHORIZED_CAPABLE_MODEL",
    modelExecution: "NOT_EXECUTED",
    hostChatModel: "NOT_OBSERVABLE_OR_SWITCHABLE_BY_CODEBRIDGE",
    metadataProvenance: "CALLER_SUPPLIED_NOT_VERIFIED_BY_CODEBRIDGE",
    pricingGuarantee: "HOST_MUST_VERIFY_BEFORE_REAL_PROVIDER_CALL",
    promptOrConversationTransferred: false,
  };
}
