#!/usr/bin/env node
// KMJ TECHNO: real detached Ed25519 verification for GitHub Release publication.
// Runs after exact archive rebuild; no signing, network, key download or deploy.
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { pathToFileURL } from "node:url";

export const OWNER_SPKI_SHA256 =
  "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8";
const SHA = /^[a-f0-9]{40}$/;
const HEX = /^[a-f0-9]{64}$/;
const KEY_ID = "kmj-release-2026";
const ORIGIN = "https://kmjtechno.com/codebridge/releases/stable";

class Blocked extends Error {}
const need = (yes, code) => {
  if (!yes) throw new Blocked(code);
};
function smallRegularFile(file, max) {
  let fd;
  try {
    const st = fs.lstatSync(file);
    need(
      st.isFile() &&
        !st.isSymbolicLink() &&
        st.nlink === 1 &&
        st.size > 0 &&
        st.size <= max,
      "OWNER_RELEASE_FILE_UNTRUSTED",
    );
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(fd);
    need(
      before.dev === st.dev &&
        before.ino === st.ino &&
        before.size === st.size &&
        before.isFile(),
      "OWNER_RELEASE_FILE_CHANGED",
    );
    const bytes = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < bytes.length) {
      const read = fs.readSync(fd, bytes, pos, bytes.length - pos, pos);
      need(read > 0, "OWNER_RELEASE_FILE_CHANGED");
      pos += read;
    }
    const after = fs.fstatSync(fd);
    need(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "OWNER_RELEASE_FILE_CHANGED",
    );
    return bytes;
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw new Blocked("OWNER_RELEASE_FILE_UNTRUSTED");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function verifyOwnerSignedPair({
  manifestBytes,
  signatureBytes,
  publicKeyPem,
  revision,
  expectedSpki = OWNER_SPKI_SHA256,
}) {
  need(SHA.test(revision), "OWNER_RELEASE_REVISION_INVALID");
  need(
    Buffer.isBuffer(manifestBytes) &&
      manifestBytes.length >= 2 &&
      manifestBytes.length <= 65536 &&
      Buffer.isBuffer(signatureBytes) &&
      signatureBytes.length > 0 &&
      signatureBytes.length <= 1024,
    "OWNER_RELEASE_BYTES_INVALID",
  );
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new Blocked("OWNER_RELEASE_KEY_INVALID");
  }
  need(
    key.asymmetricKeyType === "ed25519" &&
      createHash("sha256")
        .update(key.export({ format: "der", type: "spki" }))
        .digest("hex") === expectedSpki,
    "OWNER_RELEASE_SPKI_MISMATCH",
  );
  const sigText = signatureBytes.toString("ascii").trim();
  need(
    /^[A-Za-z0-9_-]{86}$/.test(sigText),
    "OWNER_RELEASE_SIGNATURE_FORMAT_INVALID",
  );
  const sig = Buffer.from(sigText, "base64url");
  need(
    sig.length === 64 && sig.toString("base64url") === sigText,
    "OWNER_RELEASE_SIGNATURE_FORMAT_INVALID",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Blocked("OWNER_RELEASE_MANIFEST_INVALID");
  }
  need(
    manifest &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      manifest.schema === 1 &&
      manifest.product === "KMJ CodeBridge" &&
      manifest.channel === "stable" &&
      manifest.keyId === KEY_ID &&
      manifest.revision === revision &&
      Number.isSafeInteger(manifest.sequence) &&
      manifest.sequence > 0 &&
      typeof manifest.version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version) &&
      Number.isSafeInteger(manifest.bytes) &&
      manifest.bytes >= 1024 &&
      manifest.nodeMajor === 24 &&
      HEX.test(manifest.sha256) &&
      manifest.archive ===
        ORIGIN +
          "/" +
          revision +
          "/kmj-codebridge-" +
          manifest.version +
          "-" +
          revision.slice(0, 12) +
          ".tar.gz",
    "OWNER_RELEASE_IDENTITY_INVALID",
  );
  need(
    verify(null, manifestBytes, key, sig),
    "OWNER_RELEASE_SIGNATURE_INVALID",
  );
  return { sequence: manifest.sequence, revision };
}

export function verifyOwnerReleaseFolder(root, revision) {
  need(SHA.test(revision), "OWNER_RELEASE_REVISION_INVALID");
  const folder = path.join(root, "releases", "stable", revision);
  const publicKey = smallRegularFile(
    path.join(
      root,
      "tests",
      "fixtures",
      "KMJ_RELEASE_PUBLIC_KEY_EVIDENCE_20261115.txt",
    ),
    8192,
  );
  return verifyOwnerSignedPair({
    manifestBytes: smallRegularFile(
      path.join(folder, "release-manifest.json"),
      65536,
    ),
    signatureBytes: smallRegularFile(
      path.join(folder, "release-manifest.sig"),
      1024,
    ),
    publicKeyPem: publicKey,
    revision,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    need(process.argv.length === 3, "OWNER_RELEASE_USAGE");
    const result = verifyOwnerReleaseFolder(process.cwd(), process.argv[2]);
    console.log("OWNER_RELEASE_ED25519=PASS");
    console.log("OWNER_RELEASE_SEQUENCE=" + result.sequence);
    console.log("OWNER_RELEASE_REVISION=" + result.revision);
    console.log("OWNER_RELEASE_KEY_CUSTODY=SEPARATE_OWNER_PROOF_REQUIRED");
  } catch (error) {
    const code =
      error instanceof Blocked
        ? error.message
        : "OWNER_RELEASE_VERIFICATION_FAILED";
    console.error("OWNER_RELEASE_ED25519=BLOCKED:" + code);
    process.exitCode = 2;
  }
}
