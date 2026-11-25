// Native ModelFabric generation. Only a trusted host may supply the verifier.
// The current API plan counts do not supply this proof. Default is deny.
import { createHash } from "node:crypto";

const ENDPOINT = "https://kmjtechno.com/api/modelfabric/v1/chat/completions";
const POLICY = "strict-free-cloud";
const MODEL = "modelfabric-auto";
const MAX_BODY = 256 * 1024;
const MAX_PROOF_AGE = 30_000;

function deny() {
  throw new Error("NATIVE_MODEL_FABRIC_NOT_AUTHORIZED");
}

function proofValid(proof, requestDigest, now) {
  return (
    proof?.source === "trusted_native_account_and_route_verifier" &&
    proof.requestDigest === requestDigest &&
    proof.endpoint === ENDPOINT &&
    proof.policy === POLICY &&
    typeof proof.admissionTicket === "string" &&
    proof.admissionTicket.length === 64 &&
    /^[A-Za-z0-9]{64}$/.test(proof.admissionTicket) &&
    proof.accountNoChargeVerified === true &&
    proof.exactRouteBindingVerified === true &&
    proof.noPaidFallback === true &&
    proof.privateSourceApproved === true &&
    proof.inputPriceUsdPerToken === 0 &&
    proof.outputPriceUsdPerToken === 0 &&
    Number.isSafeInteger(proof.requestsRemaining) &&
    proof.requestsRemaining > 0 &&
    Number.isSafeInteger(proof.observedAtEpochMs) &&
    Number.isSafeInteger(proof.expiresAtEpochMs) &&
    proof.observedAtEpochMs <= now &&
    proof.expiresAtEpochMs > now &&
    proof.expiresAtEpochMs - proof.observedAtEpochMs <= MAX_PROOF_AGE
  );
}

export function createNativeModelFabricGeneration({
  token,
  authorized = () => false,
  verifyAdmission,
  request = globalThis.fetch,
  now = Date.now,
} = {}) {
  return {
    async generate({
      model,
      prompt,
      maxTokens = 1024,
      timeoutSeconds = 90,
      authorizeRequest,
    } = {}) {
      const approved = () => {
        try {
          return (
            authorized() === true &&
            typeof authorizeRequest === "function" &&
            authorizeRequest() === true
          );
        } catch {
          return false;
        }
      };
      if (
        !approved() ||
        typeof verifyAdmission !== "function" ||
        typeof token !== "string" ||
        token.length !== 54 ||
        !/^kmjmf_[A-Za-z0-9]{48}$/.test(token) ||
        model !== MODEL ||
        typeof prompt !== "string" ||
        prompt.trim().length === 0 ||
        prompt.includes("\0") ||
        Buffer.byteLength(prompt, "utf8") > 200_000 ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 4096 ||
        !Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > 180
      )
        deny();

      const body = JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        stream: false,
      });
      const requestDigest = createHash("sha256")
        .update(ENDPOINT)
        .update("\n")
        .update(token)
        .update("\n")
        .update(body)
        .digest("hex");
      try {
        const proof = await verifyAdmission({
          endpoint: ENDPOINT,
          policy: POLICY,
          requestDigest,
          maxTokens,
        });
        if (!approved() || !proofValid(proof, requestDigest, now())) deny();

        const response = await request(ENDPOINT, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-ModelFabric-Policy": POLICY,
            "X-ModelFabric-Admission-Ticket": proof.admissionTicket,
          },
          body,
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });
        if (!approved() || !response.ok || !response.body) deny();
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let raw = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BODY || !approved()) {
              await reader.cancel();
              deny();
            }
            raw += decoder.decode(value, { stream: true });
          }
          raw += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        const payload = JSON.parse(raw);
        const choice = payload?.choices?.[0];
        const content = choice?.message?.content;
        if (
          !approved() ||
          payload?.object !== "chat.completion" ||
          payload?.modelfabric?.policy !== POLICY ||
          !Array.isArray(payload.choices) ||
          payload.choices.length !== 1 ||
          choice?.finish_reason !== "stop" ||
          choice?.message?.role !== "assistant" ||
          typeof content !== "string" ||
          content.trim().length === 0 ||
          content.includes("\0") ||
          content.length > 65_536
        )
          deny();

        return {
          response: content,
          hitTokenLimit: false,
          truncated: false,
          outputIsUntrusted: true,
          billingVerified: false,
        };
      } catch {
        deny();
      }
    },
  };
}
