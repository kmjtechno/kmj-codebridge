#!/usr/bin/env node
/**
 * Read-only CodeBridge OAuth preflight for Claude Desktop and Claude web.
 * Never creates an OAuth client, requests tokens, reads secrets or edits Claude.
 */
import { pathToFileURL } from "node:url";

const ORIGIN = "https://kmjtechno.com";
const RESOURCE = `${ORIGIN}/mcp`;
const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const AUTH_METADATA = `${ORIGIN}/.well-known/oauth-authorization-server`;

export function validateDiscovery(resource, auth) {
  const issues = [];
  if (resource?.resource !== RESOURCE) issues.push("RESOURCE_MISMATCH");
  if (
    !Array.isArray(resource?.authorization_servers) ||
    !resource.authorization_servers.includes(ORIGIN)
  ) {
    issues.push("AUTHORIZATION_SERVER_MISSING");
  }
  if (auth?.issuer !== ORIGIN) issues.push("ISSUER_MISMATCH");
  for (const [field, expected] of [
    ["authorization_endpoint", `${ORIGIN}/oauth/authorize`],
    ["token_endpoint", `${ORIGIN}/oauth/token`],
    ["registration_endpoint", `${ORIGIN}/oauth/register`],
  ]) {
    if (auth?.[field] !== expected)
      issues.push(`INVALID_${field.toUpperCase()}`);
  }
  if (!auth?.code_challenge_methods_supported?.includes("S256"))
    issues.push("PKCE_S256_MISSING");
  if (!auth?.response_types_supported?.includes("code"))
    issues.push("AUTHORIZATION_CODE_MISSING");
  if (!auth?.token_endpoint_auth_methods_supported?.includes("none")) {
    issues.push("PUBLIC_CLIENT_AUTH_MISSING");
  }
  return { ok: issues.length === 0, issues };
}

async function readMetadata(url, fetcher) {
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new Error("NON_JSON_RESPONSE");
  return response.json();
}

export async function diagnoseClaudeOAuth(fetcher = fetch) {
  const [resource, auth] = await Promise.all([
    readMetadata(RESOURCE_METADATA, fetcher),
    readMetadata(AUTH_METADATA, fetcher),
  ]);
  return validateDiscovery(resource, auth);
}

async function main() {
  try {
    const result = await diagnoseClaudeOAuth();
    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          metadata: result.ok ? "PASS" : "FAIL",
          resources: [RESOURCE_METADATA, AUTH_METADATA],
          connector_url: RESOURCE,
          claude_plugin_button_state: "NOT_TESTED_CLIENT_CONTROL",
          guidance: result.ok
            ? "Claude Customize > Connectors > Add custom connector > KMJ CodeBridge > https://kmjtechno.com/mcp; authenticate in Claude."
            : "Correct public OAuth discovery before attempting Claude authorization.",
        },
        null,
        2,
      )}\n`,
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          metadata: "UNVERIFIED",
          error: error?.message ?? "UNKNOWN",
          connector_url: RESOURCE,
          claude_plugin_button_state: "NOT_TESTED_CLIENT_CONTROL",
          guidance:
            "Check DNS, HTTPS, auth metadata and Claude account connector configuration.",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
