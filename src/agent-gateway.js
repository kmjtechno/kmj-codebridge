/**
 * Choose the authoritative agent data plane without trusting an arbitrary
 * environment-supplied hostname with the device bearer credential.
 *
 * A colocated Main Platform may expose the ChatGPT /mcp gateway on public
 * HTTPS while its agent safely talks to the SAME process over loopback.
 * The override must be an explicitly selected HTTP loopback origin.
 */
export function resolveAgentGateway(enrollmentGateway, configuredGateway, localOverride = "") {
  const defaultGateway =
    typeof enrollmentGateway === "string" && enrollmentGateway.trim()
      ? enrollmentGateway
      : configuredGateway;

  if (localOverride === "") return defaultGateway;
  if (typeof localOverride !== "string" || localOverride.length > 128) {
    throw new Error("INVALID_LOCAL_GATEWAY_OVERRIDE");
  }

  let parsed;
  try {
    parsed = new URL(localOverride);
  } catch {
    throw new Error("INVALID_LOCAL_GATEWAY_OVERRIDE");
  }

  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !parsed.port ||
    !Number.isInteger(Number(parsed.port)) ||
    Number(parsed.port) < 1024 ||
    Number(parsed.port) > 65535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("INVALID_LOCAL_GATEWAY_OVERRIDE");
  }

  return parsed.origin;
}
