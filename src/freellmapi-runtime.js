// Opt-in runtime assembly of the FreeLLMAPI client WITH the zero-cost verifier.
// Only when ALL three owner-set device env vars are present (pins dir, snapshot dir,
// OpenRouter key). Otherwise this returns the plain client, whose generation stays
// blocked (FREELLMAPI_ZERO_COST_NOT_ATTESTED). Env is device-owner config, never
// chat/MCP input. Chain names are regex-validated before they touch a path.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFreeLlmApiClient } from "./freellmapi-client.js";
import { createZeroCostVerifier } from "./freellmapi-zero-cost-verifier.js";
import { createChainSnapshotReader } from "./freellmapi-chain-snapshot.js";
import { createOpenRouterEvidenceFetcher } from "./openrouter-evidence-fetcher.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const ABS = (p) =>
  typeof p === "string" && path.isAbsolute(p) && !p.includes("\0");
const chainName = (chain) => {
  const name = typeof chain === "string" ? chain.slice(5) : "";
  if (!chain.startsWith("auto:") || !NAME.test(name) || name.includes(".."))
    throw new Error("ZERO_COST_NOT_ATTESTED");
  return name;
};

export function zeroCostConfigured(env) {
  return (
    ABS(env.CODEBRIDGE_FREELLMAPI_PINS_DIR) &&
    ABS(env.CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR) &&
    typeof env.CODEBRIDGE_OPENROUTER_KEY === "string" &&
    env.CODEBRIDGE_OPENROUTER_KEY.length > 0
  );
}

export function createConfiguredFreeLlmApiClient({
  env = process.env,
  factory = createFreeLlmApiClient,
  read = readFile,
  evidenceRequest,
  authorizeGeneration,
} = {}) {
  const authorization =
    authorizeGeneration === undefined ? {} : { authorizeGeneration };
  if (!zeroCostConfigured(env))
    return authorizeGeneration === undefined
      ? factory()
      : factory(authorization);
  const pins = env.CODEBRIDGE_FREELLMAPI_PINS_DIR;
  const snaps = env.CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR;
  const fetcher = createOpenRouterEvidenceFetcher({
    apiKey: env.CODEBRIDGE_OPENROUTER_KEY,
    ...(evidenceRequest ? { request: evidenceRequest } : {}),
  });
  const verifier = createZeroCostVerifier({
    readManifest: async (chain) =>
      JSON.parse(
        await read(
          path.join(pins, `route-binding-${chainName(chain)}.json`),
          "utf8",
        ),
      ),
    readLiveChainMembers: createChainSnapshotReader({
      readSnapshot: (chain) =>
        read(path.join(snaps, `${chainName(chain)}.json`), "utf8"),
    }),
    ...fetcher,
  });
  return factory({ ...authorization, verifyZeroCostChain: verifier });
}
