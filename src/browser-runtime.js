// Local-first browser runtime selection. No network, process launch, profile,
// endpoint, or credential access. An engine's existence is NOT a live QA result.
import fs from "node:fs";
import path from "node:path";

export const BROWSER_FAST_VERSION = "1.1.18";
const MOLI_LINUX = "/opt/kmj-codebridge-tools/moli/v1.1.18/bin/moli";
const MOLI_WINDOWS = "C:\\ProgramData\\KMJ\\CodeBridge\\moli\\v1.1.18\\moli.exe";

export function chromeCandidates(
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32") {
    const known = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    // These two default install locations are derived from the user's
    // profile, not a caller-supplied executable argument or PATH search.
    if (path.win32.isAbsolute(env.LOCALAPPDATA ?? "")) {
      known.push(
        path.win32.join(
          env.LOCALAPPDATA,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        path.win32.join(
          env.LOCALAPPDATA,
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        ),
      );
    }
    return known;
  }
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  if (platform === "linux")
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
  return [];
}

export function moliCandidates(platform = process.platform) {
  if (platform === "win32") return [MOLI_WINDOWS];
  if (platform === "linux" || platform === "darwin") return [MOLI_LINUX];
  return [];
}

export function selectInstalledBinary(candidates, lstat = fs.lstatSync) {
  for (const candidate of candidates) {
    try {
      const stat = lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {}
  }
  return null;
}

export function browserRuntimeStatus({
  platform = process.platform,
  env = process.env,
  lstat = fs.lstatSync,
} = {}) {
  const fidelity = selectInstalledBinary(
    chromeCandidates(platform, env),
    lstat,
  );
  const fast = selectInstalledBinary(moliCandidates(platform), lstat);
  return {
    localFirst: true,
    platform,
    fidelity: {
      engine: "chromium_cdp",
      installed: Boolean(fidelity),
      available: Boolean(fidelity),
      mode: "anonymous_ephemeral_profile",
      supportedWork: "fixed_public_visual_qa",
    },
    fast: {
      engine: "moli",
      pinnedVersion: BROWSER_FAST_VERSION,
      installed: Boolean(fast),
      available: Boolean(fast),
      supportedWork: "fixed_public_semantic_probe",
    },
    plan: {
      textRead: fast ? "moli_then_chromium" : "chromium_only",
      visualQa: fidelity ? "chromium" : "blocked_no_local_browser",
    },
    limitations: [
      "No arbitrary URL or cross-tenant browser control",
      "No authenticated site automation or browser cookie reuse",
      "Fast extraction never proves visual correctness",
      "No remotely opened debug port or root sandbox bypass",
    ],
  };
}
