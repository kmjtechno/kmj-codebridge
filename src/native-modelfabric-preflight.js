// Native KMJ ModelFabric discovery. No FreeLLMAPI, local model or paid fallback.
// A planned route count is not proof of account billing or available quota.
const MODELS_URL = "https://kmjtechno.com/api/modelfabric/v1/models";
const POLICY = "strict-free-cloud";
const MAX_RESPONSE = 64 * 1024;
const TOKEN = /^kmjmf_[A-Za-z0-9]{48}$/;

const unavailable = () => ({
  available: false,
  plannedFreeRoutes: 0,
  billingVerified: false,
  generationAuthorized: false,
});

export function createNativeModelFabricPreflight({
  token,
  authorized = () => false,
  request = globalThis.fetch,
} = {}) {
  const approved = () => {
    try {
      return authorized() === true;
    } catch {
      return false;
    }
  };
  return {
    async status() {
      if (
        typeof token !== "string" ||
        !TOKEN.test(token) ||
        typeof request !== "function" ||
        !approved()
      )
        return unavailable();

      try {
        const response = await request(MODELS_URL, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "X-ModelFabric-Policy": POLICY,
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok || !response.body || !approved()) return unavailable();
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let raw = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE || !approved()) {
              await reader.cancel();
              return unavailable();
            }
            raw += decoder.decode(value, { stream: true });
          }
          raw += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        const payload = JSON.parse(raw);
        const evidence = payload?.modelfabric;
        if (
          !approved() ||
          payload?.object !== "list" ||
          !Array.isArray(payload.data) ||
          !payload.data.some((model) => model?.id === "modelfabric-auto") ||
          evidence?.scope !== "private-source-coding" ||
          evidence?.policy !== POLICY ||
          evidence?.status !== "ROUTE_AVAILABLE" ||
          !Number.isSafeInteger(evidence.free_routes) ||
          evidence.free_routes <= 0 ||
          evidence.routes !== evidence.free_routes
        )
          return unavailable();

        return {
          available: false,
          plannedFreeRoutes: evidence.free_routes,
          billingVerified: false,
          generationAuthorized: false,
        };
      } catch {
        // Never expose upstream errors, tokens, or response text.
        return unavailable();
      }
    },
  };
}
