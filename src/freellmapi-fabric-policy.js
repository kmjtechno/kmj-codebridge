// Read-only FreeLLMAPI control-plane projection.
// The router catalog describes availability, NOT free price, account billing,
// provider authorization or route-member immutability.
const CHAIN = /^auto:[A-Za-z0-9_-]{1,20}$/;
const STATE = new Set(["ready", "needsKey", "exhausted"]);
export const TASK_ROUTE_PREFERENCES = Object.freeze({
  code: Object.freeze(["auto:code", "auto:coding", "auto:coder", "auto:smart", "auto:default"]),
  fast: Object.freeze(["auto:fast", "auto:reliable", "auto:default"]),
  reasoning: Object.freeze(["auto:reasoning", "auto:smart", "auto:reliable", "auto:default"]),
  general: Object.freeze(["auto:balanced", "auto:default"]),
});
const MAX_CATALOG = 4096;

export function inspectFabricCatalog(rows, approvedChains, nowMs, cooldowns = new Map()) {
  if (!Array.isArray(rows) || rows.length > MAX_CATALOG ||
      !Array.isArray(approvedChains) || approvedChains.length > 20 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !(cooldowns instanceof Map)) throw new Error("FREELLMAPI_INVALID_CATALOG");
  const indexed = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.id !== "string" || indexed.has(row.id))
      throw new Error("FREELLMAPI_BAD_RESPONSE");
    indexed.set(row.id, row);
  }
  const approved = [...new Set(approvedChains)];
  if (approved.some((name) => typeof name !== "string" || !CHAIN.test(name)))
    throw new Error("FREELLMAPI_INVALID_CATALOG");
  const routes = approved.map((chain) => {
    const row = indexed.get(chain);
    const published = !!row;
    const state = STATE.has(row?.execution_status) ? row.execution_status : "unknown";
    const cooldownUntil = cooldowns.get(chain) ?? 0;
    const cooling = Number.isSafeInteger(cooldownUntil) && cooldownUntil > nowMs;
    // Explicitly negative router evidence is meaningful; absence of fields
    // is UNKNOWN, not proof of route readiness or successful upstream.
    const excluded = !published || cooling || state === "needsKey" ||
      state === "exhausted" || row?.available === false;
    const reason = !published ? "NOT_ADVERTISED" :
      cooling ? "RECENT_429_COOLDOWN" :
      state === "needsKey" ? "NEEDS_PROVIDER_KEY" :
      state === "exhausted" ? "QUOTA_EXHAUSTED" :
      row.available === false ? "ROUTER_UNAVAILABLE" :
      state === "ready" && row.available === true ? "ROUTER_READY_COST_UNVERIFIED" :
      "ROUTER_STATUS_UNKNOWN";
    return {
      chain,
      routeStatus: excluded ? "EXCLUDED" : "CANDIDATE",
      reason,
      // Do not leak per-key labels, provider secrets, model aliases or URLs.
      zeroCostProof: "NOT_PROVEN_BY_ROUTER_CATALOG",
      billingProof: "NOT_PROVEN_BY_ROUTER_CATALOG",
    };
  });
  const usable = new Set(routes.filter((r) => r.routeStatus === "CANDIDATE").map((r) => r.chain));
  const taskRoutes = Object.fromEntries(Object.entries(TASK_ROUTE_PREFERENCES).map(([task, preference]) =>
    [task, preference.filter((chain) => usable.has(chain))]));
  return {
    modelCount: rows.length,
    advertisedAutoChains: rows.filter((x) => CHAIN.test(x.id)).length,
    approvedChainCount: approved.length,
    eligibleCandidateCount: usable.size,
    routes,
    taskRoutes,
    inferenceReady: false,
    whyNotReady: "ACCOUNT_PRICE_QUOTA_ROUTE_AND_CONSENT_NOT_VERIFIED",
    generation: "NOT_EXECUTED",
  };
}

export function selectFabricCandidates(overview, task, explicitChain) {
  if (!overview || !TASK_ROUTE_PREFERENCES[task] ||
      (explicitChain !== undefined && (typeof explicitChain !== "string" || !CHAIN.test(explicitChain))))
    throw new Error("FREELLMAPI_INVALID_ROUTE_PLAN");
  const eligible = new Set(overview.routes.filter((r) => r.routeStatus === "CANDIDATE").map((r) => r.chain));
  return explicitChain !== undefined
    ? (eligible.has(explicitChain) ? [explicitChain] : [])
    : [...overview.taskRoutes[task]];
}
