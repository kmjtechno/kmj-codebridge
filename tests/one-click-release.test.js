import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync, verify } from "node:crypto";
import path from "node:path";
import { verifyStableRelease } from "../scripts/verify-stable-release.mjs";

const linux = process.platform === "linux";
const SEQ29 = "e8c353dc839a01a8418e01e7b9209d46bcedc779";
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", ...opts });
const git = (cwd, ...args) =>
  run(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd },
  );
const haveSeq29 = git(".", "cat-file", "-e", `${SEQ29}^{commit}`).status === 0;

test(
  "generic checker derives the exact seq29 values that were hand-pinned before",
  { skip: !haveSeq29 },
  () => {
    const r = verifyStableRelease({ repo: path.resolve("."), revision: SEQ29 });
    assert.equal(r.sequence, 29);
    assert.equal(r.tag, "codebridge-stable-seq29-e8c353dc");
    assert.equal(
      r.manifestSha256,
      "0c0b738fb59fd156bcd43813653e83520abff267f8369ed90251a3367dfa2752",
    );
    assert.equal(
      r.archiveSha256,
      "e1c7262504dc5a21cd89aab26506055238d25f3ccace40c32b5a0a19d4eac35b",
    );
    assert.equal(r.archiveBytes, 2283307);
  },
);

test("checker blocks an older sequence and a bad revision", () => {
  const cli = (rev) =>
    run("node", ["scripts/verify-stable-release.mjs", rev]).stdout;
  assert.match(
    cli("f2a18a1feb0aa9df8b888ae363e4cc96b769c83b"),
    /RELEASE_CHECK=BLOCKED:SEQUENCE_NOT_NEWEST/,
  );
  assert.match(cli("main"), /RELEASE_CHECK=BLOCKED:REVISION_NOT_FULL_SHA/);
});

test("release.sh is valid bash and never deploys", { skip: !linux }, () => {
  assert.equal(run("bash", ["-n", "scripts/release.sh"]).status, 0);
  const text = readFileSync("scripts/release.sh", "utf8");
  assert.doesNotMatch(text, /\b(systemctl|sudo|ssh|scp|rsync|curl|wget)\b/);
  assert.doesNotMatch(text, /^\s*(source|\.)\s/m, "config must not be sourced");
});

function releaseFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "kmj-oneclick-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  // Origin "main" = the current checkout's HEAD plus the working-tree release
  // tooling, so the test exercises the files under review.
  assert.equal(run("git", ["clone", "-q", path.resolve("."), repo]).status, 0);
  for (const f of [
    "scripts/release.sh",
    "scripts/verify-stable-release.mjs",
    "package.json",
  ])
    writeFileSync(path.join(repo, f), readFileSync(f));
  git(repo, "checkout", "-q", "-B", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fixture source");
  // A bare clone works from a shallow source too (a push would not).
  assert.equal(run("git", ["clone", "-q", "--bare", repo, origin]).status, 0);
  // CI on a push to release/stable-seqN checks that branch out, so the clone
  // above would copy it into the fixture origin. Only main belongs there.
  const heads = git(
    origin,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/release/",
  );
  for (const ref of heads.stdout.split("\n").filter(Boolean))
    assert.equal(git(origin, "update-ref", "-d", ref).status, 0);
  git(repo, "remote", "set-url", "origin", origin);
  assert.equal(git(repo, "fetch", "-q", "origin").status, 0);
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".config", "kmj-codebridge"), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = path.join(root, "release.key");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  writeFileSync(
    path.join(home, ".config", "kmj-codebridge", "release.env"),
    `CODEBRIDGE_RELEASE_KEY_FILE=${keyFile}\nCODEBRIDGE_RELEASE_KID=kmj-release-2026\n`,
  );
  // npm ci inside the temporary checkout uses the existing local cache only.
  const npmrc = path.join(root, "npmrc");
  writeFileSync(npmrc, "offline=true\n");
  return { root, repo, origin, home, publicKey, npmrc };
}

function oneClick(f, extra = {}) {
  return run("bash", [path.join(f.repo, "scripts/release.sh"), "--yes"], {
    cwd: f.repo,
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      TMPDIR: f.root,
      GH_CONFIG_DIR: path.join(f.root, "no-gh"),
      NPM_CONFIG_USERCONFIG: f.npmrc,
      npm_config_cache:
        process.env.npm_config_cache ??
        path.join(process.env.HOME ?? "", ".npm"),
      GIT_AUTHOR_NAME: "owner",
      GIT_AUTHOR_EMAIL: "owner@example.invalid",
      GIT_COMMITTER_NAME: "owner",
      GIT_COMMITTER_EMAIL: "owner@example.invalid",
      ...extra,
    },
  });
}

test(
  "one command signs the next sequence and pushes a verifiable release branch",
  { skip: !linux || !haveSeq29 || !existsSync("node_modules/zod") },
  (t) => {
    const f = releaseFixture(t);
    const source = git(f.repo, "rev-parse", "HEAD").stdout.trim();
    const r = oneClick(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /KMJ_RELEASE=PR_READY/);
    assert.match(r.stdout, /SEQUENCE=30/);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/);

    // The pushed branch holds exactly the two public files for that commit.
    const check = path.join(f.root, "check");
    assert.equal(
      run("git", ["clone", "-q", "-b", "release/stable-seq30", f.origin, check])
        .status,
      0,
    );
    const changed = git(check, "diff", "--name-only", "origin/main", "HEAD")
      .stdout.trim()
      .split("\n");
    assert.deepEqual(changed.sort(), [
      `releases/stable/${source}/release-manifest.json`,
      `releases/stable/${source}/release-manifest.sig`,
    ]);
    const result = verifyStableRelease({ repo: check, revision: source });
    assert.equal(result.sequence, 30);
    assert.equal(result.tag, `codebridge-stable-seq30-${source.slice(0, 8)}`);

    // Signature really is the owner key's Ed25519 signature over the bytes.
    const folder = path.join(check, "releases/stable", source);
    const sig = Buffer.from(
      readFileSync(path.join(folder, "release-manifest.sig"), "ascii").trim(),
      "base64url",
    );
    assert.equal(
      verify(
        null,
        readFileSync(path.join(folder, "release-manifest.json")),
        f.publicKey,
        sig,
      ),
      true,
    );

    // Running again for the same commit is refused (branch already exists).
    const again = oneClick(f);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /KMJ_RELEASE=BLOCKED:BRANCH_EXISTS/);
    // No leftover temporary worktrees.
    assert.equal(
      git(f.repo, "worktree", "list").stdout.trim().split("\n").length,
      1,
    );
  },
);

test(
  "missing key configuration stops before any work",
  { skip: !linux },
  (t) => {
    const f = releaseFixture(t);
    rmSync(path.join(f.home, ".config", "kmj-codebridge", "release.env"));
    const r = oneClick(f);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /KMJ_RELEASE=BLOCKED:KEY_FILE_NOT_CONFIGURED/);
    assert.equal(
      git(f.repo, "ls-remote", "--heads", "origin", "release/*").stdout,
      "",
    );
  },
);
