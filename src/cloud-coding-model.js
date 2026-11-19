// Opt-in autonomous coding transport. This adapter never calls Ollama,
// cannot select a paid/local fallback, and never persists a prompt. The
// trusted FreeLLMAPI client independently denies generation without fresh,
// account-specific zero-charge and fixed upstream route attestation.
import { createFreeLlmApiClient } from "./freellmapi-client.js";
import { cloudCodingReceipt } from "./model-attribution.js";

const CHAIN = /^auto:[A-Za-z0-9_-]{1,20}$/;
// Untrusted advertised-chain lists are bounded before any verifier call.
const MAX_ADVERTISED = 256;
const MAX_VERIFIED = 32;
const deny = () => {
  throw new Error("CLOUD_CODING_NOT_AUTHORIZED");
};

export function createVerifiedFreeCloudCodingModel({
  createClient = createFreeLlmApiClient,
  authorized = () => false,
} = {}) {
  if (typeof createClient !== "function" || typeof authorized !== "function")
    throw new TypeError("CLOUD_CODING_INVALID_TRUST_BOUNDARY");
  let client;
  // A throwing or non-boolean consent provider is a denial, never an admission.
  const approved = () => {
    try {
      return authorized() === true;
    } catch {
      return false;
    }
  };
  const unavailable = () => ({
    available: false,
    activeRequest: false,
    models: [],
  });
  const getClient = () => (client ??= createClient());
  return {
    async status() {
      if (!approved()) return unavailable();
      let status;
      try {
        status = await getClient().status();
      } catch {
        // Discovery failure: no attestation or generation is attempted.
        return unavailable();
      }
      // Never consider an advertised but unapproved proxy chain eligible.
      if (!approved()) return unavailable();
      if (
        !status ||
        typeof status !== "object" ||
        status.available !== true ||
        !Array.isArray(status.approvedFreeChains)
      )
        return unavailable();
      const candidates = [
        ...new Set(
          status.approvedFreeChains
            .slice(0, MAX_ADVERTISED)
            .filter((name) => typeof name === "string" && CHAIN.test(name)),
        ),
      ].slice(0, MAX_VERIFIED);
      // Proxy discovery alone is NOT a no-cost proof. Without trusted
      // account+route verification do not even claim work or read source.
      const models = [];
      for (const chain of candidates) {
        try {
          const proof = await getClient().checkZeroCostChain({ chain });
          // Consent revoked (or its check throwing) discards ALL admissions.
          if (!approved()) return unavailable();
          if (proof?.admitted === true && proof.chain === chain)
            models.push(chain);
        } catch {
          // No verifier or expired/free-quota evidence => fail closed.
        }
      }
      // Final consent re-check: nothing is reported if consent ended meanwhile.
      if (!approved()) return unavailable();
      return {
        available: models.length > 0,
        activeRequest: false,
        models,
      };
    },
    async generate({ model, prompt, maxTokens, timeoutSeconds }) {
      if (!approved()) deny();
      if (typeof model !== "string" || !CHAIN.test(model))
        throw new Error("CLOUD_CODING_CHAIN_INVALID");
      // localProcessingApproved here refers ONLY to loopback proxy access:
      // model execution is remote cloud, never a local LLM.
      const result = await getClient().generate({
        chain: model,
        prompt,
        maxTokens,
        timeoutSeconds,
        localProcessingApproved: true,
        upstreamCloudApproved: true,
      });
      // Revocation while the remote request was in flight must prevent
      // applying its returned patch, even though already sent bytes cannot
      // be recalled.
      if (!approved()) deny();
      if (
        result?.provider !== "freellmapi-loopback" ||
        result?.chain !== model ||
        result?.zeroCostRouteAdmissionVerified !== true ||
        result?.billingVerified !== false ||
        result?.paidInference !== null ||
        result?.actualUpstreamModel !== null ||
        result?.cloudFallback !== null ||
        result?.outputIsUntrusted !== true ||
        typeof result?.response !== "string" ||
        result.response.trim().length === 0 ||
        result.response.length > 1_048_576 ||
        result.response.includes("\0")
      )
        throw new Error("CLOUD_CODING_ATTESTATION_INVALID");
      return {
        response: result.response,
        hitTokenLimit: result.hitTokenLimit === true,
        truncated: result.truncated === true,
        modelUsage: cloudCodingReceipt(model),
      };
    },
  };
}
