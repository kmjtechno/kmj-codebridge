#!/usr/bin/env node
// KMJ TECHNO — generic, read-only check of ONE owner-signed stable release
// folder (releases/stable/<40-hex revision>/). Every expected value is derived
// from the signed manifest plus the exact Git commit, so no per-release
// workflow with copied hashes is needed. It never signs, uploads or deploys.
//
// Usage: node scripts/verify-stable-release.mjs <revision> [--archive-out DIR]
// Prints KEY=VALUE lines. Exit 0 = PASS, 2 = BLOCKED.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGIN = "https://kmjtechno.com/codebridge/releases/stable";
export const KEY_ID = "kmj-release-2026";
const STABLE = "releases/stable";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

class Blocked extends Error {}
const need = (ok, code) => {
  if (!ok) throw new Blocked(code);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(repo, args, encoding = "utf8") {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding,
    maxBuffer: 600_000_000,
  });
  need(r.status === 0, "GIT_COMMAND_FAILED");
  return r.stdout;
}

function readSmall(file, limit) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  need(
    st && st.isFile() && st.size > 0 && st.size <= limit,
    "RELEASE_FILE_MISSING",
  );
  return fs.readFileSync(file);
}

/** Every other release's sequence, so a new one must be strictly newer. */
function otherSequences(repo, revision) {
  const root = path.join(repo, STABLE);
  return fs
    .readdirSync(root)
    .filter((name) => SHA.test(name) && name !== revision)
    .map((name) => {
      const file = path.join(root, name, "release-manifest.json");
      return JSON.parse(readSmall(file, 65536)).sequence;
    });
}

export function verifyStableRelease({ repo, revision, archiveOut }) {
  need(SHA.test(revision ?? ""), "REVISION_NOT_FULL_SHA");
  const folder = path.join(repo, STABLE, revision);
  const manifestBytes = readSmall(
    path.join(folder, "release-manifest.json"),
    65536,
  );
  const signature = readSmall(path.join(folder, "release-manifest.sig"), 4096);
  need(
    fs.readdirSync(folder).sort().join(",") ===
      "release-manifest.json,release-manifest.sig",
    "UNEXPECTED_FILES_IN_RELEASE_FOLDER",
  );
  let m;
  try {
    m = JSON.parse(manifestBytes);
  } catch {
    throw new Blocked("MANIFEST_NOT_JSON");
  }
  need(
    m.schema === 1 && m.product === "KMJ CodeBridge" && m.channel === "stable",
    "MANIFEST_IDENTITY_INVALID",
  );
  need(m.keyId === KEY_ID, "MANIFEST_KEY_ID_UNEXPECTED");
  need(m.revision === revision, "MANIFEST_REVISION_NOT_FOLDER");
  need(Number.isSafeInteger(m.sequence) && m.sequence > 0, "SEQUENCE_INVALID");
  const others = otherSequences(repo, revision);
  need(
    others.every((s) => Number.isSafeInteger(s) && s < m.sequence),
    "SEQUENCE_NOT_NEWEST",
  );
  need(
    Number.isSafeInteger(m.nodeMajor) && m.nodeMajor >= 24,
    "NODE_MAJOR_INVALID",
  );
  need(
    HASH.test(m.sha256 ?? "") && Number.isSafeInteger(m.bytes) && m.bytes > 0,
    "ARCHIVE_DIGEST_INVALID",
  );

  git(repo, ["cat-file", "-e", `${revision}^{commit}`]);
  const version = JSON.parse(
    git(repo, ["show", `${revision}:package.json`]),
  ).version;
  need(
    VERSION.test(version) && m.version === version,
    "VERSION_NOT_SOURCE_PACKAGE",
  );
  const stem = `kmj-codebridge-${version}-${revision.slice(0, 12)}`;
  const archiveName = `${stem}.tar.gz`;
  need(
    m.archive === `${ORIGIN}/${revision}/${archiveName}`,
    "ARCHIVE_URL_UNEXPECTED",
  );

  let sig;
  try {
    sig = Buffer.from(signature.toString("ascii").trim(), "base64url");
  } catch {
    sig = Buffer.alloc(0);
  }
  need(sig.length === 64, "SIGNATURE_NOT_ED25519_LENGTH");

  // Rebuild the exact archive from Git and compare with the signed digest.
  const archive = git(
    repo,
    ["archive", "--format=tar.gz", `--prefix=${stem}/`, revision],
    "buffer",
  );
  need(archive.length === m.bytes, "ARCHIVE_SIZE_MISMATCH");
  need(sha256(archive) === m.sha256, "ARCHIVE_SHA256_MISMATCH");
  let archivePath = "";
  if (archiveOut) {
    fs.mkdirSync(archiveOut, { recursive: true });
    archivePath = path.join(archiveOut, archiveName);
    fs.writeFileSync(archivePath, archive, { flag: "wx" });
  }
  return {
    sequence: m.sequence,
    revision,
    version,
    tag: `codebridge-stable-seq${m.sequence}-${revision.slice(0, 8)}`,
    archiveName,
    archivePath,
    archiveSha256: m.sha256,
    archiveBytes: m.bytes,
    manifestSha256: sha256(manifestBytes),
    signatureSha256: sha256(signature),
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [revision, flag, out] = process.argv.slice(2);
  try {
    need(
      process.argv.length === 3 ||
        (process.argv.length === 5 && flag === "--archive-out"),
      "USAGE: verify-stable-release.mjs <revision> [--archive-out DIR]",
    );
    const r = verifyStableRelease({
      repo: process.cwd(),
      revision,
      archiveOut: out,
    });
    const lines = {
      RELEASE_CHECK: "PASS",
      SEQUENCE: r.sequence,
      REVISION: r.revision,
      VERSION: r.version,
      TAG: r.tag,
      ARCHIVE: r.archiveName,
      ARCHIVE_PATH: r.archivePath,
      ARCHIVE_SHA256: r.archiveSha256,
      ARCHIVE_BYTES: r.archiveBytes,
      MANIFEST_SHA256: r.manifestSha256,
      SIGNATURE_SHA256: r.signatureSha256,
      SIGNATURE_TRUST: "OWNER_HOST_VERIFICATION_REQUIRED",
    };
    for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  } catch (error) {
    const code = error instanceof Blocked ? error.message : "UNCLASSIFIED";
    console.log(`RELEASE_CHECK=BLOCKED:${code}`);
    process.exit(2);
  }
}
