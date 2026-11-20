#!/usr/bin/env node
// KMJ TECHNO: owner-host-only, opt-in signed release PR creation.
// Run an independently reviewed, ACL-protected copy OUTSIDE source checkout.
// Never runs source scripts/dependencies, never sends key material to GitHub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assessReleaseChecks } from "../release-ci-gate.mjs";

const REPO = "kmjtechno/kmj-codebridge";
const KID = "kmj-release-2026";
const PIN = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";
const ORIGIN = "https://kmjtechno.com/codebridge/releases/stable";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const HOME = os.homedir();
const POLICY = path.join(
  HOME,
  ".config",
  "kmj-codebridge",
  "auto-sign-policy.json",
);
const STATE = path.join(HOME, ".local", "state", "kmj-codebridge", "auto-sign");
const LOCK = path.join(STATE, "single-flight.lock");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
let hooksDir = null;
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
const GH = process.platform === "win32" ? "gh.exe" : "/usr/bin/gh";
class Blocked extends Error {}
const requireGate = (ok, code) => {
  if (!ok) throw new Blocked(code);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s) &&
  Number.isFinite(Date.parse(s));

export function withinSourceTree(repo, candidate, platform = process.platform) {
  const win = platform === "win32";
  const normalize = (v) =>
    win ? path.win32.normalize(v).toLowerCase() : path.posix.normalize(v);
  const root = normalize(repo);
  const file = normalize(candidate);
  const separator = win ? "\\" : "/";
  return (
    file === root ||
    file.startsWith(root.endsWith(separator) ? root : root + separator)
  );
}

export function assessOwnerAutoPolicy(p, now = Date.now()) {
  const fields = [
    "approvedAt",
    "enabled",
    "expiresAt",
    "keyFile",
    "keyId",
    "maxSequence",
    "ownerConsent",
    "profile",
    "publicKeyFile",
    "repo",
    "repoPath",
    "schema",
  ];
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join("|") !== fields.sort().join("|") ||
    p.schema !== 1 ||
    p.enabled !== true ||
    p.repo !== REPO ||
    p.profile !== "owner-host-auto-sign-stable-only" ||
    p.ownerConsent !== "AUTO_SIGN_REVIEWED_MAIN_ONLY" ||
    p.keyId !== KID ||
    !Number.isSafeInteger(p.maxSequence) ||
    p.maxSequence < 30 ||
    p.maxSequence > 100000 ||
    !iso(p.approvedAt) ||
    !iso(p.expiresAt) ||
    !Number.isFinite(now) ||
    now < Date.parse(p.approvedAt) ||
    now >= Date.parse(p.expiresAt) ||
    Date.parse(p.expiresAt) - Date.parse(p.approvedAt) > 30 * 86400000 ||
    ![p.repoPath, p.keyFile, p.publicKeyFile].every(
      (v) => typeof v === "string" && v.length < 1024 && path.isAbsolute(v),
    )
  )
    return "OWNER_AUTOSIGN_POLICY_NOT_APPROVED";
  const repo = path.resolve(p.repoPath);
  const key = path.resolve(p.keyFile);
  const pub = path.resolve(p.publicKeyFile);
  if (
    withinSourceTree(repo, key) ||
    withinSourceTree(repo, pub) ||
    (process.platform === "win32"
      ? key.toLowerCase() === pub.toLowerCase()
      : key === pub)
  )
    return "SIGNING_KEY_LOCATION_UNSAFE";
  return "PASS";
}

export function protectedMain(p) {
  return (
    p?.required_pull_request_reviews?.required_approving_review_count >= 1 &&
    p?.enforce_admins?.enabled === true &&
    p?.required_status_checks?.strict === true
  );
}

export function sourceChanged(names) {
  return (
    Array.isArray(names) &&
    names.length > 0 &&
    names.length <= 10000 &&
    names.every(
      (n) =>
        typeof n === "string" &&
        n.length > 0 &&
        n.length <= 512 &&
        !n.includes("\0"),
    ) &&
    names.some((n) => !n.startsWith("releases/stable/"))
  );
}

export function makeSignedRelease({
  revision,
  version,
  sequence,
  archive,
  publicKey,
  privateKey,
  publishedAt,
  expectedSpki = PIN,
}) {
  requireGate(
    SHA.test(revision) &&
      SEMVER.test(version) &&
      Number.isSafeInteger(sequence) &&
      sequence >= 30,
    "SOURCE_IDENTITY_INVALID",
  );
  requireGate(
    Buffer.isBuffer(archive) &&
      archive.length >= 1024 &&
      archive.length <= 300000000 &&
      iso(publishedAt),
    "ARCHIVE_OR_CLOCK_INVALID",
  );
  const pub = createPublicKey(publicKey);
  const priv = createPrivateKey(privateKey);
  requireGate(
    pub.asymmetricKeyType === "ed25519" &&
      priv.asymmetricKeyType === "ed25519" &&
      sha256(pub.export({ format: "der", type: "spki" })) === expectedSpki &&
      sha256(createPublicKey(priv).export({ format: "der", type: "spki" })) ===
        expectedSpki,
    "OWNER_KEY_IDENTITY_INVALID",
  );
  const archiveName =
    "kmj-codebridge-" + version + "-" + revision.slice(0, 12) + ".tar.gz";
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence,
    version,
    revision,
    archive: ORIGIN + "/" + revision + "/" + archiveName,
    sha256: sha256(archive),
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt,
    keyId: KID,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const signature = sign(null, manifestBytes, priv);
  requireGate(
    signature.length === 64 && verify(null, manifestBytes, pub, signature),
    "SIGNED_RELEASE_SELFTEST_FAILED",
  );
  return {
    manifest,
    manifestBytes,
    signatureBytes: Buffer.from(signature.toString("base64url") + "\n"),
  };
}

// The Windows gh CLI uses APPDATA for its standard credential/config path.
// A restricted child environment must preserve that *specific* OS path while
// never passing arbitrary parent variables into Git or GitHub commands.
export function ownerCommandEnv(
  parent = process.env,
  platform = process.platform,
  home = HOME,
) {
  const env = {
    PATH: platform === "win32" ? parent.PATH : "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: parent.USERPROFILE,
    GH_TOKEN: parent.GH_TOKEN,
    GITHUB_TOKEN: parent.GITHUB_TOKEN,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (platform === "win32") {
    for (const key of [
      "APPDATA",
      "LOCALAPPDATA",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "GH_CONFIG_DIR",
    ]) {
      if (typeof parent[key] === "string" && parent[key].length > 0)
        env[key] = parent[key];
    }
  }
  return env;
}

const fixedCommand = (bin, args, { cwd, maxBuffer = 1048576 } = {}) => {
  requireGate(
    args.every((a) => typeof a === "string" && !a.includes("\0")),
    "COMMAND_ARGUMENT_INVALID",
  );
  try {
    return execFileSync(bin, args, {
      cwd,
      maxBuffer,
      timeout: 60000,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ownerCommandEnv(),
    }).trim();
  } catch {
    throw new Blocked("PINNED_COMMAND_FAILED");
  }
};
// Git for Windows can resolve /dev/null as a literal repository path.
// Use a fresh *empty* directory under the protected installed signer instead.
// No candidate hook, post-checkout script or source-controlled hook is run.
export function makeIsolatedHooksDir(parent) {
  const original = fs.lstatSync(parent);
  requireGate(
    original.isDirectory() && !original.isSymbolicLink(),
    "GIT_HOOK_PARENT_UNSAFE",
  );
  const dir = fs.mkdtempSync(path.join(parent, ".kmj-empty-hooks-"));
  const st = fs.lstatSync(dir);
  requireGate(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      fs.readdirSync(dir).length === 0,
    "GIT_HOOK_DIRECTORY_UNSAFE",
  );
  return dir;
}

const git = (root, args) => {
  requireGate(
    typeof hooksDir === "string" && hooksDir.length > 0,
    "GIT_HOOK_ISOLATION_NOT_READY",
  );
  return fixedCommand(GIT, [
    "-c",
    "core.hooksPath=" + hooksDir,
    "-C",
    root,
    ...args,
  ]);
};
const gh = (args) => fixedCommand(GH, args);
const api = (resource) => {
  try {
    return JSON.parse(gh(["api", "repos/" + REPO + "/" + resource]));
  } catch {
    throw new Blocked("GH_API_RESPONSE_UNVERIFIED");
  }
};

function privateFile(file, maxBytes = 65536) {
  const stat = fs.lstatSync(file);
  requireGate(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size > 0 &&
      stat.size <= maxBytes,
    "OWNER_FILE_UNTRUSTED",
  );
  if (process.platform !== "win32") {
    requireGate(
      stat.uid === process.getuid() && !(stat.mode & 0o077),
      "OWNER_FILE_PERMISSIONS_UNSAFE",
    );
  } else {
    // The PowerShell program is constant; path is supplied via environment,
    // never string-concatenated into a shell expression.
    const script =
      "$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath $env:KMJ_AUTOSIGN_FILE;if(-not $a.AreAccessRulesProtected){exit 2};$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$ok=@($me,'S-1-5-18','S-1-5-32-544');foreach($r in @($a.Access)){$sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin $ok -or [string]$r.AccessControlType -cne 'Allow'){exit 2}};exit 0";
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, KMJ_AUTOSIGN_FILE: file },
        timeout: 15000,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    requireGate(res.status === 0, "OWNER_WINDOWS_ACL_UNVERIFIED");
  }
  return fs.readFileSync(file);
}

function history(root, pub) {
  const names = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "refs/remotes/origin/main",
    "--",
    "releases/stable/",
  ]).split("\n");
  const manifestPaths = names.filter((n) =>
    /^releases\/stable\/[a-f0-9]{40}\/release-manifest\.json$/.test(n),
  );
  requireGate(
    manifestPaths.length > 0 && manifestPaths.length <= 256,
    "SIGNED_HISTORY_UNBOUNDED",
  );
  const publicKey = createPublicKey(pub);
  const sequences = new Set();
  let latest = null;
  for (const pathname of manifestPaths) {
    const content = git(root, ["show", "refs/remotes/origin/main:" + pathname]);
    const signatureText = git(root, [
      "show",
      "refs/remotes/origin/main:" + pathname.replace(/\.json$/, ".sig"),
    ]);
    requireGate(
      Buffer.byteLength(content) < 65536 &&
        /^[A-Za-z0-9_-]{86}$/.test(signatureText),
      "SIGNED_HISTORY_INVALID",
    );
    const signature = Buffer.from(signatureText, "base64url");
    requireGate(
      signature.length === 64 &&
        verify(null, Buffer.from(content + "\n"), publicKey, signature),
      "SIGNED_HISTORY_SIGNATURE_INVALID",
    );
    let entry;
    try {
      entry = JSON.parse(content);
    } catch {
      throw new Blocked("SIGNED_HISTORY_JSON_INVALID");
    }
    const rev = pathname.split("/")[2];
    requireGate(
      entry.schema === 1 &&
        entry.product === "KMJ CodeBridge" &&
        entry.channel === "stable" &&
        entry.keyId === KID &&
        entry.revision === rev &&
        SHA.test(rev) &&
        Number.isSafeInteger(entry.sequence) &&
        entry.sequence > 0 &&
        HASH.test(entry.sha256) &&
        SEMVER.test(entry.version) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        entry.nodeMajor === 24 &&
        !sequences.has(entry.sequence) &&
        entry.archive ===
          ORIGIN +
            "/" +
            rev +
            "/kmj-codebridge-" +
            entry.version +
            "-" +
            rev.slice(0, 12) +
            ".tar.gz",
      "SIGNED_HISTORY_IDENTITY_INVALID",
    );
    sequences.add(entry.sequence);
    if (!latest || latest.sequence < entry.sequence) latest = entry;
  }
  return latest;
}

function lockOnce() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(STATE);
  requireGate(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "SIGNER_STATE_DIR_UNSAFE",
  );
  if (process.platform !== "win32") {
    requireGate(
      stat.uid === process.getuid() && !(stat.mode & 0o077),
      "SIGNER_STATE_PERMISSIONS_UNSAFE",
    );
  }
  try {
    const fd = fs.openSync(LOCK, "wx", 0o600);
    fs.writeSync(fd, "" + process.pid);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    throw new Blocked("AUTOSIGN_SINGLE_FLIGHT_OR_STALE_LOCK");
  }
}

function runOnce() {
  let locked = false;
  let signingStarted = false;
  let tmp = null;
  let worktree = null;
  let root = null;
  try {
    // Prevent privileged/root CodeBridge or gateway processes from wielding
    // an owner signing key. A dedicated non-root signer is required on Linux.
    if (process.platform !== "win32") {
      requireGate(typeof process.getuid === "function" && process.getuid() !== 0,
        "ROOT_SIGNER_FORBIDDEN");
    }
    const p = JSON.parse(privateFile(POLICY).toString("utf8"));
    requireGate(
      assessOwnerAutoPolicy(p) === "PASS",
      "OWNER_AUTOSIGN_POLICY_NOT_APPROVED",
    );
    root = fs.realpathSync(p.repoPath);
    requireGate(fs.lstatSync(root).isDirectory(), "SIGNER_REPO_INVALID");
    requireGate(
      !withinSourceTree(root, fs.realpathSync(p.keyFile)) &&
        !withinSourceTree(root, fs.realpathSync(p.publicKeyFile)),
      "SIGNER_KEY_INSIDE_SOURCE",
    );
    lockOnce();
    locked = true;
    // On Elite the reviewed signer files are root-owned and read-only.
    // Create empty Git hook sandboxes only in the dedicated signer's 0700
    // private state directory, never beside trusted installed code.
    hooksDir = makeIsolatedHooksDir(STATE);
    gh(["auth", "status"]);
    requireGate(
      protectedMain(api("branches/main/protection")),
      "PROTECTED_MAIN_REVIEWS_MISSING",
    );
    let repoSettings;
    try {
      repoSettings = JSON.parse(
        gh(["api", "--hostname", "github.com", "repos/" + REPO]),
      );
    } catch {
      throw new Blocked("AUTO_MERGE_REPOSITORY_SETTINGS_UNVERIFIED");
    }
    requireGate(
      repoSettings.allow_auto_merge === true &&
        repoSettings.allow_squash_merge === true,
      "GITHUB_REPOSITORY_AUTO_MERGE_DISABLED",
    );
    const origin = git(root, ["remote", "get-url", "origin"]);
    requireGate(
      [
        "https://github.com/" + REPO,
        "https://github.com/" + REPO + ".git",
        "git@github.com:" + REPO + ".git",
      ].includes(origin),
      "SOURCE_ORIGIN_NOT_TRUSTED",
    );
    git(root, ["fetch", "--no-tags", "origin", "main"]);
    const source = git(root, ["rev-parse", "refs/remotes/origin/main"]);
    requireGate(
      SHA.test(source) && api("git/ref/heads/main")?.object?.sha === source,
      "REMOTE_MAIN_NOT_PINNED",
    );
    const checks = api("commits/" + source + "/check-runs?per_page=100");
    requireGate(
      assessReleaseChecks(checks, source).ready,
      "EXACT_HEAD_CI_NOT_GREEN",
    );
    const pubBytes = privateFile(p.publicKeyFile, 8192);
    const pub = createPublicKey(pubBytes);
    requireGate(
      pub.asymmetricKeyType === "ed25519" &&
        sha256(pub.export({ format: "der", type: "spki" })) === PIN,
      "OWNER_PUBLIC_KEY_NOT_PINNED",
    );
    const latest = history(root, pubBytes);
    requireGate(latest.sequence >= 29, "SIGNED_HISTORY_SEQUENCE_INVALID");
    const ancestor = spawnSync(
      GIT,
      ["-C", root, "merge-base", "--is-ancestor", latest.revision, source],
      { windowsHide: true, timeout: 15000 },
    );
    requireGate(ancestor.status === 0, "SOURCE_HISTORY_NOT_DESCENDANT");
    const changes = git(root, [
      "diff",
      "--name-only",
      latest.revision + ".." + source,
      "--",
    ]);
    if (!sourceChanged(changes ? changes.split("\n") : [])) {
      console.log("AUTO_SIGNED_RELEASE=ALREADY_CURRENT");
      return;
    }
    const seq = latest.sequence + 1;
    requireGate(seq <= p.maxSequence, "SEQUENCE_POLICY_EXHAUSTED");
    const branch = "release/stable-seq" + seq;
    requireGate(
      git(root, ["ls-remote", "--heads", "origin", "refs/heads/" + branch]) ===
        "",
      "RELEASE_BRANCH_ALREADY_EXISTS",
    );
    let version;
    try {
      version = JSON.parse(
        git(root, ["show", source + ":package.json"]),
      ).version;
    } catch {
      throw new Blocked("SOURCE_PACKAGE_INVALID");
    }
    requireGate(SEMVER.test(version), "SOURCE_VERSION_INVALID");
    const stem = "kmj-codebridge-" + version + "-" + source.slice(0, 12);
    const archive = execFileSync(
      GIT,
      [
        "-C",
        root,
        "archive",
        "--format=tar.gz",
        "--prefix=" + stem + "/",
        source,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 300000001,
        timeout: 60000,
        windowsHide: true,
      },
    );
    requireGate(
      api("git/ref/heads/main")?.object?.sha === source &&
        git(root, [
          "ls-remote",
          "--heads",
          "origin",
          "refs/heads/" + branch,
        ]) === "",
      "AUTOSIGN_PREKEY_RACE",
    );
    const key = privateFile(p.keyFile, 8192);
    signingStarted = true;
    const signed = makeSignedRelease({
      revision: source,
      version,
      sequence: seq,
      archive,
      publicKey: pubBytes,
      privateKey: key,
      publishedAt: new Date().toISOString(),
    });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-autosign-"));
    worktree = path.join(tmp, "candidate");
    git(root, ["worktree", "add", "--detach", worktree, source]);
    git(worktree, ["switch", "-c", branch]);
    const out = path.join(worktree, "releases", "stable", source);
    requireGate(!fs.existsSync(out), "SIGNED_SOURCE_ALREADY_EXISTS");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "release-manifest.json"),
      signed.manifestBytes,
      { flag: "wx", mode: 0o644 },
    );
    fs.writeFileSync(
      path.join(out, "release-manifest.sig"),
      signed.signatureBytes,
      { flag: "wx", mode: 0o644 },
    );
    git(worktree, ["add", "--", "releases/stable/" + source]);
    git(worktree, [
      "commit",
      "-m",
      "release: owner-signed stable sequence " +
        seq +
        " (" +
        source.slice(0, 12) +
        ")",
    ]);
    git(worktree, ["push", "origin", "HEAD:refs/heads/" + branch]);
    const url = gh([
      "pr",
      "create",
      "--repo",
      REPO,
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      "release: owner-signed stable sequence " + seq,
      "--body",
      "Owner-host automatically signed " +
        source +
        " after protected-main review and exact CI. Private signing key stayed on owner host. " +
        "Independent release PR review and live canary/rollback still required.",
    ]);
    requireGate(
      /^https:\/\/github\.com\/kmjtechno\/kmj-codebridge\/pull\/\d+$/.test(url),
      "PR_RECEIPT_NOT_VERIFIED",
    );
    // Ask GitHub to merge only AFTER its own protected-main required
    // independent review and CI. Never use --admin or an instant merge.
    requireGate(
      protectedMain(api("branches/main/protection")),
      "PROTECTED_MAIN_REVIEWS_MISSING",
    );
    gh(["pr", "merge", url, "--repo", REPO, "--auto", "--squash"]);
    console.log("AUTO_SIGNED_RELEASE=PR_AUTO_MERGE_QUEUED");
    console.log("AUTO_SIGNED_SEQUENCE=" + seq);
    console.log("AUTO_SIGNED_SHA=" + source);
    console.log("AUTO_SIGNED_PR=" + url);
  } catch (error) {
    const code =
      error instanceof Blocked ? error.message : "OWNER_SIGNER_REVIEW_REQUIRED";
    console.log("AUTO_SIGNED_RELEASE=BLOCKED:" + code);
    process.exitCode = 2;
  } finally {
    if (worktree && root) {
      try {
        git(root, ["worktree", "remove", "--force", worktree]);
      } catch {
        console.log("AUTOSIGN_WORKTREE_REVIEW_REQUIRED");
        process.exitCode = 2;
      }
    }
    if (tmp) {
      try {
        fs.rmdirSync(tmp);
      } catch {
        process.exitCode = 2;
      }
    }
    if (hooksDir) {
      try {
        fs.rmdirSync(hooksDir);
      } catch {
        process.exitCode = 2;
      }
      hooksDir = null;
    }
    // Any failure after key use leaves a sticky lock until owner reconciles.
    if (locked && (!signingStarted || process.exitCode !== 2)) {
      try {
        fs.unlinkSync(LOCK);
      } catch {
        process.exitCode = 2;
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.log("AUTO_SIGNED_RELEASE=BLOCKED:OWNER_HOST_ONCE_ONLY");
    process.exitCode = 2;
  } else runOnce();
}
