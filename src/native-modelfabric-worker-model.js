// Native ModelFabric worker transport. Trust only the fixed authenticated KMJ
// admission endpoint; the server verifies provider evidence and consumes the
// exact-route ticket before dispatch. No legacy router or local model fallback.
import { randomBytes } from "node:crypto";
import { createNativeModelFabricGeneration } from "./native-modelfabric-generation.js";
import { nativeCloudCodingReceipt } from "./model-attribution.js";

const MODELS_URL = "https://kmjtechno.com/api/modelfabric/v1/models";
const ENDPOINT = "https://kmjtechno.com/api/modelfabric/v1/chat/completions";
const POLICY = "strict-free-cloud";
const MODEL = "modelfabric-auto";
const MAX_BYTES = 64 * 1024;

export function createNativeModelFabricWorkerModel({
  token,
  authorized = () => false,
  request = globalThis.fetch,
  now = Date.now,
} = {}) {
  const approved = () => {
    try {
      return (
        authorized() === true &&
        typeof token === "string" &&
        token.length === 54 &&
        /^kmjmf_[A-Za-z0-9]{48}$/.test(token)
      );
    } catch {
      return false;
    }
  };
  async function admission(requestDigest) {
    if (!approved()) return null;
    try {
      const response = await request(MODELS_URL, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-ModelFabric-Policy": POLICY,
          "X-ModelFabric-Request-Digest": requestDigest,
        },
        signal: AbortSignal.timeout(65_000),
      });
      if (!response.ok || !response.body || !approved()) return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let raw = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES || !approved()) {
            await reader.cancel();
            return null;
          }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const payload = JSON.parse(raw);
      const meta = payload?.modelfabric;
      const a = meta?.native_admission;
      const current = now();
      if (
        !approved() ||
        payload?.object !== "list" ||
        meta?.scope !== "private-source-coding" ||
        meta?.policy !== POLICY ||
        a?.source !== "kmj_native_provider_admission" ||
        a.request_digest !== requestDigest ||
        typeof a.ticket !== "string" ||
        a.ticket.length !== 64 ||
        !/^[A-Za-z0-9]{64}$/.test(a.ticket) ||
        !Number.isSafeInteger(a.requests_remaining) ||
        a.requests_remaining < 1 ||
        !Number.isSafeInteger(a.issued_at_ms) ||
        !Number.isSafeInteger(a.expires_at_ms) ||
        a.issued_at_ms > current ||
        a.expires_at_ms <= current ||
        a.expires_at_ms - a.issued_at_ms > 30_000
      )
        return null;

      return {
        source: "trusted_native_account_and_route_verifier",
        endpoint: ENDPOINT,
        policy: POLICY,
        requestDigest,
        admissionTicket: a.ticket,
        accountNoChargeVerified: true,
        exactRouteBindingVerified: true,
        noPaidFallback: true,
        privateSourceApproved: true,
        inputPriceUsdPerToken: 0,
        outputPriceUsdPerToken: 0,
        requestsRemaining: a.requests_remaining,
        observedAtEpochMs: a.issued_at_ms,
        expiresAtEpochMs: a.expires_at_ms,
      };
    } catch {
      return null;
    }
  }
  const generation = createNativeModelFabricGeneration({
    token,
    authorized: approved,
    verifyAdmission: ({ requestDigest }) => admission(requestDigest),
    request,
    now,
  });
  let nextProbe = 0;
  let readyUntil = 0;
  let activeRequest = false;
  function snapshot() {
    const available = !activeRequest && approved() && now() < readyUntil;
    return {
      available,
      activeRequest,
      models: available ? [MODEL] : [],
    };
  }
  return {
    async status() {
      if (activeRequest || !approved()) return snapshot();
      if (now() >= nextProbe) {
        activeRequest = true;
        readyUntil = 0;
        try {
          const proof = await admission(randomBytes(32).toString("hex"));
          if (proof && approved()) readyUntil = proof.expiresAtEpochMs;
        } finally {
          nextProbe = now() + 30_000;
          activeRequest = false;
        }
      }
      return snapshot();
    },
    async generate(input) {
      if (activeRequest) throw new Error("NATIVE_MODEL_FABRIC_BUSY");
      activeRequest = true;
      readyUntil = 0;
      try {
        const result = await generation.generate(input);
        return {
          ...result,
          modelUsage: nativeCloudCodingReceipt(),
        };
      } finally {
        nextProbe = 0;
        activeRequest = false;
      }
    },
  };
}
