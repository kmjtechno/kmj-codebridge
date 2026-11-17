// Reader for the root-installed FreeLLMAPI chain-membership snapshot. Pure: the
// file read is injected by trusted device code, nothing imports this yet. It
// returns the {platform, modelId} members the zero-cost verifier compares with
// the owner-pinned manifest. Stale, future-dated, malformed or mismatched
// snapshots throw, so the verifier fails closed.
const CHAIN = /^auto:[A-Za-z0-9._-]{1,48}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
export const MAX_AGE_MS = 120000;
const MAX_SKEW_MS = 5000;
const MAX_MEMBERS = 50;
const stale = () => {
  throw new Error("CHAIN_SNAPSHOT_UNUSABLE");
};

export function createChainSnapshotReader({
  readSnapshot,
  now = Date.now,
} = {}) {
  if (typeof readSnapshot !== "function")
    throw new Error("SNAPSHOT_IO_MISSING");
  return async function readLiveChainMembers(chain) {
    if (typeof chain !== "string" || !CHAIN.test(chain)) stale();
    let snap;
    try {
      snap = JSON.parse(await readSnapshot(chain));
    } catch {
      stale();
    }
    const at = snap?.observedAtEpochMs;
    const t = now();
    if (
      !snap ||
      snap.version !== 1 ||
      snap.chain !== chain ||
      !Number.isSafeInteger(at) ||
      at > t + MAX_SKEW_MS ||
      t - at > MAX_AGE_MS ||
      !Array.isArray(snap.members) ||
      snap.members.length < 1 ||
      snap.members.length > MAX_MEMBERS ||
      !snap.members.every(
        (m) =>
          m &&
          typeof m.platform === "string" &&
          ID.test(m.platform) &&
          typeof m.modelId === "string" &&
          ID.test(m.modelId),
      )
    )
      stale();
    return snap.members.map((m) => ({
      platform: m.platform,
      modelId: m.modelId,
    }));
  };
}
