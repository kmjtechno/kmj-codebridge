import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  downloadVerifiedReleaseArchive,
  extractVerifiedRuntimeArchive,
  isPublicReleaseAddress,
  releaseDirectoryName,
  resolvePublicReleaseAddress,
  safeReleasePath,
  validateArchiveEntries,
  validateRuntimeArchiveEntries,
  verifyReleaseArchive,
  verifyReleaseManifest,
} from "../src/update.js";

function fixture(overrides = {}) {
  const archive = Buffer.from("verified release archive");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 42,
    version: "0.2.0",
    revision: "a".repeat(40),
    archive: "https://downloads.kmjtechno.com/codebridge/0.2.0.tar.gz",
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt: "2026-10-03T00:00:00Z",
    keyId: "release-2026",
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, privateKey).toString("base64url");
  const keys = {
    "release-2026": publicKey.export({ type: "spki", format: "pem" }),
  };
  return { archive, manifest, bytes, signature, keys, privateKey };
}

test("verifies exact signed manifest bytes with an Ed25519 key", () => {
  const f = fixture();
  assert.deepEqual(
    verifyReleaseManifest(f.bytes, f.signature, f.keys),
    f.manifest,
  );
});

test("enforces a monotonically increasing signed release sequence", () => {
  const f = fixture();
  assert.deepEqual(
    verifyReleaseManifest(f.bytes, f.signature, f.keys, {
      minimumSequence: 41,
    }),
    f.manifest,
  );
  for (const minimumSequence of [42, 43])
    assert.throws(
      () =>
        verifyReleaseManifest(f.bytes, f.signature, f.keys, {
          minimumSequence,
        }),
      /UPDATE_ROLLBACK_REJECTED/,
    );
});

test("rejects tampered manifest bytes and unknown signing keys", () => {
  const f = fixture();
  const tampered = Buffer.from(
    JSON.stringify({ ...f.manifest, version: "9.9.9" }),
  );
  assert.throws(
    () => verifyReleaseManifest(tampered, f.signature, f.keys),
    /UPDATE_SIGNATURE_INVALID/,
  );
  assert.throws(
    () => verifyReleaseManifest(f.bytes, f.signature, {}),
    /UPDATE_KEY_UNKNOWN/,
  );
});

test("rejects non-Ed25519 signing keys", () => {
  const f = fixture();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  assert.throws(
    () =>
      verifyReleaseManifest(f.bytes, f.signature, {
        "release-2026": rsa.export({ type: "spki", format: "pem" }),
      }),
    /UPDATE_KEY_INVALID/,
  );
});

test("requires exact archive size and SHA-256", () => {
  const f = fixture();
  assert.deepEqual(verifyReleaseArchive(f.archive, f.manifest), {
    bytes: f.archive.length,
    sha256: f.manifest.sha256,
  });
  assert.throws(
    () =>
      verifyReleaseArchive(
        Buffer.concat([f.archive, Buffer.from("x")]),
        f.manifest,
      ),
    /UPDATE_ARCHIVE_SIZE_MISMATCH/,
  );
  assert.throws(
    () =>
      verifyReleaseArchive(Buffer.from("different archive"), {
        ...f.manifest,
        bytes: Buffer.byteLength("different archive"),
      }),
    /UPDATE_ARCHIVE_HASH_MISMATCH/,
  );
});

test("release target is deterministic and contained under the release root", () => {
  const f = fixture();
  assert.equal(releaseDirectoryName(f.manifest), `0.2.0-${"a".repeat(12)}`);
  assert.equal(
    safeReleasePath("/opt/kmj-codebridge/releases", f.manifest),
    path.resolve("/opt/kmj-codebridge/releases", `0.2.0-${"a".repeat(12)}`),
  );
});

test("archive layout rejects absolute and traversal entries", () => {
  assert.equal(
    validateArchiveEntries([
      "kmj-codebridge/package.json",
      "kmj-codebridge/src/cli.js",
    ]),
    true,
  );
  for (const entries of [
    ["/etc/passwd"],
    ["../outside"],
    ["release/../../outside"],
    ["release\\windows-path"],
  ])
    assert.throws(
      () => validateArchiveEntries(entries),
      /UPDATE_ARCHIVE_LAYOUT_INVALID/,
    );
});

test("manifest rejects unsafe archive URLs and unexpected fields", () => {
  for (const overrides of [
    { archive: "http://downloads.example/release.tar.gz" },
    { archive: "https://user:pass@downloads.example/release.tar.gz" },
    { archive: "https://localhost/release.tar.gz" },
    { archive: "https://127.0.0.1/release.tar.gz" },
    { archive: "https://10.1.2.3/release.tar.gz" },
    { archive: "https://192.168.1.2/release.tar.gz" },
    { archive: "https://[::1]/release.tar.gz" },
    { archive: "https://host.local/release.tar.gz" },
    { archive: "https://downloads.example/release.zip" },
    { extra: "not-allowed" },
  ]) {
    const f = fixture(overrides);
    assert.throws(
      () => verifyReleaseManifest(f.bytes, f.signature, f.keys),
      /UPDATE_MANIFEST_INVALID/,
    );
  }
});

test("release downloader accepts only public IPv4 DNS answers", async () => {
  assert.equal(isPublicReleaseAddress("1.1.1.1"), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.2",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicReleaseAddress(address), false, address);

  await assert.rejects(
    () =>
      resolvePublicReleaseAddress("downloads.example", async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    /UPDATE_DOWNLOAD_ADDRESS_REJECTED/,
  );
  assert.deepEqual(
    await resolvePublicReleaseAddress("downloads.example", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]),
    { address: "1.1.1.1", family: 4 },
  );
});

test("release downloader pins verified bytes and rejects redirects", async (t) => {
  const f = fixture();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-update-download-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const request = async () => {
    const response = Readable.from([f.archive]);
    response.statusCode = 200;
    response.headers = { "content-length": String(f.archive.length) };
    return response;
  };
  const result = await downloadVerifiedReleaseArchive(f.manifest, workDir, {
    resolveAddress: async () => ({ address: "1.1.1.1", family: 4 }),
    request,
  });
  assert.equal(fs.readFileSync(result.path).toString(), f.archive.toString());
  assert.equal(result.bytes, f.archive.length);
  assert.equal(result.sha256, f.manifest.sha256);

  await assert.rejects(
    () =>
      downloadVerifiedReleaseArchive(f.manifest, workDir, {
        resolveAddress: async () => ({ address: "1.1.1.1", family: 4 }),
        request: async () => {
          const response = Readable.from([]);
          response.statusCode = 302;
          response.headers = {
            location: "https://example.com/elsewhere.tar.gz",
          };
          return response;
        },
      }),
    /UPDATE_DOWNLOAD_REDIRECT/,
  );
});

test("runtime archive requires one exact release root", () => {
  const f = fixture();
  const root = `kmj-codebridge-${releaseDirectoryName(f.manifest)}`;
  assert.equal(
    validateRuntimeArchiveEntries(
      [`${root}/`, `${root}/package.json`, `${root}/src/cli.js`],
      f.manifest,
    ),
    root,
  );
  for (const entries of [
    ["other/package.json", "other/src/cli.js"],
    [`${root}/package.json`, "other/src/cli.js"],
    [`${root}/../outside`],
  ])
    assert.throws(
      () => validateRuntimeArchiveEntries(entries, f.manifest),
      /UPDATE_ARCHIVE_LAYOUT_INVALID/,
    );
});

test(
  "safe runtime extraction strips only the verified release root and rejects symlinks",
  { skip: process.platform === "win32" && "POSIX updater contract" },
  (t) => {
    const f = fixture();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-update-extract-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const rootName = `kmj-codebridge-${releaseDirectoryName(f.manifest)}`;
    const source = path.join(temp, rootName);
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@kmjtechno/codebridge",
        version: f.manifest.version,
      }),
    );
    fs.writeFileSync(path.join(source, "src/cli.js"), "export {};\n");
    const archive = path.join(temp, "runtime.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", temp, rootName]);
    const staging = path.join(temp, "staging");
    fs.mkdirSync(staging);
    const extracted = extractVerifiedRuntimeArchive(
      archive,
      staging,
      f.manifest,
    );
    assert.equal(extracted.root, rootName);
    assert.ok(fs.existsSync(path.join(staging, "package.json")));
    assert.ok(fs.existsSync(path.join(staging, "src/cli.js")));

    const unsafeRoot = path.join(temp, "unsafe", rootName);
    fs.mkdirSync(unsafeRoot, { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(unsafeRoot, "link"));
    const unsafeArchive = path.join(temp, "unsafe.tar.gz");
    execFileSync("tar", [
      "-czf",
      unsafeArchive,
      "-C",
      path.join(temp, "unsafe"),
      rootName,
    ]);
    const unsafeStaging = path.join(temp, "unsafe-staging");
    fs.mkdirSync(unsafeStaging);
    assert.throws(
      () =>
        extractVerifiedRuntimeArchive(unsafeArchive, unsafeStaging, f.manifest),
      /UPDATE_ARCHIVE_LAYOUT_INVALID/,
    );
  },
);
