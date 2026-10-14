// Read-only public OAuth discovery preflight for Claude Desktop / CodeBridge.
// Never registers clients, follows auth redirects, sends credentials or logs tokens.
const EXPECTED = "https://kmjtechno.com";
const FIXED_URLS = Object.freeze([
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

export function validateClaudeOAuthDiscovery(resource, auth) {
  const problems = [];
  const base = EXPECTED;
  const validUrl = (value, suffix) => {
    try {
      const url = new URL(value);
      return (
        url.origin === base &&
        url.pathname === suffix &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  };

  if (!resource || typeof resource !== "object") {
    return { status: "BLOCKED", problems: ["RESOURCE_METADATA_MISSING"] };
  }
  if (!auth || typeof auth !== "object") {
    return { status: "BLOCKED", problems: ["AUTH_METADATA_MISSING"] };
  }
  if (!validUrl(resource.resource, "/mcp"))
    problems.push("RESOURCE_URI_INVALID");
  if (
    !Array.isArray(resource.authorization_servers) ||
    !resource.authorization_servers.includes(base)
  )
    problems.push("ISSUER_NOT_ADVERTISED");
  if (auth.issuer !== base) problems.push("AUTH_ISSUER_MISMATCH");
  for (const [field, path] of [
    ["authorization_endpoint", "/oauth/authorize"],
    ["token_endpoint", "/oauth/token"],
    ["registration_endpoint", "/oauth/register"],
  ]) {
    if (!validUrl(auth[field], path)) problems.push(field.toUpperCase() + "_INVALID");
  }
  if (!auth.code_challenge_methods_supported?.includes("S256"))
    problems.push("PKCE_S256_MISSING");
  if (!auth.grant_types_supported?.includes("authorization_code"))
    problems.push("AUTHORIZATION_CODE_MISSING");
  if (!auth.token_endpoint_auth_methods_supported?.includes("none"))
    problems.push("PUBLIC_CLIENT_AUTH_MISSING");
  return {
    status: problems.length ? "BLOCKED" : "DISCOVERY_READY_ONLY",
    problems,
    oauthConnectionEstablished: false,
    authorizationCodeIssued: false,
    clientRegistered: false,
    toolCallsExecuted: false,
  };
}

export async function readOnlyClaudeOAuthProbe({ fetcher = fetch } = {}) {
  const documents = [];
  const requestStatus = [];
  for (const path of FIXED_URLS) {
    const url = EXPECTED + path;
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
      });
      requestStatus.push({ path, status: response.status });
      if (response.status !== 200) {
        documents.push(null);
        continue;
      }
      const raw = await response.text();
      if (raw.length > 32768) {
        documents.push(null);
        continue;
      }
      const parsed = JSON.parse(raw);
      documents.push(parsed);
    } catch {
      requestStatus.push({ path, status: "UNREACHABLE_OR_INVALID_JSON" });
      documents.push(null);
    }
  }
  return {
    ...validateClaudeOAuthDiscovery(documents[0], documents[1]),
    requestStatus,
    browserLoginRequired: true,
    note:
      "Discovery is not a completed Claude connection. Use Claude Desktop Customize > Connectors > Add custom connector when plugin-auth UI is inactive.",
  };
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const result = await readOnlyClaudeOAuthProbe();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.status !== "DISCOVERY_READY_ONLY") process.exitCode = 1;
}
