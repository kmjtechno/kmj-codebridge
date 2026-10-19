import { gatewaySchema } from "./config.js";
import { startGateway } from "./gateway.js";
import { fail } from "./errors.js";
const EXACT_CLOUDOS_REPO = "kmjtechno/kmj-cloudos";
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
    if (
      cloudosOptIn !== undefined &&
      cloudosOptIn !== "true" &&
      cloudosOptIn !== "false"
    )
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
    return config;
  } catch {
    fail("HOSTED_CONFIG_INVALID");
  }
}
export async function startHostedGateway(text, port) {
  return startGateway(hostedConfig(text, port));
}
