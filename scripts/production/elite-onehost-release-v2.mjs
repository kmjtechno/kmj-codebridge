#!/usr/bin/env node
// KMJ-elite single-host owner-sign + existing signed auto-deploy admission.
// Only a pre-existing protected-main review may merge the signed release PR.
// Never installs, migrates or exposes a signing key, and never runs root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = "/usr/local/libexec/kmj-codebridge-elite-signer";
const SIGNER = path.join(ROOT, "production/owner-auto-sign-stable-v2.mjs");
const GATE = path.join(ROOT, "release-ci-gate.mjs");
const SIGNER_PIN =
  "86ad48d666eeecbf7cac955011b59397c91cef52f32e3deb80fa321c349b37bf";
const GATE_PIN =
  "74014d9ca667d73997f0286cabf294679906317916892784ce9d9e7da1338bea";
const TIMER = "kmj-codebridge-auto-release.timer";
const PROFILE = "kmjsigner";
const MAX_FILE = 100000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assessEliteIdentity(host, uid, user, major) {
  if (
    typeof host !== "string" ||
    host.toLowerCase().split(".")[0] !== "kmj-elite"
  )
    return "HOST_NOT_ELITE";
  if (!Number.isInteger(uid) || uid === 0 || user !== PROFILE)
    return "DEDICATED_NONROOT_SIGNER_REQUIRED";
  if (String(major) !== "24") return "PINNED_NODE24_REQUIRED";
  return "PASS";
}

export function assessDeployTimer(info) {
  if (
    info?.LoadState !== "loaded" ||
    info?.ActiveState !== "active" ||
    info?.UnitFileState !== "enabled"
  )
    return "ELITE_SIGNED_DEPLOY_TIMER_NOT_ACTIVE";
  return "PASS";
}

function safeDirectory(name) {
  const st = fs.lstatSync(name);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== 0 ||
    st.mode & 0o022
  )
    throw new Error("ROOT_OWNED_SOURCE_DIRECTORY_REQUIRED");
}

function guardedFile(name, expected, maximum = MAX_FILE) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      before.nlink !== 1 ||
      before.mode & 0o022 ||
      before.size <= 0 ||
      before.size > maximum
    )
      throw new Error("INSTALLED_SIGNER_IDENTITY_INVALID");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (n < 1) throw new Error("INSTALLED_SIGNER_SHORT_READ");
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      digest(buffer) !== expected
    )
      throw new Error("INSTALLED_SIGNER_PIN_MISMATCH");
  } finally {
    fs.closeSync(fd);
  }
}

function parseSystemd(raw) {
  const found = {};
  for (const line of raw.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) throw new Error("SIGNED_DEPLOY_TIMER_METADATA_INVALID");
    const key = line.slice(0, at);
    if (
      !["LoadState", "ActiveState", "UnitFileState"].includes(key) ||
      Object.hasOwn(found, key)
    )
      throw new Error("SIGNED_DEPLOY_TIMER_METADATA_INVALID");
    found[key] = line.slice(at + 1);
  }
  if (Object.keys(found).length !== 3)
    throw new Error("SIGNED_DEPLOY_TIMER_METADATA_INVALID");
  return found;
}

function fixedTimerStatus() {
  const proc = spawnSync(
    "/usr/bin/systemctl",
    [
      "show",
      "--no-pager",
      "--property=LoadState,ActiveState,UnitFileState",
      TIMER,
    ],
    {
      cwd: "/",
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  );
  if (proc.status !== 0 || proc.error)
    throw new Error("SIGNED_DEPLOY_TIMER_STATUS_UNAVAILABLE");
  return parseSystemd(proc.stdout);
}

function protectedSignerFile(file) {
  const st = fs.lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    st.nlink !== 1 ||
    st.mode & 0o077 ||
    st.size < 1 ||
    st.size > 8192
  )
    throw new Error("SIGNER_KEY_FILE_NOT_PROTECTED");
}

function ownerPolicy() {
  const home = os.homedir();
  if (!path.isAbsolute(home) || home === "/" || home === "/root")
    throw new Error("SIGNER_HOME_UNSAFE");
  const target = path.join(
    home,
    ".config/kmj-codebridge/auto-sign-policy.json",
  );
  const stat = fs.lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    stat.size < 20 ||
    stat.size > 8192
  )
    throw new Error("OWNER_POLICY_UNTRUSTED");
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

export function parseReleaseArgs(args) {
  if (args.length === 1 && args[0] === "--inspect")
    return { mode: args[0], sha: null };
  if (
    args.length !== 2 ||
    !["--preflight", "--sign-once"].includes(args[0]) ||
    typeof args[1] !== "string" ||
    args[1].length !== 40 ||
    !/^[a-f0-9]{40}$/.test(args[1])
  )
    throw new Error("ARGUMENT_NOT_ALLOWED");
  return { mode: args[0], sha: args[1] };
}

const SAFE_BLOCKERS = new Set([
  "APPROVED_SOURCE_MOVED",
  "OWNER_AUTOSIGN_POLICY_NOT_APPROVED",
  "AUTOSIGN_SINGLE_FLIGHT_OR_STALE_LOCK",
  "PROTECTED_MAIN_REVIEWS_MISSING",
  "GITHUB_REPOSITORY_AUTO_MERGE_DISABLED",
  "EXACT_HEAD_CI_NOT_GREEN",
  "OWNER_PUBLIC_KEY_NOT_PINNED",
  "SIGNED_HISTORY_SIGNATURE_INVALID",
  "SOURCE_HISTORY_NOT_DESCENDANT",
  "SEQUENCE_POLICY_EXHAUSTED",
  "RELEASE_BRANCH_ALREADY_EXISTS",
  "AUTOSIGN_PREKEY_RACE",
  "OWNER_POLICY_CHANGED_BEFORE_KEY",
  "PINNED_COMMAND_FAILED",
]);

export function signerFailureCode(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const prefix = "AUTO_SIGNED_RELEASE=BLOCKED:";
  const failures = lines.filter((line) => line.startsWith(prefix));
  if (failures.length === 1) {
    const code = failures[0].slice(prefix.length);
    if (SAFE_BLOCKERS.has(code)) return code;
  }
  return "OWNER_SIGNING_FAILED_REVIEW_REQUIRED";
}

async function main(args) {
  const { mode, sha } = parseReleaseArgs(args);
  const verdict = assessEliteIdentity(
    os.hostname(),
    process.getuid?.(),
    os.userInfo().username,
    process.versions.node.split(".")[0],
  );
  if (verdict !== "PASS") throw new Error(verdict);
  const myself = path.resolve(fileURLToPath(import.meta.url));
  if (myself !== path.join(ROOT, "production/elite-onehost-release-v2.mjs"))
    throw new Error("UNINSTALLED_OPERATOR_REJECTED");
  for (const dir of [
    "/usr",
    "/usr/local",
    "/usr/local/libexec",
    ROOT,
    path.join(ROOT, "production"),
  ])
    safeDirectory(dir);
  guardedFile(SIGNER, SIGNER_PIN);
  guardedFile(GATE, GATE_PIN);
  const timer = assessDeployTimer(fixedTimerStatus());
  if (timer !== "PASS") throw new Error(timer);
  const owner = ownerPolicy();
  // Import ONLY the root-owned already SHA-verified signer. No checkout code is executed.
  const signer = await import(pathToFileURL(SIGNER).href);
  if (signer.assessOwnerAutoPolicy(owner, Date.now()) !== "PASS")
    throw new Error("OWNER_POLICY_NOT_APPROVED");
  if (owner.repoPath === ROOT || owner.repoPath.startsWith(ROOT + "/"))
    throw new Error("SOURCE_REPO_INSIDE_TRUST_ROOT");
  // Metadata only; the pinned signer checks Ed25519 SPKI during signing.
  // Missing keys/loose ACLs must never be reported as ready.
  protectedSignerFile(owner.keyFile);
  protectedSignerFile(owner.publicKeyFile);
  if (!fs.existsSync("/usr/bin/gh") || !fs.existsSync("/usr/bin/git"))
    throw new Error("GH_OR_GIT_NOT_INSTALLED");
  if (mode === "--inspect") {
    console.log("ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN");
    console.log("SIGNED_DEPLOY_TIMER=ACTIVE");
    console.log("PRIVATE_KEY_READ=NO");
    console.log("PRODUCTION_MUTATION=NONE");
    return;
  }
  // Release signer itself enforces exact-source CI, pinned Ed25519 key identity,
  // independent GitHub review + protection, immutable PR, and sticky failure lock.
  const child = spawnSync(
    process.execPath,
    [SIGNER, mode === "--preflight" ? "--preflight" : "--once", sha],
    {
      cwd: "/",
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16384,
      env: {
        HOME: os.homedir(),
        USER: PROFILE,
        LOGNAME: PROFILE,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (child.error || child.status !== 0)
    throw new Error(signerFailureCode(child.stdout));
  const lines = child.stdout.split(/\r?\n/);
  if (lines.includes("AUTO_SIGNED_RELEASE=ALREADY_CURRENT")) {
    console.log("ELITE_OWNER_SIGN=ALREADY_CURRENT");
    return;
  }
  if (
    !lines.includes("AUTO_SIGNED_SHA=" + sha) ||
    lines.filter((line) => line.startsWith("AUTO_SIGNED_SHA=")).length !== 1
  )
    throw new Error("OWNER_SIGNER_RECEIPT_UNVERIFIED");
  const sequences = lines.filter((line) =>
    /^AUTO_SIGNED_SEQUENCE=[0-9]{2,6}$/.test(line),
  );
  if (sequences.length !== 1)
    throw new Error("OWNER_SIGNER_RECEIPT_UNVERIFIED");
  if (mode === "--preflight") {
    if (!lines.includes("AUTO_SIGNED_PREFLIGHT=READY"))
      throw new Error("OWNER_SIGNER_RECEIPT_UNVERIFIED");
    console.log("ELITE_OWNER_PREFLIGHT=READY");
    console.log(sequences[0]);
    console.log("AUTO_SIGNED_SHA=" + sha);
    console.log("PRIVATE_KEY_READ=NO");
    return;
  }
  // A signer success is only PR creation/queueing, never immediate deployment.
  const prs = lines.filter((line) =>
    /^AUTO_SIGNED_PR=https:\/\/github\.com\/kmjtechno\/kmj-codebridge\/pull\/\d+$/.test(
      line,
    ),
  );
  if (
    !lines.includes("AUTO_SIGNED_RELEASE=PR_AUTO_MERGE_QUEUED") ||
    prs.length !== 1
  )
    throw new Error("OWNER_SIGNER_RECEIPT_UNVERIFIED");
  console.log("ELITE_OWNER_SIGN=REVIEW_GATED");
  console.log(sequences[0]);
  console.log("AUTO_SIGNED_SHA=" + sha);
  console.log(prs[0]);
  console.log("ELITE_DEPLOY=SIGNED_TIMER_MANAGED_NOT_ATTESTED");
  console.log("PRIVATE_KEY_EXPORTED=NO");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    const text = String(error?.message ?? "");
    const code = /^[A-Z0-9_]{3,70}$/.test(text) ? text : "REVIEW_REQUIRED";
    console.log("ELITE_ONEHOST=BLOCKED:" + code);
    process.exitCode = 2;
  });
}
