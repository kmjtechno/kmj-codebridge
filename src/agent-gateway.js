import fs from "node:fs";
import path from "node:path";

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

/**
 * Mutate only the selected gateway on an existing agent config, preserving the
 * exact device credential and identity. Requires an explicit loopback override.
 * A 0600 backup is retained in the same protected config directory.
 */
export function rebindExistingAgentGateway(configPath, localOverride) {
  if (localOverride === "") return false;
  const info = fs.lstatSync(configPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 65536 ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("UNSAFE_AGENT_CONFIG");
  }
  const original = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(original);
  const next = resolveAgentGateway(config.gateway, config.gateway, localOverride);
  if (config.gateway === next) return false;

  const dir = path.dirname(configPath);
  const backup = configPath + ".before-local-" + Date.now() + "-" + process.pid;
  const temp = configPath + ".local-" + process.pid;
  const writePrivate = (filename, bytes) => {
    const fd = fs.openSync(filename, "wx", 0o600);
    try {
      if (process.getuid?.() === 0) fs.fchownSync(fd, info.uid, info.gid);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  writePrivate(backup, original);
  try {
    config.gateway = next;
    writePrivate(temp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(temp, configPath);
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
  return true;
}
