import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { fail } from "./errors.js";

const httpsArchive = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !/["\\\s]/.test(value)
    );
  }, "Requires HTTPS");

export const releaseManifestSchema = z
  .object({
    schema: z.literal(1),
    product: z.literal("KMJ CodeBridge"),
    channel: z.enum(["stable", "beta"]),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    archive: httpsArchive,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(536870912),
    nodeMajor: z.literal(24),
    publishedAt: z.string().datetime({ offset: true }),
    keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  })
  .strict();

function manifestBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (bytes.length < 2 || bytes.length > 65536) fail("UPDATE_MANIFEST_INVALID");
  return bytes;
}

function signatureBytes(input) {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{64,256}$/.test(input))
    fail("UPDATE_SIGNATURE_INVALID");
  try {
    const bytes = Buffer.from(input, "base64url");
    if (bytes.length !== 64) fail("UPDATE_SIGNATURE_INVALID");
    return bytes;
  } catch {
    fail("UPDATE_SIGNATURE_INVALID");
  }
}

export function verifyReleaseManifest(rawManifest, rawSignature, trustedKeys) {
  const bytes = manifestBytes(rawManifest);
  let manifest;
  try {
    manifest = releaseManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    fail("UPDATE_MANIFEST_INVALID");
  }

  const encodedKey = trustedKeys?.[manifest.keyId];
  if (typeof encodedKey !== "string" || encodedKey.length < 32)
    fail("UPDATE_KEY_UNKNOWN");

  let key;
  try {
    key = createPublicKey(encodedKey);
  } catch {
    fail("UPDATE_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("UPDATE_KEY_INVALID");

  const signature = signatureBytes(rawSignature);
  if (!verifySignature(null, bytes, key, signature))
    fail("UPDATE_SIGNATURE_INVALID");

  return manifest;
}

export function verifyReleaseArchive(archive, manifest) {
  if (!Buffer.isBuffer(archive)) fail("UPDATE_ARCHIVE_INVALID");
  if (archive.length !== manifest.bytes) fail("UPDATE_ARCHIVE_SIZE_MISMATCH");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== manifest.sha256) fail("UPDATE_ARCHIVE_HASH_MISMATCH");
  return { bytes: archive.length, sha256 };
}

export function releaseDirectoryName(manifest) {
  releaseManifestSchema.parse(manifest);
  return `${manifest.version}-${manifest.revision.slice(0, 12)}`;
}

export function safeReleasePath(releasesDir, manifest) {
  if (typeof releasesDir !== "string" || !path.isAbsolute(releasesDir))
    fail("UPDATE_RELEASE_ROOT_INVALID");
  const root = path.resolve(releasesDir);
  const target = path.resolve(root, releaseDirectoryName(manifest));
  if (path.dirname(target) !== root) fail("UPDATE_RELEASE_PATH_INVALID");
  return target;
}

export function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10000)
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 4096)
      fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
    if (entry.includes("\0") || entry.includes("\\"))
      fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
    const normalized = path.posix.normalize(entry);
    if (
      entry.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.includes("/../")
    )
      fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  }
  return true;
}
