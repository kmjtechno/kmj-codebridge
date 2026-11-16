import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import path from "node:path";

const script = path.resolve("scripts/production/owner-sign-stable-20261116.sh");
const linux = process.platform === "linux";
const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "kmj-sign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  assert.equal(
    spawnSync("git", ["clone", "-q", path.resolve("."), repo], { encoding: "utf8" }).status,
    0,
  );
  const head = git(path.resolve("."), "rev-parse", "HEAD").stdout.trim();
  assert.equal(git(repo, "checkout", "-q", "--detach", head).status, 0);
  symlinkSync(path.resolve("node_modules"), path.join(repo, "node_modules"));
  appendFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules\n");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(root, "release.key");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { root, repo, head, keyFile, publicKey };
}

function run(f, over = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: f.root,
    CB_REPO: f.repo,
    SOURCE: f.head,
    CODEBRIDGE_RELEASE_KEY_FILE: f.keyFile,
    CODEBRIDGE_RELEASE_KID: "kmj-release-test",
    SEQ: "29",
    CONFIRM_SIGN: `SIGN_STABLE_SEQ_29_${f.head.slice(0, 12)}`,
    OUT: path.join(f.root, "out"),
    ...over,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return spawnSync("bash", [script], { env, encoding: "utf8" });
}

const blocked = (result, code) => {
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`KMJ_OWNER_SIGN=BLOCKED:${code}`));
  assert.doesNotMatch(result.stdout + result.stderr, /BEGIN [A-Z ]*PRIVATE KEY/);
};

test("script is valid bash and never publishes or deploys", { skip: !linux }, () => {
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const text = readFileSync(script, "utf8");
  assert.doesNotMatch(text, /\b(curl|wget|scp|rsync|ssh|systemctl|sudo|gh )\b/);
  assert.match(text, /PUBLISHED=NO\\nDEPLOYED=NO/);
});

test("missing required environment stops before any work", { skip: !linux }, (t) => {
  const f = fixture(t);
  const result = run(f, { SOURCE: undefined });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(f.root, "out")), false);
});

test("input validation blocks bad source, sequence, confirmation and key mode", { skip: !linux }, (t) => {
  const f = fixture(t);
  blocked(run(f, { SOURCE: "main" }), "SOURCE_NOT_FULL_SHA");
  blocked(run(f, { SOURCE: f.head.toUpperCase() }), "SOURCE_NOT_FULL_SHA");
  blocked(run(f, { SEQ: "28", CONFIRM_SIGN: `SIGN_STABLE_SEQ_28_${f.head.slice(0, 12)}` }), "SEQUENCE_MUST_BE_AT_LEAST_29");
  blocked(run(f, { SEQ: "x" }), "SEQUENCE_MUST_BE_AT_LEAST_29");
  blocked(run(f, { CONFIRM_SIGN: "SIGN_STABLE_SEQ_29" }), "CONFIRMATION_MISMATCH");
  blocked(run(f, { CONFIRM_SIGN: `SIGN_STABLE_SEQ_29_${"0".repeat(12)}` }), "CONFIRMATION_MISMATCH");
  blocked(run(f, { CODEBRIDGE_RELEASE_KID: "bad kid" }), "KID_INVALID");
  blocked(run(f, { CODEBRIDGE_RELEASE_KEY_FILE: path.join(f.root, "none") }), "KEY_FILE_MISSING");
  chmodSync(f.keyFile, 0o644);
  blocked(run(f), "KEY_FILE_TOO_OPEN");
  assert.equal(existsSync(path.join(f.root, "out")), false, "nothing is written when blocked");
});

test("repository state is enforced: head, clean tree, already-released source", { skip: !linux }, (t) => {
  const f = fixture(t);
  blocked(run(f, { SOURCE: "1".repeat(40), CONFIRM_SIGN: `SIGN_STABLE_SEQ_29_${"1".repeat(12)}` }), "REPO_HEAD_NOT_SOURCE");
  writeFileSync(path.join(f.repo, "dirty.txt"), "x");
  blocked(run(f), "REPO_NOT_CLEAN");
  rmSync(path.join(f.repo, "dirty.txt"));
  // An empty directory is invisible to git status, so the tree stays clean and
  // the already-released guard is what refuses.
  mkdirSync(path.join(f.repo, "releases", "stable", f.head), { recursive: true });
  assert.equal(git(f.repo, "status", "--porcelain").stdout.trim(), "");
  blocked(run(f), "SOURCE_ALREADY_RELEASED");
});

test("happy path signs the exact commit with the repo signer and publishes nothing", { skip: !linux }, (t) => {
  const f = fixture(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/);
  const out = Object.fromEntries(
    result.stdout.trim().split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  assert.equal(out.KMJ_OWNER_SIGN, "SIGNED");
  assert.equal(out.PUBLISHED, "NO");
  assert.equal(out.DEPLOYED, "NO");
  assert.equal(out.SOURCE, f.head);
  const manifestBytes = readFileSync(path.join(out.PUBLIC_DIR, "release-manifest.json"));
  const sigText = readFileSync(path.join(out.PUBLIC_DIR, "release-manifest.sig"), "utf8").trim();
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.sequence, 29);
  assert.equal(manifest.revision, f.head);
  assert.equal(manifest.keyId, "kmj-release-test");
  assert.equal(manifest.sha256, out.ARCHIVE_SHA256);
  const archive = readFileSync(path.join(out.ARCHIVE_DIR, out.ARCHIVE));
  assert.equal(createHash("sha256").update(archive).digest("hex"), out.ARCHIVE_SHA256);
  assert.equal(archive.length, Number(out.ARCHIVE_BYTES));
  assert.equal(manifest.bytes, archive.length);
  assert.equal(manifest.archive, `https://kmjtechno.com/codebridge/releases/stable/${f.head}/${out.ARCHIVE}`);
  assert.ok(
    verify(null, manifestBytes, f.publicKey,Buffer.from(sigText, "base64url")),
    "signature verifies with the matching public key",
  );
  assert.equal(
    createHash("sha256").update(manifestBytes).digest("hex"),
    out.MANIFEST_SHA256,
  );
  // The public folder holds only the two public files.
  assert.deepEqual(
    spawnSync("ls", [out.PUBLIC_DIR], { encoding: "utf8" }).stdout.trim().split("\n").sort(),
    ["release-manifest.json", "release-manifest.sig"],
  );
  // A second run into an existing output directory is refused.
  blocked(run(f), "OUTPUT_DIR_EXISTS");
});
