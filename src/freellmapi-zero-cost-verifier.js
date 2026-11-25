// Zero-cost verifier for FreeLLMAPI chains made ONLY of OpenRouter `:free` models.
// Pure composition: all IO is injected by trusted device code (nothing here reads
// files, env or the network), and nothing imports this module yet, so it enables
// nothing by itself. Any failure throws; the adapter maps a throw to
// FREELLMAPI_ZERO_COST_NOT_ATTESTED. Design: docs/FREELLMAPI-ZERO-COST-VERIFIER-DESIGN-20261117.md
import { createHash } from "node:crypto";
import { isGlobalFabricAlias } from "./freellmapi-fabric-policy.js";
import {
  buildZeroCostProof,
  isVerifiedFreeModel,
} from "./openrouter-free-evidence.js";

const MODEL =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}:free$/;
const CHAIN = /^auto:[A-Za-z0-9._-]{1,48}$/;
const MAX_MODELS = 50;
const deny = () => {
  throw new Error("ZERO_COST_NOT_ATTESTED");
};

export const manifestDigest = (models) =>
  createHash("sha256")
    .update(JSON.stringify([...models].sort()))
    .digest("hex");

function checkManifest(manifest, chain) {
  const m = manifest;
  if (
    !m ||
    m.version !== 1 ||
    m.chain !== chain ||
    !Array.isArray(m.models) ||
    m.models.length < 1 ||
    m.models.length > MAX_MODELS ||
    new Set(m.models).size !== m.models.length ||
    !m.models.every((id) => typeof id === "string" && MODEL.test(id)) ||
    m.sha256 !== manifestDigest(m.models)
  )
    deny();
  return [...m.models].sort();
}

export function createZeroCostVerifier({
  readManifest,
  readLiveChainMembers,
  fetchOpenRouterKey,
  fetchOpenRouterModels,
} = {}) {
  for (const fn of [
    readManifest,
    readLiveChainMembers,
    fetchOpenRouterKey,
    fetchOpenRouterModels,
  ])
    if (typeof fn !== "function") throw new Error("VERIFIER_IO_MISSING");
  return async ({ chain, observedAtEpochMs }) => {
    if (
      typeof chain !== "string" ||
      !CHAIN.test(chain) ||
      isGlobalFabricAlias(chain)
    )
      deny();
    const pinned = checkManifest(await readManifest(chain), chain);
    // Route binding: the router's LIVE membership must equal the owner-pinned
    // list exactly, and every member must be an OpenRouter platform model.
    const assertLiveMembers = async () => {
      const live = await readLiveChainMembers(chain);
      if (
        !Array.isArray(live) ||
        live.length !== pinned.length ||
        !live.every((r) => r?.platform === "openrouter")
      )
        deny();
      const liveIds = live.map((r) => r.modelId).sort();
      if (!liveIds.every((id, i) => id === pinned[i])) deny();
    };
    await assertLiveMembers();
    const catalog = await fetchOpenRouterModels();
    const rows = Array.isArray(catalog?.data) ? catalog.data : [];
    // An ambiguous catalog cannot prove which price applies to a pinned route.
    // Reject duplicate IDs before selecting any row, even if the first is free.
    const seen = new Set();
    for (const row of rows) {
      if (typeof row?.id !== "string" || seen.has(row.id)) deny();
      seen.add(row.id);
    }
    const models = pinned.map((id) => rows.find((r) => r.id === id));
    if (!models.every((r) => r && isVerifiedFreeModel(r))) deny();
    const proof = buildZeroCostProof({
      chain,
      observedAtEpochMs,
      keyResponse: await fetchOpenRouterKey(),
      routeBinding: { chain, verified: true, noPaidFallback: true, models },
    });
    if (!proof) deny();
    // Provider evidence reads await network IO. Recheck owner pins and the
    // fresh route snapshot afterward, before returning even an advisory proof.
    // This narrows the race; it does not establish atomic router dispatch.
    const currentPins = checkManifest(await readManifest(chain), chain);
    if (
      currentPins.length !== pinned.length ||
      !currentPins.every((id, i) => id === pinned[i])
    )
      deny();
    await assertLiveMembers();
    return proof;
  };
}
