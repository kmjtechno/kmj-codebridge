// Pure, deny-by-default multi-provider model inventory for planSmartModelRoute.
// No network, no secrets, no imports. The OWNER registry decides which models may
// ever be routed (free-tier assertions, limits, privacy); a FreeLLMAPI /v1/models
// catalog only overlays LIVE signals (ready / exhausted / needs key, context size).
// A catalog row that is not in the owner registry is never admitted. This is
// planning input only: it does not prove zero cost and never enables generation.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const MAX_MODELS = 64;
const READY = "ready";

const num = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined;

function entry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  const provider =
    typeof raw.provider === "string" && ID.test(raw.provider)
      ? raw.provider
      : null;
  const contextWindow = num(raw.contextWindow, 1, 1_000_000);
  if (!id || !provider || !contextWindow) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c) => typeof c === "string" && ID.test(c))
    : [];
  return { ...raw, id, provider, contextWindow, capabilities };
}

export function buildRoutingInventory({
  ownerRegistry,
  catalog = null,
  nowMs,
} = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("INVENTORY_BAD_TIME");
  if (!Array.isArray(ownerRegistry)) throw new Error("INVENTORY_BAD_REGISTRY");
  const live = new Map();
  for (const row of Array.isArray(catalog?.data) ? catalog.data : []) {
    if (row && typeof row.id === "string") live.set(row.id, row);
  }
  const seen = new Set();
  const models = [];
  const rejected = [];
  for (const raw of ownerRegistry) {
    const m = entry(raw);
    if (!m || seen.has(m.id)) {
      rejected.push(typeof raw?.id === "string" ? raw.id : "?");
      continue;
    }
    seen.add(m.id);
    const row = live.get(m.id);
    if (catalog) {
      // Live overlay: anything not positively ready is demoted out of routing.
      const ready = row?.available === true && row.execution_status === READY;
      m.health = ready ? "ok" : "error";
      m.available = ready;
      if (ready) {
        m.modelsDiscoveredAtMs = nowMs;
        const ctx = num(row.context_window, 1, 1_000_000);
        if (ctx) m.contextWindow = Math.min(m.contextWindow, ctx);
      }
    }
    models.push(m);
  }
  if (models.length > MAX_MODELS) throw new Error("INVENTORY_TOO_MANY_MODELS");
  return { models, rejected, liveOverlay: catalog !== null };
}
