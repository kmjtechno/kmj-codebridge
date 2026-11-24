import { gatewaySchema } from "./config.js";
import { startGateway } from "./gateway.js";
import { fail } from "./errors.js";
const EXACT_CLOUDOS_REPO = "kmjtechno/kmj-cloudos";
const EXACT_CALIBRATION_STUDIO_REPO = "kmjtechno/KMJ-Calibration-Studio";
const EXACT_OMNIDESK_REPO = "kmjtechno/kmj-omnidesk";
function hostedGitHubConfig(env) {
  const apiBase = env.CODEBRIDGE_GITHUB_API_BASE;
  const token = env.CODEBRIDGE_GITHUB_PROXY_TOKEN;
  const repositoriesText = env.CODEBRIDGE_GITHUB_REPOSITORIES;
  const publicReadOnly =
    env.CODEBRIDGE_GITHUB_PUBLIC_READ_ONLY?.toLowerCase() === "true";

  if (publicReadOnly) {
    if (!repositoriesText) fail("HOSTED_CONFIG_INVALID");
    if (apiBase && new URL(apiBase).href !== "https://api.github.com/")
      fail("HOSTED_CONFIG_INVALID");
    const repositories = repositoriesText
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (repositories.length === 0) fail("HOSTED_CONFIG_INVALID");
    return {
      apiBase: "https://api.github.com/",
      publicReadOnly: true,
      repositories,
      cacheSeconds: 30,
    };
  }

  const configured = [apiBase, token, repositoriesText].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 3 || typeof token !== "string" || token.length < 32)
    fail("HOSTED_CONFIG_INVALID");
  const repositories = repositoriesText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (repositories.length === 0) fail("HOSTED_CONFIG_INVALID");
  return {
    apiBase,
    tokenEnv: "CODEBRIDGE_GITHUB_PROXY_TOKEN",
    repositories,
    cacheSeconds: 30,
  };
}

export function hostedConfig(text, port = "10000", env = process.env) {
  try {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > 1048576 ||
      typeof port !== "string" ||
      !/^\d{1,5}$/.test(port)
    )
      fail("HOSTED_CONFIG_INVALID");
    const parsed = JSON.parse(text);
    // Render config is often an environment-held secret, not a writable file.
    // This opt-in adds only the owner-approved CloudOS repo, never a wildcard.
    const cloudosOptIn = env.CODEBRIDGE_ENABLE_CLOUDOS_REPOSITORY;
    const calibrationOptIn =
      env.CODEBRIDGE_ENABLE_CALIBRATION_STUDIO_REPOSITORY;
    const omnideskOptIn = env.CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY;
    const omnideskPublicReadOnlyOptIn =
      env.CODEBRIDGE_ENABLE_OMNIDESK_PUBLIC_READ_ONLY_REPOSITORY;
    for (const optIn of [
      cloudosOptIn,
      calibrationOptIn,
      omnideskOptIn,
      omnideskPublicReadOnlyOptIn,
    ]) {
      if (optIn !== undefined && optIn !== "true" && optIn !== "false")
        fail("HOSTED_CONFIG_INVALID");
    }
    if (omnideskOptIn === "true" && omnideskPublicReadOnlyOptIn === "true")
      fail("HOSTED_CONFIG_INVALID");
    const github = parsed.github ?? hostedGitHubConfig(env);
    let userIntrospection = parsed.userIntrospection;
    const userIntrospectionEndpoint =
      env.CODEBRIDGE_USER_INTROSPECTION_ENDPOINT;
    if (userIntrospectionEndpoint) {
      const endpoint = new URL(userIntrospectionEndpoint);
      if (
        endpoint.protocol !== "https:" ||
        !parsed.oauth ||
        endpoint.origin !== new URL(parsed.oauth.issuer).origin
      )
        fail("HOSTED_CONFIG_INVALID");
      userIntrospection = { endpoint: endpoint.href, cacheSeconds: 30 };
    } else if (!userIntrospection && parsed.oauth) {
      const issuer = new URL(parsed.oauth.issuer);
      const resource = new URL(parsed.oauth.resource);
      if (issuer.origin === resource.origin) {
        userIntrospection = {
          endpoint: new URL("/api/codebridge/v1/user-access/introspect", issuer)
            .href,
          cacheSeconds: 30,
        };
      }
    }
    let config = gatewaySchema.parse({
      ...parsed,
      ...(github ? { github } : {}),
      ...(userIntrospection ? { userIntrospection } : {}),
      host: "0.0.0.0",
      port: Number(port),
    });
    if (
      !config.oauth ||
      !config.allowedHosts.includes(new URL(config.oauth.resource).hostname)
    )
      fail("HOSTED_CONFIG_INVALID");
    if (cloudosOptIn === "true") {
      if (
        !config.github ||
        config.github.publicReadOnly ||
        !config.github.tokenEnv
      )
        fail("HOSTED_CONFIG_INVALID");
      const existing = config.github.repositories;
      const repositories = existing.includes(EXACT_CLOUDOS_REPO)
        ? existing
        : [...existing, EXACT_CLOUDOS_REPO];
      config = gatewaySchema.parse({
        ...config,
        github: { ...config.github, repositories },
      });
    }
    // Owner-scoped opt-in: never replace the protected repository list, grant
    // wildcard access or silently promote public/anonymous GitHub credentials.
    if (calibrationOptIn === "true") {
      if (
        !config.github ||
        config.github.publicReadOnly ||
        !config.github.tokenEnv
      )
        fail("HOSTED_CONFIG_INVALID");
      const existing = config.github.repositories;
      const repositories = existing.includes(EXACT_CALIBRATION_STUDIO_REPO)
        ? existing
        : [...existing, EXACT_CALIBRATION_STUDIO_REPO];
      config = gatewaySchema.parse({
        ...config,
        github: { ...config.github, repositories },
      });
    }
    // Owner-approved OmniDesk repository is added only to an already
    // authenticated, private-capable GitHub bridge. No token, wildcard,
    // OAuth/device scope, or unrelated repository grant is changed.
    if (omnideskOptIn === "true") {
      if (
        !config.github ||
        config.github.publicReadOnly ||
        !config.github.tokenEnv
      )
        fail("HOSTED_CONFIG_INVALID");
      const existing = config.github.repositories;
      const repositories = existing.includes(EXACT_OMNIDESK_REPO)
        ? existing
        : [...existing, EXACT_OMNIDESK_REPO];
      config = gatewaySchema.parse({
        ...config,
        github: { ...config.github, repositories },
      });
    }
    // Separate, default-off public-only grant for the public OmniDesk repo.
    // Never promote anonymous access, attach credentials, or change existing
    // read-only dispatch restrictions. Private-capable mode uses its own flag.
    if (omnideskPublicReadOnlyOptIn === "true") {
      if (
        config.github?.publicReadOnly !== true ||
        new URL(config.github.apiBase).href !== "https://api.github.com/"
      )
        fail("HOSTED_CONFIG_INVALID");
      const existing = config.github.repositories;
      const repositories = existing.includes(EXACT_OMNIDESK_REPO)
        ? existing
        : [...existing, EXACT_OMNIDESK_REPO];
      config = gatewaySchema.parse({
        ...config,
        github: { ...config.github, repositories },
      });
    }
    return config;
  } catch {
    fail("HOSTED_CONFIG_INVALID");
  }
}
// Read-only shadow validation: no gateway start, network request, permission
// mutation or disclosure of configuration values. Only constant reason codes.
export function hostedOmniDeskOptInWitness(
  text,
  port = "10000",
  env = process.env,
) {
  try {
    const baseline = hostedConfig(text, port, {
      ...env,
      CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY: "false",
    });
    if (!baseline.github) return "GITHUB_BRIDGE_MISSING";
    if (baseline.github.publicReadOnly) return "GITHUB_PUBLIC_READ_ONLY";
    if (!baseline.github.tokenEnv) return "GITHUB_TOKEN_ENV_MISSING";
    if (
      !baseline.github.repositories.includes(EXACT_OMNIDESK_REPO) &&
      baseline.github.repositories.length >= 100
    )
      return "GITHUB_REPOSITORY_LIMIT";
    try {
      hostedConfig(text, port, {
        ...env,
        CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY: "true",
      });
      return "SHADOW_VALIDATION_PASS";
    } catch {
      return "SHADOW_SCHEMA_REJECTED";
    }
  } catch {
    return "BASELINE_VALIDATION_FAILED";
  }
}

export async function startHostedGateway(text, port) {
  return startGateway(hostedConfig(text, port));
}
