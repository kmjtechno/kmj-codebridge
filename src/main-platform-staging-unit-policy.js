import { createHash } from "node:crypto";
import { posix } from "node:path";

// All paths and operations are compiled into the trusted Supervisor. Neither
// the agent nor the MCP caller may choose a command, path, unit, or branch.
export const STAGING_DEPLOY_UNIT = "kmj-main-platform-staging-deploy.service";
const UNIT_FILE = "/etc/systemd/system/" + STAGING_DEPLOY_UNIT;
const RUNNER_FILE =
  "/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh";
const APPROVAL_FILE = "/etc/kmj-codebridge/main-platform-staging-approval.json";
const STAGING_LINK = "/home/kmjstage/htdocs/staging.kmjtechno.com";
const PRODUCTION_LINK = "/home/kmjprod/current";
const STAGING_SOCKET = "/run/php/kmjstage-php84-fpm.sock";
const SYSTEMCTL = "/usr/bin/systemctl";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RELEASE = /^[a-z0-9][a-z0-9_-]{3,100}$/;
const KEYS = [
  "schema",
  "approvedSha",
  "expectedCurrentSha",
  "expectedProductionRelease",
  "runnerSha256",
  "unitSha256",
  "backupVerified",
  "rollbackVerified",
  "storageVerified",
  "zeroAdditionalCostVerified",
];

// systemctl is an attestation input, not a best-effort status parser.
// Duplicate, missing, extra or malformed properties must never turn an
// ambiguous response into permission to start the privileged staging unit.
function properties(text, expectedKeys) {
  if (
    typeof text !== "string" ||
    text.length > 4096 ||
    !text.endsWith("\n") ||
    /[\r\0]/.test(text)
  )
    return {};
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== expectedKeys.length) return {};
  const parsed = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator < 1) return {};
    const key = line.slice(0, separator);
    if (!expectedKeys.includes(key) || Object.hasOwn(parsed, key)) return {};
    parsed[key] = line.slice(separator + 1);
  }
  return parsed;
}

// A root-owned file is replaceable when an ancestor is writable or symlinked.
function protectedAncestors(path, lstat) {
  let parent = posix.dirname(path);
  for (;;) {
    try {
      const info = lstat(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== 0 ||
        (info.mode & 0o022) !== 0
      )
        return false;
    } catch {
      return false;
    }
    if (parent === "/") return true;
    parent = posix.dirname(parent);
  }
}

function protectedText(path, maxBytes, { lstat, readFile }) {
  if (!protectedAncestors(path, lstat)) return null;
  try {
    const info = lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      info.nlink !== 1 ||
      (info.mode & 0o022) !== 0 ||
      !Number.isInteger(info.size) ||
      info.size < 1 ||
      info.size > maxBytes
    )
      return null;
    const text = readFile(path);
    return typeof text === "string" &&
      Buffer.byteLength(text, "utf8") <= maxBytes
      ? text
      : null;
  } catch {
    return null;
  }
}

function pointerSha(link, pattern, { lstat, readlink }) {
  try {
    if (!lstat(link).isSymbolicLink()) return null;
    const target = readlink(link);
    return pattern.exec(target)?.[1] ?? null;
  } catch {
    return null;
  }
}

function serviceProperties(name, fields, run) {
  try {
    return properties(
      run(SYSTEMCTL, [
        "show",
        name,
        "--property=LoadState",
        ...fields.map((key) => "--property=" + key),
        "--no-pager",
      ]),
      ["LoadState", ...fields],
    );
  } catch {
    return {};
  }
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function attestMainPlatformStaging({
  lstat,
  readFile,
  readlink,
  stat,
  run,
}) {
  const blockers = [];
  const raw = protectedText(APPROVAL_FILE, 4096, { lstat, readFile });
  let approval = null;
  if (raw !== null) {
    try {
      const value = JSON.parse(raw);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === KEYS.length &&
        Object.keys(value).every((key) => KEYS.includes(key)) &&
        value.schema === "kmj.main-platform.staging-approval.v1" &&
        SHA.test(value.approvedSha) &&
        SHA.test(value.expectedCurrentSha) &&
        value.approvedSha !== value.expectedCurrentSha &&
        RELEASE.test(value.expectedProductionRelease) &&
        DIGEST.test(value.runnerSha256) &&
        DIGEST.test(value.unitSha256) &&
        value.backupVerified === true &&
        value.rollbackVerified === true &&
        value.storageVerified === true &&
        value.zeroAdditionalCostVerified === true
      )
        approval = value;
    } catch {
      // An unreadable or invalid root-owned manifest cannot grant privileges.
    }
  }
  if (!approval) blockers.push("PROTECTED_STAGING_APPROVAL_INVALID");

  const stageSha = pointerSha(
    STAGING_LINK,
    /^\/home\/kmjstage\/releases\/([a-f0-9]{40})\/apps\/platform$/,
    { lstat, readlink },
  );
  const prodRelease = pointerSha(
    PRODUCTION_LINK,
    /^\/home\/kmjprod\/releases\/([a-z0-9][a-z0-9_-]{3,100})$/,
    { lstat, readlink },
  );
  if (!stageSha) blockers.push("STAGING_POINTER_UNVERIFIED");
  if (!prodRelease) blockers.push("PRODUCTION_POINTER_UNVERIFIED");
  if (approval && stageSha !== approval.expectedCurrentSha)
    blockers.push("STAGING_BASELINE_DRIFT");
  if (approval && prodRelease !== approval.expectedProductionRelease)
    blockers.push("PRODUCTION_DRIFT");

  const unit = serviceProperties(
    STAGING_DEPLOY_UNIT,
    ["ActiveState", "FragmentPath", "DropInPaths", "NeedDaemonReload"],
    run,
  );
  const unitReady =
    unit.LoadState === "loaded" &&
    unit.ActiveState === "inactive" &&
    unit.FragmentPath === UNIT_FILE &&
    unit.DropInPaths === "" &&
    unit.NeedDaemonReload === "no";
  if (!unitReady) blockers.push("GUARDED_STAGING_UNIT_UNAVAILABLE");

  // systemd drop-ins and unit/script content are independently checked.
  // A root-owned approval file alone is not enough for arbitrary root code.
  const runner = protectedText(RUNNER_FILE, 131072, { lstat, readFile });
  const unitText = protectedText(UNIT_FILE, 16384, { lstat, readFile });
  if (!approval || runner === null || digest(runner) !== approval.runnerSha256)
    blockers.push("STAGING_RUNNER_ATTESTATION_FAILED");
  if (
    !approval ||
    unitText === null ||
    digest(unitText) !== approval.unitSha256
  )
    blockers.push("STAGING_UNIT_ATTESTATION_FAILED");
  if (unitText && !unitText.includes("ExecStart=/usr/bin/bash " + RUNNER_FILE))
    blockers.push("STAGING_FIXED_EXECSTART_MISSING");

  for (const service of ["nginx.service", "php8.4-fpm.service"]) {
    const status = serviceProperties(service, ["ActiveState"], run);
    if (status.LoadState !== "loaded" || status.ActiveState !== "active")
      blockers.push(
        service === "nginx.service" ? "NGINX_NOT_ACTIVE" : "PHP_FPM_NOT_ACTIVE",
      );
  }
  try {
    if (!stat(STAGING_SOCKET).isSocket())
      blockers.push("STAGING_PHP_SOCKET_INVALID");
  } catch {
    blockers.push("STAGING_PHP_SOCKET_INVALID");
  }

  return {
    approvedSha: approval?.approvedSha ?? null,
    expectedCurrentSha: approval?.expectedCurrentSha ?? null,
    currentSha: stageSha,
    productionUnchanged: Boolean(
      approval && prodRelease === approval.expectedProductionRelease,
    ),
    unitInstalled: unit.LoadState === "loaded",
    ready: blockers.length === 0,
    blockers,
    // Never expose root-owned scripts, command lines or private unit contents.
  };
}
