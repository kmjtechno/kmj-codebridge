import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "/srv/kmj-codebridge-projects/kmj-main-platform";
const GIT = "/usr/bin/git";
const SCHEMA = "kmj-nonroot-git-error-classifier-v1";
const ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
});
const CHECKS = Object.freeze([
  ["headRef", ["rev-parse", "--verify", "HEAD"]],
  ["headObject", ["cat-file", "-t", "HEAD"]],
  ["headCommit", ["rev-parse", "--verify", "HEAD^{commit}"]],
]);

export function classifyGitError(error) {
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString("utf8")
    : typeof error?.stderr === "string"
      ? error.stderr
      : "";
  const message = stderr.slice(0, 4096).toLowerCase();
  if (/dubious ownership|safe\.directory|unsafe repository/.test(message))
    return "UNSAFE_OWNERSHIP";
  if (
    /permission denied|operation not permitted|could not open|cannot open|unable to access|failed to read/.test(
      message,
    )
  )
    return "ACCESS_DENIED";
  if (/not a git repository|not a git directory/.test(message))
    return "REPOSITORY_UNAVAILABLE";
  if (
    /bad object|not a valid object|unknown revision|ambiguous argument|not a commit|could not parse|unable to read|missing blob/.test(
      message,
    )
  )
    return "OBJECT_UNAVAILABLE";
  if (error?.code === "ETIMEDOUT") return "TIMEOUT";
  return "OTHER_FAILURE";
}

function currentIdentity() {
  try {
    return { uid: process.getuid?.(), username: userInfo().username };
  } catch {
    return { uid: undefined, username: "" };
  }
}

export function diagnoseNonrootGit({
  identity = currentIdentity(),
  execute = execFileSync,
} = {}) {
  const result = {
    schema: SCHEMA,
    status: "DIAGNOSTIC_ONLY",
    checks: {},
    gitChecksPassed: false,
    permissionsChanged: false,
    productionChanged: false,
    autonomousCodingLive: false,
  };
  if (
    !Number.isSafeInteger(identity?.uid) ||
    identity.uid <= 0 ||
    identity.username !== "kmjdevci"
  ) {
    result.status = "DENIED_NONROOT_IDENTITY";
    return result;
  }
  for (const [name, args] of CHECKS) {
    try {
      const output = execute(
        GIT,
        ["-c", `safe.directory=${REPOSITORY}`, "-C", REPOSITORY, ...args],
        {
          env: { ...ENV },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 4096,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const value = String(output).trim();
      const valid =
        name === "headObject"
          ? value === "commit"
          : /^[a-f0-9]{40}$/.test(value);
      result.checks[name] = valid ? "PASS" : "UNEXPECTED_OUTPUT";
    } catch (error) {
      result.checks[name] = classifyGitError(error);
    }
  }
  result.gitChecksPassed = CHECKS.every(
    ([name]) => result.checks[name] === "PASS",
  );
  return result;
}

export function diagnosticExitCode(result) {
  if (result?.status !== "DIAGNOSTIC_ONLY") return 2;
  if (result.gitChecksPassed !== true) return 3;
  return CHECKS.every(([name]) => result.checks?.[name] === "PASS") ? 0 : 3;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result =
    process.argv.length === 2
      ? diagnoseNonrootGit()
      : {
          schema: SCHEMA,
          status: "DENIED_ARGUMENTS",
          checks: {},
          gitChecksPassed: false,
          permissionsChanged: false,
          productionChanged: false,
          autonomousCodingLive: false,
        };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = diagnosticExitCode(result);
}
