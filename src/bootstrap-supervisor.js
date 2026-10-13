// Unprivileged bootstrap repair path for an already operator-provisioned KMJ-elite.
// No caller-controlled executable, unit, SHA, path, environment or arguments.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fail } from "./errors.js";

const SYSTEMCTL = "/usr/bin/systemctl";
const SUDO = "/usr/bin/sudo";
const HELPER =
  "/usr/local/libexec/kmj-codebridge/activate-supervisor-socket-approved";
const AGENT = "kmj-codebridge-kmj-main-platform.service";
const SOCKET = "kmj-codebridge-supervisor.socket";
const SERVICE = "kmj-codebridge-supervisor.service";
const SOCKET_FILE = "/run/kmj-codebridge/supervisor.sock";
const TRUSTED_PARENTS = [
  "/usr",
  "/usr/local",
  "/usr/local/libexec",
  "/usr/local/libexec/kmj-codebridge",
];

function fixedShow(run, unit, property) {
  try {
    const output = run(SYSTEMCTL, [
      "show",
      unit,
      "--property=" + property,
      "--value",
      "--no-pager",
    ]);
    return String(output).trim().slice(0, 48);
  } catch {
    return "unknown";
  }
}

function trustedPath(lstat) {
  try {
    for (const path of TRUSTED_PARENTS) {
      const stat = lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0
      )
        return false;
    }
    const stat = lstat(HELPER);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      stat.nlink === 1 &&
      (stat.mode & 0o022) === 0 &&
      (stat.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

export function bootstrapSupervisorStatus({
  platform = process.platform,
  hostname = os.hostname(),
  run = execFileSync,
  lstat = fs.lstatSync,
} = {}) {
  // Never diagnose or invoke a privileged helper on an arbitrary device.
  if (platform !== "linux" || hostname !== "KMJ-elite")
    return {
      eligible: false,
      socketVerified: false,
      reason: "BOOTSTRAP_FIXED_HOST_ONLY",
      operatorSetupRequired: false,
    };
  const agentLoaded = fixedShow(run, AGENT, "LoadState") === "loaded";
  const serviceLoaded = fixedShow(run, SERVICE, "LoadState") === "loaded";
  const socketLoaded = fixedShow(run, SOCKET, "LoadState") === "loaded";
  const socketActive = fixedShow(run, SOCKET, "ActiveState") === "active";
  let socketPresent = false;
  try {
    const stat = lstat(SOCKET_FILE);
    socketPresent = stat.isSocket() && !stat.isSymbolicLink();
  } catch {}
  const helperTrusted = trustedPath(lstat);
  const socketVerified =
    agentLoaded && serviceLoaded && socketLoaded && socketActive && socketPresent;
  const eligible =
    agentLoaded && serviceLoaded && socketLoaded && helperTrusted && !socketVerified;
  return {
    eligible,
    socketVerified,
    agentLoaded,
    serviceLoaded,
    socketLoaded,
    socketActive,
    socketPresent,
    helperTrusted,
    operatorSetupRequired:
      !agentLoaded || !serviceLoaded || !socketLoaded || !helperTrusted,
    reason: socketVerified
      ? "SOCKET_PRESENT_LIVE_AGENT_CHECK_REQUIRED"
      : !agentLoaded
        ? "BOOTSTRAP_AGENT_UNIT_MISSING"
        : !serviceLoaded || !socketLoaded
          ? "BOOTSTRAP_ROOT_UNITS_MISSING"
          : !helperTrusted
            ? "BOOTSTRAP_OPERATOR_HELPER_NOT_PROVISIONED"
            : "BOOTSTRAP_SOCKET_READY_FOR_GUARDED_START",
  };
}

export function requestBootstrapSupervisor(
  confirmation,
  dependencies = {},
) {
  if (confirmation !== "START_APPROVED_CODEBRIDGE_SUPERVISOR")
    fail("BOOTSTRAP_CONFIRMATION_REQUIRED");
  const before = bootstrapSupervisorStatus(dependencies);
  if (!before.eligible) {
    if (before.socketVerified)
      return { accepted: false, ...before };
    fail(before.reason);
  }
  const invoke = dependencies.invoke ?? execFileSync;
  try {
    // sudoers, if operator installed it, must allow this exact no-arguments
    // root-owned helper ONLY. No interactive prompts, shell or user input.
    invoke(SUDO, ["-n", HELPER], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
  } catch {
    fail("BOOTSTRAP_OPERATOR_AUTH_REQUIRED");
  }
  const after = bootstrapSupervisorStatus(dependencies);
  return {
    accepted: true,
    socketVerified: after.socketVerified,
    reason: after.socketVerified
      ? "SOCKET_PRESENT_LIVE_AGENT_CHECK_REQUIRED"
      : "SOCKET_NOT_VERIFIED",
    // A socket file is never proof an authenticated MCP request succeeded.
    liveMcpVerified: false,
  };
}
