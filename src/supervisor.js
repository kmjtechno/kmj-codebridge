import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { agentSchema, gatewaySchema } from "./config.js";
import { fail, publicError } from "./errors.js";
import { redact } from "./jobs.js";

const SERVICES = {
  agent: "kmj-codebridge-agent.service",
  gateway: "kmj-codebridge-gateway.service",
};
const CONFIGS = {
  agent: "/etc/kmj-codebridge/agent.json",
  gateway: "/etc/kmj-codebridge/gateway.json",
};
const UPDATE_SERVICE = "kmj-codebridge-auto-update.service";
const MAIN_PLATFORM_REFRESH_SERVICE =
  "kmj-codebridge-main-platform-refresh.service";
const MAIN_PLATFORM_AGENT_SERVICE = "kmj-codebridge-kmj-main-platform.service";
const UPDATE_TIMER = "kmj-codebridge-auto-update.timer";
const UPDATE_CHECK_SERVICE = "kmj-codebridge-stable-update.service";
const PRIVATE_PR322_CI_SERVICE = "kmj-codebridge-private-pr322-ci.service";
const PRIVATE_PR337_CI_SERVICE = "kmj-codebridge-private-pr337-ci.service";
const PRIVATE_PR337_CI_EVIDENCE =
  "/var/lib/kmj-codebridge-ci/evidence/latest-pr337.json";
const PRIVATE_PR322_CI_EVIDENCE =
  "/var/lib/kmj-codebridge-ci/evidence/latest-pr322.json";
const UPDATE_ROLLBACK_SERVICE = "kmj-codebridge-stable-rollback.service";
const UPDATE_INSTALL_ROOT = "/opt/kmj-codebridge-stable";
const UPDATE_HISTORY = "/var/lib/kmj-codebridge-update/release-history.json";
const RELEASE_NAME =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$/;
const SYSTEMCTL = "/usr/bin/systemctl";
const JOURNALCTL = "/usr/bin/journalctl";
const MAX_REQUEST_BYTES = 16384;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function defaultDeviceStatus() {
  const cpus = os.cpus();
  const [one, five, fifteen] = os.loadavg();
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage: { one, five, fifteen },
    uptimeSeconds: Math.floor(os.uptime()),
    processUptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
  };
}

function boundedDeviceStatus(raw) {
  const boundedString = (value, max) =>
    typeof value === "string" ? value.slice(0, max) : "unknown";
  const boundedNumber = (value, max = Number.MAX_SAFE_INTEGER) =>
    Number.isFinite(value) && value >= 0 ? Math.min(value, max) : 0;
  return {
    platform: boundedString(raw?.platform, 32),
    arch: boundedString(raw?.arch, 32),
    hostname: boundedString(raw?.hostname, 253),
    cpuCount: Math.floor(boundedNumber(raw?.cpuCount, 4096)),
    totalMemoryBytes: Math.floor(boundedNumber(raw?.totalMemoryBytes)),
    freeMemoryBytes: Math.floor(boundedNumber(raw?.freeMemoryBytes)),
    loadAverage: {
      one: boundedNumber(raw?.loadAverage?.one, 1000000),
      five: boundedNumber(raw?.loadAverage?.five, 1000000),
      fifteen: boundedNumber(raw?.loadAverage?.fifteen, 1000000),
    },
    uptimeSeconds: Math.floor(boundedNumber(raw?.uptimeSeconds)),
    processUptimeSeconds: Math.floor(boundedNumber(raw?.processUptimeSeconds)),
    nodeVersion: boundedString(raw?.nodeVersion, 64),
  };
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_SUPERVISOR_REQUEST");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)))
    fail("INVALID_SUPERVISOR_REQUEST");
}

function serviceUnit(service) {
  const unit = SERVICES[service];
  if (!unit) fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
  return unit;
}

function parseProperties(text) {
  const fields = {};
  for (const line of String(text).trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

function parseStatus(text) {
  const fields = parseProperties(text);
  return {
    activeState: fields.ActiveState ?? "unknown",
    subState: fields.SubState ?? "unknown",
    mainPid: Number(fields.MainPID ?? 0),
    restarts: Number(fields.NRestarts ?? 0),
  };
}

function fixedUnitStatus(run, unit, properties) {
  try {
    const fields = parseProperties(
      run(SYSTEMCTL, [
        "show",
        unit,
        "--property=LoadState",
        ...properties.map((name) => `--property=${name}`),
        "--no-pager",
      ]),
    );
    return {
      installed: fields.LoadState !== "not-found",
      ...Object.fromEntries(
        properties.map((name) => [
          name[0].toLowerCase() + name.slice(1),
          fields[name] ?? "unknown",
        ]),
      ),
    };
  } catch {
    return {
      installed: false,
      ...Object.fromEntries(
        properties.map((name) => [
          name[0].toLowerCase() + name.slice(1),
          "unknown",
        ]),
      ),
    };
  }
}

// Only expose explicitly allowlisted non-sensitive updater outcome markers.
function fixedUpdateMarkers(run, unit) {
  const commits = new Set([
    "AUTO_UPDATE_CURRENT",
    "AUTO_UPDATE_FROM",
    "AUTO_UPDATE_TO",
    "AUTO_UPDATE_APPLIED",
  ]);
  const flags = new Set([
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULE_FAILED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_SCHEDULED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_FAILED",
    "MAIN_PLATFORM_REFRESH_LEGACY_CONFIG_MIGRATED",
    "PRIVATE_CI_NATIVE_UNIT_INSTALLED",
    "AUTO_UPDATE_PRIVATE_CI_PROJECT_HARDENED",
    "AUTO_UPDATE_PRIVATE_CI_GIT_METADATA_HARDENED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_SCHEDULED",
    "AUTO_UPDATE_PRIVATE_PR337_CI_SCHEDULED",
    "AUTO_UPDATE_PRIVATE_PR322_REF_REFRESHED",
    "AUTO_UPDATE_PRIVATE_PR337_REF_REFRESHED",
  ]);
  const gitMetadataFields = new Map();
  for (const entry of [
    "GIT_DIRECTORY",
    "GIT_CONFIG",
    "TRUST_PROJECT_PARENT",
    "TRUST_SRV",
    "TRUST_ROOT",
    "TRUST_BASE",
    "TRUST_LOCK",
  ]) {
    for (const [field, values] of [
      [
        "READ",
        [
          "OK",
          "MISSING",
          "PERMISSION_DENIED",
          "OTHER_ERROR",
          "BLOCKED_DIRECTORY",
          "BLOCKED_BASE",
          "CHANGED",
        ],
      ],
      ["OWNER", ["MATCHES_PROJECT", "ROOT", "TRUSTED_SERVICE", "OTHER"]],
      ["GID", ["MATCHES_PRIMARY", "DIFFERS", "UNAVAILABLE"]],
      ["TYPE", ["DIRECTORY", "REGULAR", "SYMLINK", "OTHER"]],
      [
        "MODE",
        ["NONWRITE", "GROUP_WRITE", "WORLD_WRITE", "GROUP_AND_WORLD_WRITE"],
      ],
    ])
      gitMetadataFields.set(
        `AUTO_UPDATE_PRIVATE_CI_${entry}_${field}`,
        new Set(values),
      );
  }
  for (const field of ["NLINK", "SIZE"])
    gitMetadataFields.set(
      `AUTO_UPDATE_PRIVATE_CI_GIT_CONFIG_${field}`,
      new Set(["VALID", "INVALID"]),
    );
  for (const [key, values] of [
    ["TRUST_LOCK_NLINK", ["VALID", "INVALID"]],
    ["TRUST_LOCK_PRIVATE_MODE", ["VALID", "INVALID"]],
    ["TRUST_LOCK_IDENTITY", ["MATCHES_PATH", "CHANGED"]],
    ["TRUST_SOURCE_OWNER", ["ROOT", "TRUSTED_SERVICE"]],
    ["TRUST_GROUP", ["EXCLUSIVE", "OTHER_MEMBERS", "UNAVAILABLE"]],
    ["TRUST_WRITER_LOAD", ["LOADED", "NOT_LOADED", "UNAVAILABLE"]],
    ["TRUST_WRITER_UID", ["MATCHES_OWNER", "DIFFERS", "UNAVAILABLE"]],
  ])
    gitMetadataFields.set(`AUTO_UPDATE_PRIVATE_CI_${key}`, new Set(values));
  const refSteps = new Set([
    "PROJECT_METADATA",
    "PROJECT_LSTAT_READ",
    "PROJECT_LSTAT_MISSING",
    "PROJECT_LSTAT_PERMISSION_DENIED",
    "PROJECT_LSTAT_OTHER_ERROR",
    "PROJECT_DIRECTORY_TYPE",
    "PROJECT_DIRECTORY_SYMLINK",
    "PROJECT_DIRECTORY_OTHER_TYPE",
    "PROJECT_MODE",
    "PROJECT_MODE_GROUP_WRITE",
    "PROJECT_MODE_WORLD_WRITE",
    "PROJECT_MODE_GROUP_AND_WORLD_WRITE",
    "PROJECT_GROUP_EXCLUSIVITY",
    "PROJECT_WRITE_AUTHORITY_READ",
    "PROJECT_WRITE_AUTHORITY_DIFFERENT",
    "PROJECT_HARDEN_IDENTITY",
    "PROJECT_HARDEN_MODE",
    "PROJECT_ACCOUNT",
    "GIT_DIRECTORY",
    "GIT_CONFIG",
    "PROJECT_PARENTS",
    "CI_DIRECTORY",
    "CI_LOCK",
    "ORIGIN_READ",
    "ORIGIN_ALLOWLIST",
    "REF_CLEANUP",
  ]);
  const ownerSteps = new Set([
    "BASE_DIRECTORY",
    "EVIDENCE_DIRECTORY",
    "RUNTIME_DIRECTORY",
    "SCRIPTS_DIRECTORY",
    "UNIT_FILE",
    "UNIT_DEFINITION",
    "WORKER_FILE",
    "WRAPPER_FILE",
    "PREPARER_FILE",
    "CONTROL_REVISION",
    "SOURCE_REF_READ",
    "SOURCE_REF_FORMAT",
    "SOURCE_REF_MISMATCH",
    "MARKER_FILE",
    "MARKER_FORMAT",
    "UNIT_STATE",
    "SHARED_LOCK",
    "MARKER_CREATE",
    "UNIT_START",
    "MARKER_COMMIT",
  ]);
  const bare = new Set([
    "AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_DEFERRED_BUSY",
    "AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_DEFERRED_UNTRUSTED",
    "AUTO_UPDATE_PRIVATE_PR322_REF_CURRENT",
    "AUTO_UPDATE_PRIVATE_PR337_REF_CURRENT",
    "AUTO_UPDATE_PRIVATE_PR322_REF_REFRESH_FAILED",
    "AUTO_UPDATE_PRIVATE_PR337_REF_REFRESH_FAILED",
    "AUTO_UPDATE_PRIVATE_PR337_CI_ALREADY_SCHEDULED",
    "AUTO_UPDATE_PRIVATE_PR337_CI_DEFERRED_BUSY",
    "AUTO_UPDATE_PRIVATE_PR337_CI_START_FAILED",
    "AUTO_UPDATE_PRIVATE_PR337_CI_DEFERRED_UNTRUSTED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_ALREADY_SCHEDULED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_DEFERRED_BUSY",
    "AUTO_UPDATE_PRIVATE_PR322_CI_START_FAILED",
    "AUTO_UPDATE_PRIVATE_PR322_CI_DEFERRED_UNTRUSTED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_NODE_UNAVAILABLE",
    "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED_PROTECTED_OVERRIDE",
    "AUTO_UPDATE_MAIN_PLATFORM_UNIT_PREFLIGHT_UNAVAILABLE",
    "PRIVATE_CI_INSTALL_DEFERRED",
    "MAIN_PLATFORM_REFRESH_REQUIRES_EXISTING_ENROLLMENT",
    "MAIN_PLATFORM_REFRESH_PROJECT_MISSING",
    "MAIN_PLATFORM_REFRESH_RUNTIME_INVALID",
    "MAIN_PLATFORM_REFRESH_SERVICE_USER_MISSING",
    "MAIN_PLATFORM_REFRESH_SERVICE_USER_INVALID",
    "MAIN_PLATFORM_REFRESH_UNSAFE_CONFIG",
    "MAIN_PLATFORM_REFRESH_NODE_MISSING",
  ]);
  let lines;
  try {
    lines = String(
      run(JOURNALCTL, ["-u", unit, "-n", "120", "--no-pager", "--output=cat"]),
    ).split(/\r?\n/);
  } catch {
    return [];
  }
  return lines
    .map((line) => line.trim())
    .filter((line) => {
      if (bare.has(line)) return true;
      const split = line.indexOf("=");
      if (split < 1 || line.indexOf("=", split + 1) !== -1) return false;
      const key = line.slice(0, split);
      const value = line.slice(split + 1);
      return (
        (commits.has(key) && /^[a-f0-9]{40}$/.test(value)) ||
        (flags.has(key) && value === "1") ||
        gitMetadataFields.get(key)?.has(value) ||
        (key === "AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_UNTRUSTED_STEP" &&
          refSteps.has(value)) ||
        ([
          "AUTO_UPDATE_PRIVATE_PR322_CI_UNTRUSTED_STEP",
          "AUTO_UPDATE_PRIVATE_PR337_CI_UNTRUSTED_STEP",
        ].includes(key) &&
          ownerSteps.has(value))
      );
    })
    .slice(-64);
}

// Classify only hardcoded PR337 CI journal events. Do not return stderr,
// repository URLs, remote authentication details or attacker-controlled output.
function fixedWebsiteCiJournal(run) {
  const args = [
    "-u",
    PRIVATE_PR337_CI_SERVICE,
    "-n",
    "70",
    "--no-pager",
    "--output=cat",
  ];
  // Tie diagnostics to the last unit invocation where systemd provides an ID.
  // Accept only its fixed hex format before adding the journal match.
  try {
    const invocation = String(
      run(SYSTEMCTL, [
        "show",
        PRIVATE_PR337_CI_SERVICE,
        "--property=InvocationID",
        "--value",
        "--no-pager",
      ]),
    ).trim();
    if (/^[a-f0-9]{32}$/.test(invocation))
      args.push(`_SYSTEMD_INVOCATION_ID=${invocation}`);
  } catch {
    /* Older systemd status may not expose the invocation. */
  }
  return String(run(JOURNALCTL, args));
}

function fixedWebsiteCiDiagnostic(run) {
  let output;
  try {
    output = fixedWebsiteCiJournal(run);
  } catch {
    return "LOG_UNAVAILABLE";
  }
  const lines = output.split(/\r?\n/).slice(-70);
  for (const line of lines.reverse()) {
    if (line.includes("KMJ_CI_FIXED_REF_LOOKUP_FAILED"))
      return "FIXED_REF_LOOKUP_FAILED";
    if (line.includes("KMJ_CI_FIXED_REVISION_INVALID"))
      return "FIXED_REF_INVALID";
    if (line.includes("KMJ_CI_FIXED_PROJECT_UNAVAILABLE"))
      return "PROJECT_UNAVAILABLE";
    if (line.includes("CI_REF_SHA_MISMATCH")) return "HEAD_MISMATCH";
    if (line.includes("CI_DIRTY_SOURCE")) return "DIRTY_SOURCE";
    if (line.includes("CI_DEPENDENCY_LOCK_CONFLICT"))
      return "DEPENDENCY_LOCK_CONFLICT";
    if (line.includes("PRIVATE_WEBSITE_CI_ORIGIN_MISMATCH"))
      return "ORIGIN_MISMATCH";
    if (line.includes("PRIVATE_WEBSITE_CI_REF_REFRESH_FAILED"))
      return "REF_FETCH_FAILED";
    // Preparation tools may fail before the confined worker creates evidence.
    // Emit only fixed categories, never tool stderr or caller-derived paths.
    if (/^cp: /i.test(line)) {
      if (
        /preserving (?:times|permissions).*operation not permitted/i.test(line)
      )
        return "CP_METADATA_OPERATION_NOT_PERMITTED";
      if (/cannot stat /i.test(line)) {
        const source = /cannot stat ['‘]([^'’]+)['’]/i.exec(line)?.[1];
        if (
          source ===
          "/srv/kmj-codebridge-projects/kmj-main-platform/apps/platform/vendor"
        )
          return "CP_SOURCE_UNAVAILABLE_VENDOR";
        if (
          source ===
          "/srv/kmj-codebridge-projects/kmj-main-platform/apps/platform/node_modules"
        )
          return "CP_SOURCE_UNAVAILABLE_NPM";
        return "CP_SOURCE_UNAVAILABLE_OTHER";
      }
      if (/are the same file/i.test(line)) return "CP_SAME_FILE";
      if (/read-only file system/i.test(line)) return "CP_READ_ONLY_FILESYSTEM";
      if (/permission denied/i.test(line)) return "CP_PERMISSION_DENIED";
      if (/operation not permitted/i.test(line))
        return "CP_OPERATION_NOT_PERMITTED";
      return "CP_FAILED";
    }
    if (/^chown: /i.test(line)) {
      if (/read-only file system/i.test(line))
        return "CHOWN_READ_ONLY_FILESYSTEM";
      if (/permission denied/i.test(line)) return "CHOWN_PERMISSION_DENIED";
      if (/operation not permitted/i.test(line))
        return "CHOWN_OPERATION_NOT_PERMITTED";
      return "CHOWN_FAILED";
    }
    if (/^tar: /i.test(line)) {
      if (/read-only file system/i.test(line))
        return "TAR_READ_ONLY_FILESYSTEM";
      if (/permission denied/i.test(line)) return "TAR_PERMISSION_DENIED";
      if (/operation not permitted/i.test(line))
        return "TAR_OPERATION_NOT_PERMITTED";
      return "TAR_FAILED";
    }
    if (
      /^(?:systemd-run: |Failed to (?:start transient service unit|connect to bus):)/i.test(
        line,
      )
    )
      return "SYSTEMD_RUN_FAILED";
    if (/fatal: .*dubious ownership/i.test(line)) return "GIT_UNSAFE_OWNERSHIP";
    if (/fatal: .*not a git repository/i.test(line))
      return "GIT_REPO_UNAVAILABLE";
    if (/fatal: .*permission denied/i.test(line))
      return "GIT_PERMISSION_DENIED";
    if (/fatal: .*read-only file system/i.test(line))
      return "GIT_READ_ONLY_FILESYSTEM";
    if (/fatal: .*operation not permitted/i.test(line))
      return "GIT_OPERATION_NOT_PERMITTED";
    if (
      /fatal: .*path .*does not exist in/i.test(line) ||
      /fatal: .*path .*exists on disk, but not in/i.test(line)
    ) {
      const match =
        /fatal: path '([^']*)' (?:does not exist in|exists on disk, but not in) '([^']*)'/i.exec(
          line,
        );
      if (!match) return "GIT_PATH_UNAVAILABLE";
      const file =
        match[1] === "apps/platform/composer.lock"
          ? "COMPOSER"
          : match[1] === "apps/platform/package-lock.json"
            ? "NPM"
            : "OTHER";
      const revision =
        match[2] === "HEAD"
          ? "HEAD"
          : /^[a-f0-9]{40}$/.test(match[2])
            ? "COMMIT"
            : "UNKNOWN";
      return `GIT_PATH_UNAVAILABLE_${file}_${revision}`;
    }
    if (/fatal: .*ambiguous argument.*unknown revision/i.test(line))
      return "GIT_REF_UNAVAILABLE";
    if (/fatal: .*bad config/i.test(line)) return "GIT_CONFIG_INVALID";
    if (
      /fatal: .*(?:not a valid object name|bad object|invalid object name)/i.test(
        line,
      )
    )
      return "GIT_OBJECT_UNAVAILABLE";
    if (/fatal: .*unable to access/i.test(line)) return "GIT_ACCESS_FAILED";
    if (/fatal: /.test(line)) return "GIT_FATAL_OTHER";
  }
  return "NO_CLASSIFIED_ERROR";
}

// Read only the fixed CI source. Never fetch, print stderr, inspect credentials,
// or accept a caller-controlled Git revision, repository or filesystem path.
function fixedCiSource(run, owner = false) {
  const repo = "/srv/kmj-codebridge-projects/kmj-main-platform";
  const git = (...args) =>
    run("/usr/bin/git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    });
  const revision = (ref) => {
    try {
      const value = String(git("rev-parse", "--verify", ref)).trim();
      return /^[a-f0-9]{40}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  const locks = (sha) => {
    if (!sha) return null;
    return Object.fromEntries(
      [
        ["composer", "apps/platform/composer.lock"],
        ["npm", "apps/platform/package-lock.json"],
      ].map(([name, file]) => {
        try {
          git("cat-file", "-e", `${sha}:${file}`);
          return [name, true];
        } catch {
          return [name, false];
        }
      }),
    );
  };
  const headSha = revision("HEAD");
  const refSha = revision(
    owner
      ? "refs/remotes/origin/feat/codebridge-owner-tier"
      : "refs/remotes/origin/fix/public-marketing-standalone-nav-20261008",
  );
  return {
    headSha,
    refSha,
    headLocks: locks(headSha),
    refLocks: locks(refSha),
  };
}

// Preserve preceding non-fatal Git errors as fixed signals: a later fatal
// missing-path message can otherwise hide the actual object read failure.
function fixedWebsiteCiGitSignals(run) {
  let output;
  try {
    output = fixedWebsiteCiJournal(run);
  } catch {
    return null;
  }
  const stages = new Set([
    "REF_VERIFIED",
    "TARGET_LOCK_READ",
    "HEAD_LOCK_READ",
    "LOCKS_VERIFIED",
  ]);
  const lines = output.split(/\r?\n/).slice(-70);
  const stage =
    lines
      .map((line) => line.match(/^KMJ_CI_PREP_STAGE=(\w+)$/)?.[1])
      .filter((value) => stages.has(value))
      .at(-1) ?? null;
  return {
    permissionDenied: lines.some((line) =>
      /(?:error|fatal): .*permission denied/i.test(line),
    ),
    objectReadFailure: lines.some((line) =>
      /(?:error|fatal): .*(?:cannot open|unable to read|failed to read|unable to mmap|object file|packfile)/i.test(
        line,
      ),
    ),
    preparationStage: stage,
  };
}

function fixedMainPlatformMarkers(run) {
  const allowed = new Map([
    [
      "Existing Main Platform agent config verified.",
      "EXISTING_CONFIG_VERIFIED",
    ],
    [
      "KMJ Main Platform CodeBridge project agent is active.",
      "SERVICE_ACTIVE_CONFIRMED",
    ],
    ["MAIN_PLATFORM_AGENT_GATEWAY_VERIFIED", "GATEWAY_VERIFIED"],
    ["config_identity=PASS", "CONFIG_IDENTITY_PASS"],
    ["gateway_health=PASS", "GATEWAY_HEALTH_PASS"],
    ["credential_introspection=PASS", "CREDENTIAL_INTROSPECTION_PASS"],
    [
      "MAIN_PLATFORM_RUNTIME_NOT_ACCESSIBLE_TO_SERVICE_USER",
      "RUNTIME_PERMISSION_DENIED",
    ],
    [
      "MAIN_PLATFORM_RESTART_EFFECTIVE_UNIT_CONFLICT",
      "EFFECTIVE_UNIT_CONFLICT",
    ],
    ["MAIN_PLATFORM_RESTART_ACTIVE_JOB", "RESTART_DEFERRED_ACTIVE_JOB"],
    [
      "MAIN_PLATFORM_RESTART_FAILED_ROLLBACK_ATTEMPTED",
      "RESTART_ROLLBACK_ATTEMPTED",
    ],
  ]);
  let text;
  try {
    text = String(
      run(JOURNALCTL, [
        "-u",
        MAIN_PLATFORM_REFRESH_SERVICE,
        "-n",
        "120",
        "--no-pager",
        "--output=cat",
      ]),
    );
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => allowed.get(line.trim()))
    .filter(Boolean)
    .slice(-24);
}

// Secret-free, read-only effective-unit classification. Never return raw
// ExecStart/Environment/DropInPaths or accept a caller-selected unit/path.
// A release-named drop-in is NOT proof of signed release provenance.
function fixedMainPlatformEffectiveUnit(run) {
  const unit = fixedUnitStatus(run, MAIN_PLATFORM_AGENT_SERVICE, [
    "WorkingDirectory",
    "ExecStart",
    "DropInPaths",
  ]);
  const directory = unit.workingDirectory;
  const dropins = unit.dropInPaths;
  const staged =
    /^\/opt\/kmj-codebridge-main-platform-stage\/[a-f0-9]{40}$/.test(directory);
  const canary =
    /^\/opt\/kmj-codebridge-main-platform-agent-[a-zA-Z0-9_-]+$/.test(
      directory,
    );
  const release = /^\/opt\/kmj-codebridge-releases\/[a-f0-9]{12,40}$/.test(
    directory,
  );
  const expectedExec = `argv[]=/opt/kmj-codebridge-node/bin/node ${directory}/src/cli.js agent /etc/kmj-codebridge-main-platform/agent.json ;`;
  return {
    installed: unit.installed,
    runtimeKind: staged
      ? "staged-development"
      : canary
        ? "development-canary"
        : release
          ? "release-override-unverified"
          : "unknown",
    stagedRuntimeEffective: staged && unit.execStart.includes(expectedExec),
    releaseOverridePresent: /\/99-kmj-release\.conf(?:\s|$)/.test(dropins),
    developmentCanaryOverridePresent:
      /\/zz-kmj-codebridge-development-canary\.conf(?:\s|$)/.test(dropins),
    readinessOverridePresent: /\/30-readiness-runtime\.conf(?:\s|$)/.test(
      dropins,
    ),
    // Paths and release labels alone cannot authenticate a signed manifest.
    signedProductionProven: false,
  };
}

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
    ...options,
  });
}

function defaultStart(unit) {
  const child = spawn(SYSTEMCTL, ["start", unit], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
  });
  child.unref();
}

function defaultRestart(unit) {
  const child = spawn(SYSTEMCTL, ["restart", unit], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
  });
  child.unref();
}

// Read only root-owned, bounded native CI evidence. The PR code never writes
// this summary; the trusted systemd preparer creates it after the sandbox exits.
function classifyPrivateCiWorkerLog(text) {
  const missingName = /Cannot find (?:package|module) '([^'\r\n]+)'/.exec(
    text,
  )?.[1];
  let missingPackage;
  if (
    missingName === "vite-plus" ||
    /^@voidzero-dev\/vite-plus-(?:linux-(?:x64|arm64)-(?:gnu|musl)|win32-x64-msvc|darwin-(?:x64|arm64))$/.test(
      missingName ?? "",
    )
  )
    missingPackage = "VITE_PLUS";
  else if (
    /^@voidzero-dev\/vite-plus-core(?:-(?:linux|darwin|win32)-(?:x64|arm64)(?:-(?:gnu|musl|msvc))?)?$/.test(
      missingName ?? "",
    )
  )
    missingPackage = "VITE_PLUS_CORE";
  else if (
    /^(?:oxlint|@oxlint\/(?:linux|darwin|win32)-(?:x64|arm64)(?:-(?:gnu|musl|msvc))?)$/.test(
      missingName ?? "",
    )
  )
    missingPackage = "OXLINT";
  else if (
    /^(?:oxfmt|@oxfmt\/(?:linux|darwin|win32)-(?:x64|arm64)(?:-(?:gnu|musl|msvc))?)$/.test(
      missingName ?? "",
    )
  )
    missingPackage = "OXFMT";
  else if (
    /^(?:rolldown|@rolldown\/binding-(?:linux|darwin|win32)-(?:x64|arm64)(?:-(?:gnu|musl|msvc))?)$/.test(
      missingName ?? "",
    )
  )
    missingPackage = "ROLLDOWN";
  const result = (kind) => ({
    kind,
    ...(missingPackage ? { missingPackage } : {}),
  });
  const codes = new Set([
    "ERR_MODULE_NOT_FOUND",
    "MODULE_NOT_FOUND",
    "ERR_REQUIRE_ESM",
    "ERR_UNKNOWN_BUILTIN_MODULE",
    "ERR_DLOPEN_FAILED",
  ]);
  for (const match of text.matchAll(
    /Error \[([A-Z_]+)\]:|^[ \t]*code: ['"]([A-Z_]+)['"],?[ \t]*$/gm,
  )) {
    const code = match[1] ?? match[2];
    if (codes.has(code)) return result(`NODE_${code}`);
  }
  if (/^Error: Cannot find module '/m.test(text))
    return result("NODE_MODULE_NOT_FOUND");
  if (/^Error: Cannot find package '/m.test(text))
    return result("NODE_ERR_MODULE_NOT_FOUND");
  const posix =
    /(?:^Error: (ENOENT|EACCES|EPERM):|^[ \t]*code: ['"](ENOENT|EACCES|EPERM)['"],?[ \t]*$)/m.exec(
      text,
    );
  if (posix) return result(`WORKER_${posix[1] ?? posix[2]}`);
  if (/^[ \t]*SyntaxError(?: \[[A-Z_]+\])?: /m.test(text))
    return result("NODE_SYNTAX_ERROR");
  if (/^[ \t]*TypeError(?: \[[A-Z_]+\])?: /m.test(text))
    return result("NODE_TYPE_ERROR");
  if (
    /^(?:\/bin\/)?bash: \/opt\/kmj-codebridge-agent\/scripts\/ci-main-platform-pr-worker\.sh: Permission denied$/m.test(
      text,
    )
  )
    return result("WORKER_SCRIPT_PERMISSION_DENIED");
  if (/^fatal: not a git repository\b/m.test(text))
    return result("GIT_REPO_UNAVAILABLE");
  if (/npm (?:error|ERR!) code EBADENGINE/.test(text))
    return result("NODE_ENGINE_ERROR");
  if (
    /(?:Cannot find native binding|Failed to load native binding)/i.test(text)
  )
    return result("NATIVE_BINDING_LOAD_ERROR");
  if (/Formatting issues found in [1-9][0-9]* files?\b/i.test(text))
    return result("FORMAT_ISSUES_REPORTED");
  for (const match of text.matchAll(
    /Found ([0-9]+) warnings? and ([0-9]+) errors?\./g,
  )) {
    if (Number(match[1]) > 0 || Number(match[2]) > 0)
      return result("LINT_ISSUES_REPORTED");
  }
  return result("COMMAND_FAILED_UNCLASSIFIED");
}

function readBoundedPrivateCiLog(filename) {
  const limit = 16 * 1024 * 1024;
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const meta = fs.fstatSync(fd);
    if (
      !meta.isFile() ||
      meta.uid !== 0 ||
      meta.nlink !== 1 ||
      (meta.mode & 0o077) !== 0 ||
      meta.size <= 0 ||
      meta.size > limit
    )
      return null;
    const bytes = Buffer.alloc(Math.min(meta.size + 1, limit + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(
        fd,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (
      length !== meta.size ||
      after.size !== meta.size ||
      after.mtimeMs !== meta.mtimeMs ||
      after.ctimeMs !== meta.ctimeMs
    )
      return null;
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

// Read only a bounded root-owned log whose bytes match trusted CI evidence.
// Filenames and returned categories are fixed; raw worker output never escapes.
function privateCiWorkerLogDiagnostic(lstat, readdir, readLog, record) {
  if (record.exit_code === 0) return undefined;
  const directory = "/var/lib/kmj-codebridge-ci/evidence";
  const limit = 16 * 1024 * 1024;
  try {
    const directoryMeta = lstat(directory);
    if (
      !directoryMeta.isDirectory() ||
      directoryMeta.isSymbolicLink() ||
      directoryMeta.uid !== 0 ||
      (directoryMeta.mode & 0o022) !== 0
    )
      return undefined;
    const entries = readdir(directory);
    if (!Array.isArray(entries) || entries.length > 1000) return undefined;
    const candidates = entries
      .filter((name) => {
        if (typeof name !== "string") return false;
        const match = /^([a-f0-9]{40})-([0-9]{8}T[0-9]{6}Z)\.log$/.exec(name);
        if (!match || match[1] !== record.sha) return false;
        const stamp = match[2];
        const date = new Date(
          `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
        );
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().replace(/[-:]/g, "").replace(".000", "") === stamp
        );
      })
      .sort()
      .reverse()
      .slice(0, 20);
    for (const name of candidates) {
      const filename = `${directory}/${name}`;
      const meta = lstat(filename);
      if (
        !meta.isFile() ||
        meta.isSymbolicLink() ||
        meta.uid !== 0 ||
        meta.nlink !== 1 ||
        (meta.mode & 0o077) !== 0 ||
        meta.size <= 0 ||
        meta.size > limit
      )
        continue;
      const bytes = readLog(filename);
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length === 0 ||
        bytes.length > limit ||
        createHash("sha256").update(bytes).digest("hex") !== record.log_sha256
      )
        continue;
      return classifyPrivateCiWorkerLog(bytes.toString("utf8"));
    }
  } catch {
    // Unreadable, oversized, untrusted or unmatched logs produce no diagnosis.
  }
  return undefined;
}

function nativeCiPrerequisiteStatus(lstat, readFile) {
  try {
    const filename = "/var/lib/kmj-codebridge-ci/prerequisites/status.json";
    const meta = lstat(filename);
    if (
      !meta.isFile() ||
      meta.isSymbolicLink() ||
      meta.uid !== 0 ||
      meta.nlink !== 1 ||
      (meta.mode & 0o077) !== 0 ||
      meta.size <= 0 ||
      meta.size > 512
    )
      return null;
    const record = JSON.parse(readFile(filename));
    if (
      record.schema !== 1 ||
      !["INSTALLING", "READY", "FAILED"].includes(record.state) ||
      typeof record.missingTool !== "string" ||
      !["", "CC", "MAKE", "BISON", "FLEX", "PG_VIRTUALENV"].includes(
        record.missingTool,
      ) ||
      (record.state !== "FAILED" && record.missingTool !== "")
    )
      return null;
    return { state: record.state, missingTool: record.missingTool || null };
  } catch {
    return null;
  }
}

function privateCiEvidence(lstat, readFile, pr, filename, logAccess) {
  try {
    const meta = lstat(filename);
    if (
      !meta.isFile() ||
      meta.isSymbolicLink() ||
      meta.uid !== 0 ||
      meta.nlink !== 1 ||
      (meta.mode & 0o077) !== 0 ||
      meta.size <= 0 ||
      meta.size > 4096
    )
      return null;
    const record = JSON.parse(readFile(filename));
    if (
      record.schema !== 1 ||
      record.repo !== "kmjtechno/kmj-main-platform" ||
      record.pr !== pr ||
      !/^[a-f0-9]{40}$/.test(record.sha) ||
      !["PASS", "FAIL"].includes(record.linux_result) ||
      !Number.isInteger(record.exit_code) ||
      record.exit_code < 0 ||
      record.exit_code > 255 ||
      record.github_actions !== "NOT_RUN" ||
      record.windows !== "NOT_RUN" ||
      record.signed_production !== false ||
      !/^[a-f0-9]{64}$/.test(record.log_sha256)
    )
      return null;
    const gates = new Set([
      "php_key_generate",
      "php_migrations",
      "php_syntax",
      "platform_runtime",
      "license_runtime",
      "public_layout",
      "fmt_lint",
      "frontend_build",
      "typescript",
      "php_format",
      "php_tests",
      "activation_proof",
      "renewal",
      "node_lease_interop",
      "postgres_concurrency",
      "php_config_clear",
      "php_static_analysis",
      "foundation_python_runtime",
      "foundation_compile",
      "foundation_workers",
      "foundation_browser_qa",
      "foundation_policy",
      "foundation_backup",
      "foundation_architecture",
      "foundation_delivery",
      "foundation_public_surface",
      "foundation_free_router",
      "foundation_contracts",
      "rust_format",
      "rust_tests",
      "kslp_contract",
      "foundation_module_architecture",
      "foundation_runtime",
      "lease_encoder_syntax",
    ]);
    if (
      record.gate_markers !== undefined &&
      (!Array.isArray(record.gate_markers) ||
        record.gate_markers.length > gates.size ||
        new Set(record.gate_markers).size !== record.gate_markers.length ||
        record.gate_markers.some((label) => !gates.has(label)))
    )
      return null;
    const failures = new Set([
      "VP_NOT_FOUND",
      "WORKER_SANDBOX_START_FAILED",
      "PG_UNAVAILABLE",
      "COMMAND_FAILED_UNCLASSIFIED",
    ]);
    if (
      (record.failed_gate !== undefined &&
        record.failed_gate !== null &&
        !gates.has(record.failed_gate)) ||
      (record.failure_kind !== undefined &&
        record.failure_kind !== null &&
        !failures.has(record.failure_kind))
    )
      return null;
    for (const field of ["base_sha", "consumer_sha"]) {
      if (
        record[field] !== undefined &&
        (typeof record[field] !== "string" ||
          !/^[a-f0-9]{40}$/.test(record[field]))
      )
        return null;
    }
    if (
      record.consumer_license_sha256 !== undefined &&
      (typeof record.consumer_license_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.consumer_license_sha256))
    )
      return null;
    const runtimeNames = new Set([
      "PHP",
      "NODE_PLATFORM",
      "NODE_CONSUMER",
      "PYTHON",
      "CARGO",
      "POSTGRES",
    ]);
    if (
      record.runtime_versions !== undefined &&
      (record.runtime_versions === null ||
        typeof record.runtime_versions !== "object" ||
        Array.isArray(record.runtime_versions) ||
        Object.entries(record.runtime_versions).some(
          ([name, value]) =>
            !runtimeNames.has(name) ||
            typeof value !== "string" ||
            value.length > 64 ||
            !(
              value === "UNAVAILABLE" ||
              /^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/.test(value)
            ),
        ))
    )
      return null;
    const workerLogDiagnostic = logAccess
      ? privateCiWorkerLogDiagnostic(
          lstat,
          logAccess.readdir,
          logAccess.readLog,
          record,
        )
      : undefined;
    return {
      ...(workerLogDiagnostic !== undefined
        ? {
            workerLogDiagnostic: workerLogDiagnostic.kind,
            ...(workerLogDiagnostic.missingPackage
              ? { workerLogMissingPackage: workerLogDiagnostic.missingPackage }
              : {}),
          }
        : {}),
      testedSha: record.sha,
      ...(record.runtime_versions !== undefined
        ? { runtimeVersions: record.runtime_versions }
        : {}),
      ...(record.gate_markers !== undefined
        ? { gateMarkers: record.gate_markers }
        : {}),
      ...(record.base_sha !== undefined ? { baseSha: record.base_sha } : {}),
      ...(record.consumer_sha !== undefined
        ? { consumerSha: record.consumer_sha }
        : {}),
      ...(record.consumer_license_sha256 !== undefined
        ? { consumerLicenseSha256: record.consumer_license_sha256 }
        : {}),
      ...(record.failed_gate !== undefined
        ? { failedGate: record.failed_gate }
        : {}),
      ...(record.failure_kind !== undefined
        ? { failureKind: record.failure_kind }
        : {}),
      linuxResult: record.linux_result,
      exitCode: record.exit_code,
      logSha256: record.log_sha256,
      githubActions: "NOT_RUN",
      windows: "NOT_RUN",
      signedProduction: false,
    };
  } catch {
    return null;
  }
}

export function createSupervisorHandler({
  run = defaultRun,
  start = defaultStart,
  restart = defaultRestart,
  readFile = (file) => fs.readFileSync(file, "utf8"),
  readLog = readBoundedPrivateCiLog,
  readdir = (directory) => fs.readdirSync(directory),
  readlink = (file) => fs.readlinkSync(file),
  lstat = (file) => fs.lstatSync(file),
  statfs = (target) => fs.statfsSync(target),
  exists = (target) => fs.existsSync(target),
  stat = (target) => fs.statSync(target),
  deviceStatus = defaultDeviceStatus,
} = {}) {
  const readUpdateState = () => {
    const readReleaseLink = (name) => {
      try {
        const link = `${UPDATE_INSTALL_ROOT}/${name}`;
        if (!lstat(link).isSymbolicLink()) return null;
        const target = readlink(link);
        const match = /^releases\/([^/]+)$/.exec(target);
        return match && RELEASE_NAME.test(match[1]) ? match[1] : null;
      } catch {
        return null;
      }
    };
    let releases = [];
    try {
      const raw = JSON.parse(readFile(UPDATE_HISTORY));
      if (Array.isArray(raw))
        releases = raw.slice(-20).map((entry) => ({
          action: ["activate", "rollback"].includes(entry?.action)
            ? entry.action
            : "unknown",
          release:
            typeof entry?.release === "string" &&
            RELEASE_NAME.test(entry.release)
              ? entry.release
              : "unknown",
          previous:
            entry?.previous === null
              ? null
              : typeof entry?.previous === "string" &&
                  RELEASE_NAME.test(entry.previous)
                ? entry.previous
                : null,
          at: typeof entry?.at === "string" ? entry.at.slice(0, 64) : null,
        }));
    } catch {
      releases = [];
    }
    return {
      current: readReleaseLink("current"),
      previous: readReleaseLink("previous"),
      releases,
    };
  };

  return async function handle(request) {
    exactKeys(request, ["op", "service", "lines", "projectId"]);
    if (typeof request.op !== "string") fail("INVALID_SUPERVISOR_REQUEST");

    if (request.op === "status") {
      exactKeys(request, ["op", "service"]);
      const unit = serviceUnit(request.service);
      const output = run(SYSTEMCTL, [
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=NRestarts",
        "--no-pager",
      ]);
      return { response: { service: request.service, ...parseStatus(output) } };
    }

    if (request.op === "logs") {
      exactKeys(request, ["op", "service", "lines"]);
      const unit = serviceUnit(request.service);
      const lines = request.lines ?? 80;
      if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        fail("INVALID_SUPERVISOR_REQUEST");
      const output = run(JOURNALCTL, [
        "-u",
        unit,
        "-n",
        String(lines),
        "--no-pager",
        "--output=short-iso",
      ]);
      return {
        response: {
          service: request.service,
          lines,
          output: redact(String(output)).slice(0, 65536),
        },
      };
    }

    if (request.op === "config_validate") {
      exactKeys(request, ["op", "service"]);
      const configPath = CONFIGS[request.service];
      if (!configPath) fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
      try {
        const raw = JSON.parse(readFile(configPath));
        if (request.service === "agent") agentSchema.parse(raw);
        else gatewaySchema.parse(raw);
        return { response: { service: request.service, valid: true } };
      } catch {
        return { response: { service: request.service, valid: false } };
      }
    }

    if (request.op === "restart") {
      exactKeys(request, ["op", "service"]);
      const unit = serviceUnit(request.service);
      return {
        response: { service: request.service, accepted: true },
        afterSend: () => restart(unit),
      };
    }

    if (request.op === "device_status") {
      exactKeys(request, ["op"]);
      return { response: boundedDeviceStatus(deviceStatus()) };
    }

    if (request.op === "project_status") {
      exactKeys(request, ["op", "projectId"]);
      if (
        typeof request.projectId !== "string" ||
        !PROJECT_ID.test(request.projectId)
      )
        fail("INVALID_SUPERVISOR_REQUEST");
      let agentConfig;
      try {
        agentConfig = agentSchema.parse(JSON.parse(readFile(CONFIGS.agent)));
      } catch {
        fail("SUPERVISOR_CONFIG_INVALID");
      }
      const managedProject = agentConfig.projects.find(
        (project) => project.id === request.projectId,
      );
      if (!managedProject) fail("SUPERVISOR_PROJECT_NOT_AUTHORIZED");
      const root = managedProject.root;
      const present = exists(root);
      let directory = false;
      let gitCheckout = false;
      if (present) {
        try {
          directory = stat(root).isDirectory();
          gitCheckout = directory && exists(`${root}/.git`);
        } catch {
          directory = false;
          gitCheckout = false;
        }
      }
      return {
        response: {
          projectId: request.projectId,
          present,
          directory,
          gitCheckout,
        },
      };
    }

    if (request.op === "disk_space") {
      exactKeys(request, ["op"]);
      const target = fs.existsSync("/var/lib/kmj-codebridge")
        ? "/var/lib/kmj-codebridge"
        : "/";
      const stats = statfs(target);
      const blockSize = Number(stats.bsize);
      return {
        response: {
          target,
          totalBytes: Number(stats.blocks) * blockSize,
          freeBytes: Number(stats.bavail) * blockSize,
        },
      };
    }

    if (request.op === "update_status") {
      exactKeys(request, ["op"]);
      const timer = fixedUnitStatus(run, UPDATE_TIMER, [
        "ActiveState",
        "SubState",
        "UnitFileState",
      ]);
      const service = fixedUnitStatus(run, UPDATE_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
      ]);
      const safeFixedPath = (fixedPath, directory = false) => {
        try {
          const info = lstat(fixedPath);
          return (
            !info.isSymbolicLink() &&
            (directory ? info.isDirectory() : info.isFile() && info.nlink === 1)
          );
        } catch {
          return false;
        }
      };
      const mainPlatformPrerequisites = {
        currentConfig: safeFixedPath(
          "/etc/kmj-codebridge-main-platform/agent.json",
        ),
        legacyConfig: safeFixedPath(
          "/etc/kmj-codebridge/agents/kmj-main-platform.json",
        ),
        projectGit: safeFixedPath(
          "/srv/kmj-codebridge-projects/kmj-main-platform/.git",
          true,
        ),
      };
      const mainPlatformAgent = fixedUnitStatus(
        run,
        MAIN_PLATFORM_AGENT_SERVICE,
        [
          "ActiveState",
          "SubState",
          "MainPID",
          "NRestarts",
          "ExecMainStartTimestamp",
        ],
      );
      const mainPlatformRefresh = fixedUnitStatus(
        run,
        MAIN_PLATFORM_REFRESH_SERVICE,
        [
          "ActiveState",
          "SubState",
          "ConditionResult",
          "Result",
          "ExecMainStatus",
          "ExecMainStartTimestamp",
          "ExecMainExitTimestamp",
        ],
      );
      return {
        response: {
          available: timer.installed && service.installed,
          timer,
          service,
          mainPlatformRefresh,
          mainPlatformAgent,
          nativeCiPrerequisites: nativeCiPrerequisiteStatus(lstat, readFile),
          privatePr322Ci: fixedUnitStatus(run, PRIVATE_PR322_CI_SERVICE, [
            "ActiveState",
            "SubState",
            "Result",
            "ExecMainStatus",
            "ExecMainStartTimestamp",
            "ExecMainExitTimestamp",
          ]),
          privatePr337Ci: fixedUnitStatus(run, PRIVATE_PR337_CI_SERVICE, [
            "ActiveState",
            "SubState",
            "Result",
            "ExecMainStatus",
            "ExecMainStartTimestamp",
            "ExecMainExitTimestamp",
            "InvocationID",
          ]),
          privatePr322Evidence: privateCiEvidence(
            lstat,
            readFile,
            322,
            PRIVATE_PR322_CI_EVIDENCE,
            { readLog, readdir },
          ),
          privatePr337Evidence: privateCiEvidence(
            lstat,
            readFile,
            337,
            PRIVATE_PR337_CI_EVIDENCE,
            { readLog, readdir },
          ),
          privatePr337Diagnostic: fixedWebsiteCiDiagnostic(run),
          privatePr337GitSignals: fixedWebsiteCiGitSignals(run),
          privatePr322Source: fixedCiSource(run, true),
          privatePr337Source: fixedCiSource(run),
          mainPlatformEffectiveUnit: fixedMainPlatformEffectiveUnit(run),
          mainPlatformPrerequisites,
          mainPlatformEvidence: fixedMainPlatformMarkers(run),
          updateMarkers: fixedUpdateMarkers(run, UPDATE_SERVICE),
          mainPlatformRefreshMarkers: fixedUpdateMarkers(
            run,
            MAIN_PLATFORM_REFRESH_SERVICE,
          ),
        },
      };
    }

    if (request.op === "main_platform_refresh_status") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, MAIN_PLATFORM_REFRESH_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
      ]);
      return {
        response: {
          available: service.installed,
          service,
        },
      };
    }

    if (request.op === "main_platform_refresh") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, MAIN_PLATFORM_REFRESH_SERVICE, [
        "ActiveState",
        "SubState",
      ]);
      if (!service.installed)
        fail("SUPERVISOR_MAIN_PLATFORM_REFRESH_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(MAIN_PLATFORM_REFRESH_SERVICE),
      };
    }

    if (request.op === "private_pr322_ci_status") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, PRIVATE_PR322_CI_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
        "ExecMainStartTimestamp",
        "ExecMainExitTimestamp",
      ]);
      const last = privateCiEvidence(
        lstat,
        readFile,
        322,
        PRIVATE_PR322_CI_EVIDENCE,
        { readLog, readdir },
      );
      return { response: { service, last } };
    }

    if (request.op === "private_pr322_ci_start") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, PRIVATE_PR322_CI_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_PRIVATE_CI_UNAVAILABLE");
      if (service.activeState === "active") fail("SUPERVISOR_PRIVATE_CI_BUSY");
      return {
        response: { accepted: true, target: "private-pr322" },
        afterSend: () => start(PRIVATE_PR322_CI_SERVICE),
      };
    }

    if (request.op === "private_pr337_ci_status") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, PRIVATE_PR337_CI_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
      ]);
      const last = privateCiEvidence(
        lstat,
        readFile,
        337,
        PRIVATE_PR337_CI_EVIDENCE,
        { readLog, readdir },
      );
      return { response: { service, last } };
    }

    if (request.op === "private_pr337_ci_start") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, PRIVATE_PR337_CI_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_PRIVATE_CI_UNAVAILABLE");
      if (service.activeState === "active") fail("SUPERVISOR_PRIVATE_CI_BUSY");
      return {
        response: { accepted: true, target: "private-pr337" },
        afterSend: () => start(PRIVATE_PR337_CI_SERVICE),
      };
    }

    if (request.op === "update_check") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, UPDATE_CHECK_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_UPDATE_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(UPDATE_CHECK_SERVICE),
      };
    }

    if (request.op === "release_history") {
      exactKeys(request, ["op"]);
      return { response: readUpdateState() };
    }

    if (request.op === "update_rollback") {
      exactKeys(request, ["op"]);
      const state = readUpdateState();
      if (!state.previous) fail("SUPERVISOR_ROLLBACK_UNAVAILABLE");
      const service = fixedUnitStatus(run, UPDATE_ROLLBACK_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_ROLLBACK_UNAVAILABLE");
      return {
        response: { accepted: true, target: "previous" },
        afterSend: () => start(UPDATE_ROLLBACK_SERVICE),
      };
    }

    if (request.op === "update_now") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, UPDATE_SERVICE, ["ActiveState"]);
      if (!service.installed) fail("SUPERVISOR_UPDATE_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(UPDATE_SERVICE),
      };
    }

    fail("SUPERVISOR_OPERATION_NOT_ALLOWED");
  };
}

export async function startSupervisor({
  fd = null,
  socketPath = null,
  idleMs = 60000,
  handler = createSupervisorHandler(),
} = {}) {
  if (process.platform === "win32") fail("SUPERVISOR_UNSUPPORTED");
  if (fd === null && !socketPath) fail("SUPERVISOR_LISTENER_REQUIRED");

  let active = 0;
  let idleTimer = null;
  let closing = false;
  const server = net.createServer((socket) => {
    active += 1;
    if (idleTimer) clearTimeout(idleTimer);
    let received = Buffer.alloc(0);

    const finish = () => {
      active = Math.max(0, active - 1);
      if (fd !== null && active === 0 && !closing) {
        idleTimer = setTimeout(
          () => {
            closing = true;
            server.close();
          },
          Math.max(1000, idleMs),
        );
        idleTimer.unref?.();
      }
    };

    socket.on("data", async (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      const raw = received.subarray(0, newline).toString("utf8");
      socket.pause();
      try {
        const request = JSON.parse(raw);
        const { response, afterSend } = await handler(request);
        socket.end(
          JSON.stringify({ ok: true, result: response }) + "\n",
          () => {
            if (afterSend) setTimeout(afterSend, 750).unref?.();
          },
        );
      } catch (error) {
        socket.end(
          JSON.stringify({ ok: false, error: publicError(error).error }) + "\n",
        );
      }
    });
    socket.once("close", finish);
    socket.once("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fd !== null ? { fd } : { path: socketPath }, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise((resolve) => {
        closing = true;
        if (idleTimer) clearTimeout(idleTimer);
        server.close(resolve);
      }),
  };
}
