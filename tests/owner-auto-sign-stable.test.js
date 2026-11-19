import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateKeyPairSync,
  createHash,
  verify,
  createPublicKey,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assessOwnerAutoPolicy,
  withinSourceTree,
  protectedMain,
  sourceChanged,
  makeSignedRelease,
  makeIsolatedHooksDir,
  ownerCommandEnv,
} from "../scripts/production/owner-auto-sign-stable.mjs";

const ROOT = path.join(os.tmpdir(), "kmj-auto-sign-test-repo");
const SECRETS = path.join(os.tmpdir(), "kmj-auto-sign-test-secrets");

const valid = () => ({
  schema: 1,
  enabled: true,
  repo: "kmjtechno/kmj-codebridge",
  profile: "owner-host-auto-sign-stable-only",
  ownerConsent: "AUTO_SIGN_REVIEWED_MAIN_ONLY",
  keyId: "kmj-release-2026",
  approvedAt: "2026-11-18T00:00:00Z",
  expiresAt: "2026-11-30T00:00:00Z",
  maxSequence: 100,
  repoPath: ROOT,
  keyFile: path.join(SECRETS, "key.pem"),
  publicKeyFile: path.join(SECRETS, "key.pub"),
});

test("signer isolates all Git hooks in a fresh empty directory", () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "kmj-git-hook-isolation-"),
  );
  try {
    const first = makeIsolatedHooksDir(base);
    const second = makeIsolatedHooksDir(base);
    assert.notEqual(first, second);
    assert.deepEqual(fs.readdirSync(first), []);
    assert.deepEqual(fs.readdirSync(second), []);
    const source = fs.readFileSync(
      "scripts/production/owner-auto-sign-stable.mjs",
      "utf8",
    );
    assert.doesNotMatch(source, /core\.hooksPath=\/dev\/null/);
    assert.match(source, /"core\.hooksPath=" \+ hooksDir/);
    assert.match(source, /GIT_HOOK_ISOLATION_NOT_READY/);
    assert.match(source, /GIT_HOOK_DIRECTORY_UNSAFE/);
    assert.match(source, /fs\.rmdirSync\(hooksDir\)/);
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

test("Windows owner signer passes only required gh config environment", () => {
  const parent = {
    PATH: "C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\KMJ TECHNO",
    APPDATA: "C:\\Users\\KMJ TECHNO\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\KMJ TECHNO\\AppData\\Local",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    GH_CONFIG_DIR: "C:\\Users\\KMJ TECHNO\\gh-config",
    GH_TOKEN: "test-token-do-not-log",
    NODE_OPTIONS: "--require ./evil.js",
    GIT_CONFIG_GLOBAL: "C:\\attacker.gitconfig",
    HTTP_PROXY: "http://attacker.invalid",
  };
  const win = ownerCommandEnv(parent, "win32", parent.USERPROFILE);
  assert.equal(win.APPDATA, parent.APPDATA);
  assert.equal(win.LOCALAPPDATA, parent.LOCALAPPDATA);
  assert.equal(win.SystemRoot, parent.SystemRoot);
  assert.equal(win.GH_CONFIG_DIR, parent.GH_CONFIG_DIR);
  assert.equal(win.HOME, parent.USERPROFILE);
  assert.equal(win.GH_TOKEN, parent.GH_TOKEN);
  for (const unsafe of ["NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "HTTP_PROXY"])
    assert.equal(Object.hasOwn(win, unsafe), false, unsafe);
  assert.equal(Object.hasOwn(parent, "GH_TOKEN"), true);
  const linux = ownerCommandEnv(parent, "linux", "/home/owner");
  assert.equal(linux.PATH, "/usr/bin:/bin");
  assert.equal(linux.HOME, "/home/owner");
  assert.equal(Object.hasOwn(linux, "APPDATA"), false);
  assert.equal(Object.hasOwn(linux, "GH_CONFIG_DIR"), false);
});

test("owner opt-in is exact, short lived and cannot point into source repository", () => {
  const now = Date.parse("2026-11-18T05:00:00Z");
  assert.equal(assessOwnerAutoPolicy(valid(), now), "PASS");
  for (const patch of [
    { enabled: false },
    { ownerConsent: "YES" },
    { repo: "attacker/other" },
    { profile: "unrestricted" },
    { expiresAt: "2026-12-31T00:00:00Z" },
    { approvedAt: "2026-11-19T00:00:00Z" },
    { maxSequence: 100001 },
    { keyFile: path.join(ROOT, "evil.pem") },
    { publicKeyFile: path.join(ROOT, "evil.pem") },
    { unrelated: true },
  ]) {
    assert.notEqual(
      assessOwnerAutoPolicy({ ...valid(), ...patch }, now),
      "PASS",
    );
  }
  assert.notEqual(
    assessOwnerAutoPolicy(valid(), Date.parse("2026-12-01T00:00:00Z")),
    "PASS",
  );
});

test("Windows private signing key paths cannot alias source tree by case", () => {
  assert.equal(
    withinSourceTree(
      "C:\\KMJ\\CodeBridge",
      "c:\\kmj\\codebridge\\secrets\\owner.pem",
      "win32",
    ),
    true,
  );
  assert.equal(
    withinSourceTree(
      "C:\\KMJ\\CodeBridge",
      "C:\\KMJ\\CodeBridge-archive\\owner.pem",
      "win32",
    ),
    false,
  );
  assert.equal(
    withinSourceTree("/trusted/repo", "/trusted/repo/secrets/key.pem", "linux"),
    true,
  );
  assert.equal(
    withinSourceTree("/trusted/repo", "/trusted/repo-other/key.pem", "linux"),
    false,
  );
});

test("automatic signing requires real branch reviews, strict checks and admin enforcement", () => {
  const good = {
    required_pull_request_reviews: { required_approving_review_count: 1 },
    enforce_admins: { enabled: true },
    required_status_checks: { strict: true },
  };
  assert.equal(protectedMain(good), true);
  assert.equal(protectedMain(null), false);
  for (const drift of [
    { required_pull_request_reviews: { required_approving_review_count: 0 } },
    { enforce_admins: { enabled: false } },
    { required_status_checks: { strict: false } },
  ]) {
    assert.equal(protectedMain({ ...good, ...drift }), false);
  }
});

test("release metadata-only merges do not recursively generate new signed releases", () => {
  assert.equal(
    sourceChanged(["releases/stable/a/release-manifest.json"]),
    false,
  );
  assert.equal(
    sourceChanged(["releases/stable/a/release-manifest.sig"]),
    false,
  );
  assert.equal(sourceChanged(["src/gateway.js"]), true);
  assert.equal(
    sourceChanged(["releases/stable/a/release-manifest.json", "src/agent.js"]),
    true,
  );
  assert.equal(sourceChanged([]), false);
  assert.equal(sourceChanged(["\u0000"]), false);
});

test("owner signer uses fixed Ed25519 key identity, signs bytes and rejects mismatched keys", () => {
  const one = generateKeyPairSync("ed25519");
  const two = generateKeyPairSync("ed25519");
  const pem = one.publicKey.export({ format: "pem", type: "spki" });
  const priv = one.privateKey.export({ format: "pem", type: "pkcs8" });
  const fp = createHash("sha256")
    .update(
      one.publicKey.export({
        format: "der",
        type: "spki",
      }),
    )
    .digest("hex");
  const args = {
    revision: "a".repeat(40),
    version: "0.3.2",
    sequence: 31,
    archive: Buffer.alloc(1100, 17),
    publicKey: pem,
    privateKey: priv,
    publishedAt: "2026-11-18T05:00:00.000Z",
    expectedSpki: fp,
  };
  const signed = makeSignedRelease(args);
  assert.equal(signed.manifest.sequence, 31);
  assert.match(
    signed.manifest.archive,
    /^https:\/\/kmjtechno\.com\/codebridge\/releases\/stable\//,
  );
  const sig = Buffer.from(
    signed.signatureBytes.toString("ascii").trim(),
    "base64url",
  );
  assert.equal(sig.length, 64);
  assert.equal(
    verify(null, signed.manifestBytes, createPublicKey(pem), sig),
    true,
  );
  assert.throws(
    () =>
      makeSignedRelease({
        ...args,
        privateKey: two.privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
      }),
    /OWNER_KEY_IDENTITY_INVALID/,
  );
  assert.throws(
    () => makeSignedRelease({ ...args, expectedSpki: "0".repeat(64) }),
    /OWNER_KEY_IDENTITY_INVALID/,
  );
  assert.throws(
    () => makeSignedRelease({ ...args, sequence: 0 }),
    /SOURCE_IDENTITY_INVALID/,
  );
  assert.throws(
    () => makeSignedRelease({ ...args, archive: Buffer.alloc(9) }),
    /ARCHIVE_OR_CLOCK_INVALID/,
  );
});

test("owner signer CLI never signs on ambiguous or missing arguments", () => {
  const r = spawnSync(
    "node",
    ["scripts/production/owner-auto-sign-stable.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED:OWNER_HOST_ONCE_ONLY/);
});

test("signer never executes source script or exports private keys into GitHub", () => {
  const source = fs.readFileSync(
    "scripts/production/owner-auto-sign-stable.mjs",
    "utf8",
  );
  assert.match(source, /EXACT_HEAD_CI_NOT_GREEN/);
  assert.match(source, /PROTECTED_MAIN_REVIEWS_MISSING/);
  assert.match(source, /GITHUB_REPOSITORY_AUTO_MERGE_DISABLED/);
  assert.match(source, /PR_AUTO_MERGE_QUEUED/);
  assert.match(
    source,
    /"pr", "merge", url, "--repo", REPO, "--auto", "--squash"/,
  );
  // Restrict the actual merge invocation; code comments and worktree
  // cleanup may legitimately mention --admin or --force.
  assert.doesNotMatch(source, /gh\(\[[^\]]*"--admin"/);
  assert.match(source, /AUTOSIGN_PREKEY_RACE/);
  assert.match(source, /SIGNED_HISTORY_SIGNATURE_INVALID/);
  assert.match(source, /sourceChanged/);
  assert.match(source, /AUTOSIGN_SINGLE_FLIGHT_OR_STALE_LOCK/);
  assert.match(source, /owner-host-auto-sign-stable-only/);
  assert.match(source, /GH_TOKEN/);
  assert.doesNotMatch(
    source,
    /npm\s+run|node_modules|owner-sign-stable-20261116\.sh|curl.*\|\s*bash/,
  );
  assert.doesNotMatch(source, /gh\(\[.*(?:privateKey|keyFile|signingKey)/);
  assert.doesNotMatch(
    source,
    /git\s+reset|git\s+clean|--force-with-lease|push\s+--force/,
  );
});
