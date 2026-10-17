import { gatewaySchema } from "./config.js";

export const PRIVATE_PLATFORM_REPOSITORY = "kmjtechno/kmj-main-platform";

/**
 * Prepare a single-repository addition, preserving all unrelated protected
 * gateway configuration. Does not read environment credentials or write data.
 */
export function planMainPlatformAllowlist(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("REPO_REPAIR_INVALID_CONFIG");
  gatewaySchema.parse(raw);
  const gh = raw.github;
  if (
    !gh ||
    gh.publicReadOnly === true ||
    !gh.tokenEnv ||
    new URL(gh.apiBase ?? "https://api.github.com/").href !==
      "https://api.github.com/"
  )
    throw new Error("REPO_REPAIR_PRIVATE_MODE_REQUIRED");
  const allowed = gh.repositories.includes(PRIVATE_PLATFORM_REPOSITORY);
  if (gh.repositories.length >= 100 && !allowed)
    throw new Error("REPO_REPAIR_ALLOWLIST_FULL");
  const next = {
    ...raw,
    github: {
      ...gh,
      repositories: allowed
        ? [...gh.repositories]
        : [...gh.repositories, PRIVATE_PLATFORM_REPOSITORY],
    },
  };
  gatewaySchema.parse(next);
  return {
    config: next,
    alreadyAllowed: allowed,
    repository: PRIVATE_PLATFORM_REPOSITORY,
    tokenEnv: gh.tokenEnv,
  };
}

/**
 * Validate that the server-held GitHub token can really read this private
 * repository's metadata and main ref. No fallback to anonymous/public mode.
 * Dependency-injected fetch permits zero-network negative regression tests.
 */
export async function verifyPrivateRepoGrant(
  token,
  request = fetch,
) {
  if (typeof token !== "string" || token.length < 20)
    throw new Error("REPO_REPAIR_TOKEN_MISSING");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "kmj-codebridge-allowlist-repair",
  };
  const fetchSafe = async (path) => {
    const result = await request(
      "https://api.github.com/repos/" + PRIVATE_PLATFORM_REPOSITORY + path,
      {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!result || result.status !== 200)
      throw new Error("REPO_REPAIR_GRANT_NOT_PROVEN");
    const length = Number(result.headers?.get?.("content-length") ?? 0);
    if (length > 65536)
      throw new Error("REPO_REPAIR_RESPONSE_TOO_LARGE");
    const text = await result.text();
    if (typeof text !== "string" || Buffer.byteLength(text) > 65536)
      throw new Error("REPO_REPAIR_RESPONSE_TOO_LARGE");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("REPO_REPAIR_INVALID_RESPONSE");
    }
  };
  const metadata = await fetchSafe("");
  if (
    metadata?.full_name !== PRIVATE_PLATFORM_REPOSITORY ||
    metadata?.private !== true
  )
    throw new Error("REPO_REPAIR_PRIVATE_GRANT_NOT_PROVEN");
  const ref = await fetchSafe("/git/ref/heads/main");
  if (
    ref?.ref !== "refs/heads/main" ||
    !/^[0-9a-f]{40}$/.test(ref?.object?.sha ?? "")
  )
    throw new Error("REPO_REPAIR_CONTENT_GRANT_NOT_PROVEN");
  return { privateRepositoryVerified: true, readOnlyRefVerified: true };
}
