import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";

import { classifyGitError } from "./diagnose-development-nonroot-git.mjs";

// Future, separately approved source location: never the shared Main Platform
// checkout. This validator cannot create the source or activate a service.
export const ISOLATED_SOURCE_ROOT = "/var/lib/kmj-codebridge-development-ci";
export const ISOLATED_SOURCE = `${ISOLATED_SOURCE_ROOT}/source`;

const ENTRIES = Object.freeze([
  ["/var", "root"],
  ["/var/lib", "root"],
  [ISOLATED_SOURCE_ROOT, "worker"],
  [ISOLATED_SOURCE, "worker"],
  [`${ISOLATED_SOURCE}/.git`, "worker"],
  [`${ISOLATED_SOURCE}/.git/objects`, "worker"],
  [`${ISOLATED_SOURCE}/.git/refs`, "worker"],
]);

const ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
});

const COMMIT = /^[0-9a-f]{40}$/;
const CHECKS = ["head", "type", "commit", "stable"];

function inspectDirectory(lstat, path, owner) {
  const meta = lstat(path);
  return (
    meta.isDirectory() &&
    !meta.isSymbolicLink() &&
    meta.uid === owner &&
    // Root-owned ancestors may be readable; never writable by other users.
    (meta.mode & (owner === 0 ? 0o022 : 0o077)) === 0
  );
}

const blocked = (reason) => ({
  schema: "kmj-isolated-nonroot-source-attestation-v1",
  reason,
  sourceConsistent: false,
  serviceEnabled: false,
  productionApproved: false,
  autonomousCodingLive: false,
});

export function attestIsolatedDevelopmentSource({
  identity,
  expectedHead,
  lstat = lstatSync,
  execute = execFileSync,
} = {}) {
  if (
    !Number.isSafeInteger(identity?.uid) ||
    identity.uid <= 0 ||
    identity.username !== "kmjdevci"
  )
    return blocked("WORKER_IDENTITY_UNVERIFIED");
  if (typeof expectedHead !== "string" || !COMMIT.test(expectedHead))
    return blocked("PINNED_COMMIT_REQUIRED");

  try {
    for (const [path, owner] of ENTRIES) {
      if (!inspectDirectory(lstat, path, owner === "root" ? 0 : identity.uid))
        return blocked("SOURCE_DIRECTORY_UNSAFE");
    }
  } catch {
    return blocked("ISOLATED_SOURCE_UNAVAILABLE");
  }

  let head = null;
  for (const check of CHECKS) {
    const args =
      check === "head" || check === "stable"
        ? ["rev-parse", "--verify", "HEAD"]
        : check === "type"
          ? ["cat-file", "-t", expectedHead]
          : ["rev-parse", "--verify", `${expectedHead}^{commit}`];
    let output;
    try {
      output = String(
        execute("/usr/bin/git", ["-C", ISOLATED_SOURCE, ...args], {
          env: { ...ENV },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 4096,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).trim();
    } catch (error) {
      return blocked(classifyGitError(error));
    }

    if (check === "type") {
      if (output !== "commit") return blocked("COMMIT_OBJECT_UNAVAILABLE");
      continue;
    }
    if (!COMMIT.test(output)) return blocked("GIT_OUTPUT_INVALID");
    if (check === "head") head = output;
    if (output !== expectedHead) {
      return blocked(
        check === "stable"
          ? "SOURCE_HEAD_CHANGED"
          : check === "commit"
            ? "COMMIT_MISMATCH"
            : "PINNED_HEAD_MISMATCH",
      );
    }
    if (check === "stable" && head !== output)
      return blocked("SOURCE_HEAD_CHANGED");
  }

  return {
    ...blocked("PINNED_SOURCE_READABLE"),
    sourceConsistent: true,
  };
}
