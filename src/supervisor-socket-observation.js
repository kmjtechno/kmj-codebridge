import fs from "node:fs";

const FIXED_SOCKET = "/run/kmj-codebridge/supervisor.sock";

/**
 * Read-only filesystem preflight for the *fixed* Linux supervisor socket.
 * Never connects, starts a service, opens credentials or accepts a path.
 */
export function observeSupervisorSocket({
  platform = process.platform,
  configured = false,
  lstat = fs.lstatSync,
} = {}) {
  if (typeof platform !== "string" || typeof configured !== "boolean")
    throw new TypeError("SUPERVISOR_PROBE_INPUT_INVALID");
  if (platform !== "linux") {
    return {
      state: "UNSUPPORTED_OS",
      observedPlatform: platform,
      socketExists: null,
      authenticated: false,
      noServiceMutation: true,
    };
  }
  if (!configured) {
    return {
      state: "NOT_CONFIGURED",
      observedPlatform: platform,
      socketExists: null,
      authenticated: false,
      noServiceMutation: true,
    };
  }
  try {
    const stat = lstat(FIXED_SOCKET);
    return {
      state: stat.isSymbolicLink()
        ? "UNSAFE_SYMLINK"
        : stat.isSocket()
          ? "SOCKET_PRESENT_UNVERIFIED"
          : "INVALID_SOCKET_TYPE",
      observedPlatform: platform,
      socketExists: true,
      authenticated: false,
      noServiceMutation: true,
    };
  } catch (error) {
    return {
      state:
        error?.code === "ENOENT"
          ? "SOCKET_MISSING"
          : "SOCKET_PROBE_UNAVAILABLE",
      observedPlatform: platform,
      socketExists: error?.code === "ENOENT" ? false : null,
      authenticated: false,
      noServiceMutation: true,
    };
  }
}
