// Explicit model-use attribution for CodeBridge inference only.
// This does NOT identify a host chat application's own GPT/Claude/Gemini model.
// No prompts, responses, secrets, URLs, account IDs or lease tokens enter receipts.
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,96}$/;
const OPERATIONS = new Set([
  "local_model_generate",
  "autopilot_local_draft",
  "autopilot_local_worker",
  "autopilot_coding_worker",
]);

export function localModelReceipt(model, operation) {
  if (
    typeof model !== "string" ||
    !MODEL_ID.test(model) ||
    !OPERATIONS.has(operation)
  )
    throw new TypeError("INVALID_MODEL_ATTRIBUTION");
  return {
    provider: "local-ollama",
    model,
    execution: "verified_local_generation",
    operation,
    routing: "local-only",
    cloudFallback: false,
    paidInference: false,
    scope: "codebridge_invocation",
    hostChatModel: "not_observable_by_codebridge",
  };
}

// Cloud coding receipts report ONLY the attested admission of a zero-charge
// chain. The proxy's actual upstream model, final bill and provider are NOT
// independently observable; never claim paidInference=false or known model.
const CLOUD_CHAIN = /^auto:[A-Za-z0-9_-]{1,20}$/;
export function cloudCodingReceipt(chain, operation = "autopilot_coding_worker") {
  if (
    typeof chain !== "string" ||
    !CLOUD_CHAIN.test(chain) ||
    operation !== "autopilot_coding_worker"
  )
    throw new TypeError("INVALID_MODEL_ATTRIBUTION");
  return {
    provider: "freellmapi-loopback",
    model: chain,
    execution: "verified_zero_cost_route_admission",
    operation,
    routing: "verified-free-cloud-only",
    cloudFallback: null,
    paidInference: null,
    scope: "codebridge_invocation",
    hostChatModel: "not_observable_by_codebridge",
  };
}

// Used for legacy/replayed checkpoints for which the original model was not
// durably recorded. The caller's requested model must never be substituted.
export function unknownModelReceipt() {
  return {
    provider: null,
    model: null,
    execution: "not_verified",
    operation: null,
    routing: "unknown",
    cloudFallback: null,
    paidInference: null,
    scope: "codebridge_invocation",
    hostChatModel: "not_observable_by_codebridge",
  };
}

// The journal persists only a trusted, minimal allowlisted receipt. Reject
// arbitrary nested objects and forged provider names rather than serializing
// any model-generated content, browser request or API credential.
export function normalizeModelReceipt(value) {
  if (value === undefined) return null;
  if (
    value &&
    value.provider === "freellmapi-loopback" &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === 9 &&
    Object.keys(value).every((key) =>
      [
        "provider",
        "model",
        "execution",
        "operation",
        "routing",
        "cloudFallback",
        "paidInference",
        "scope",
        "hostChatModel",
      ].includes(key),
    ) &&
    value.execution === "verified_zero_cost_route_admission" &&
    value.routing === "verified-free-cloud-only" &&
    value.cloudFallback === null &&
    value.paidInference === null &&
    value.scope === "codebridge_invocation" &&
    value.hostChatModel === "not_observable_by_codebridge"
  )
    return cloudCodingReceipt(value.model, value.operation);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "provider",
          "model",
          "execution",
          "operation",
          "routing",
          "cloudFallback",
          "paidInference",
          "scope",
          "hostChatModel",
        ].includes(key),
    ) ||
    value.provider !== "local-ollama" ||
    value.execution !== "verified_local_generation" ||
    value.routing !== "local-only" ||
    value.cloudFallback !== false ||
    value.paidInference !== false ||
    value.scope !== "codebridge_invocation" ||
    value.hostChatModel !== "not_observable_by_codebridge" ||
    typeof value.model !== "string" ||
    !MODEL_ID.test(value.model) ||
    !OPERATIONS.has(value.operation)
  )
    throw new TypeError("INVALID_MODEL_ATTRIBUTION");
  return localModelReceipt(value.model, value.operation);
}
