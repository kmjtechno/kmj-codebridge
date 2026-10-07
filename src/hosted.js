import { gatewaySchema } from "./config.js";
import { startGateway } from "./gateway.js";
import { fail } from "./errors.js";
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
    }
    const config = gatewaySchema.parse({
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
    return config;
  } catch {
    fail("HOSTED_CONFIG_INVALID");
  }
}
export async function startHostedGateway(text, port) {
  return startGateway(hostedConfig(text, port));
}
