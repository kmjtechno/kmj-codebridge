import fs from "node:fs";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CodeBridgeError, fail } from "./errors.js";

function isUnsafeLiteralHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return true;
  if (host.includes(":")) return true;

  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

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
      !isUnsafeLiteralHost(url.hostname) &&
      url.pathname.endsWith(".tar.gz") &&
      !/["\\\s]/.test(value)
    );
  }, "Requires a public HTTPS tar.gz URL");

export const releaseManifestSchema = z
  .object({
    schema: z.literal(1),
    product: z.literal("KMJ CodeBridge"),
    channel: z.enum(["stable", "beta"]),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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

export function verifyReleaseManifest(
  rawManifest,
  rawSignature,
  trustedKeys,
  { minimumSequence = -1 } = {},
) {
  const bytes = manifestBytes(rawManifest);
  let manifest;
  try {
    manifest = releaseManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    fail("UPDATE_MANIFEST_INVALID");
  }

  if (
    !Number.isSafeInteger(minimumSequence) ||
    minimumSequence < -1 ||
    manifest.sequence <= minimumSequence
  )
    fail("UPDATE_ROLLBACK_REJECTED");

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

export function isPublicReleaseAddress(address) {
  if (typeof address !== "string") return false;
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export async function resolvePublicReleaseAddress(
  hostname,
  lookup = dnsLookup,
) {
  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail("UPDATE_DOWNLOAD_DNS_FAILED");
  }
  if (!Array.isArray(answers) || answers.length < 1)
    fail("UPDATE_DOWNLOAD_DNS_FAILED");
  const ipv4 = answers.filter((answer) => Number(answer?.family) === 4);
  if (
    ipv4.length < 1 ||
    ipv4.some((answer) => !isPublicReleaseAddress(answer.address))
  )
    fail("UPDATE_DOWNLOAD_ADDRESS_REJECTED");
  return { address: ipv4[0].address, family: 4 };
}

function openPinnedHttpsResponse(
  url,
  {
    address,
    family,
    timeoutMs = 15000,
    accept = "application/gzip, application/octet-stream",
  } = {},
) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept,
          "accept-encoding": "identity",
          "user-agent": "KMJ-CodeBridge-Updater/1",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, address, family),
      },
      resolve,
    );
    request.setTimeout(Math.max(1000, Math.min(timeoutMs, 60000)), () => {
      request.destroy(new Error("timeout"));
    });
    request.once("error", () =>
      reject(new CodeBridgeError("UPDATE_DOWNLOAD_FAILED")),
    );
  });
}

export async function downloadPinnedHttpsBytes(
  value,
  {
    maxBytes = 65536,
    resolveAddress = resolvePublicReleaseAddress,
    request = openPinnedHttpsResponse,
  } = {},
) {
  if (
    typeof value !== "string" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1024 * 1024
  )
    fail("UPDATE_METADATA_INVALID");

  let url;
  try {
    url = new URL(value);
  } catch {
    fail("UPDATE_METADATA_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    isUnsafeLiteralHost(url.hostname) ||
    /["\\\s]/.test(value)
  )
    fail("UPDATE_METADATA_URL_INVALID");

  const pinned = await resolveAddress(url.hostname);
  if (!pinned || pinned.family !== 4 || !isPublicReleaseAddress(pinned.address))
    fail("UPDATE_DOWNLOAD_ADDRESS_REJECTED");

  const response = await request(url, {
    address: pinned.address,
    family: pinned.family,
    timeoutMs: 15000,
    accept: "application/json, text/plain, application/octet-stream",
  });
  const status = Number(response?.statusCode ?? 0);
  if (status >= 300 && status < 400) {
    response.resume?.();
    fail("UPDATE_DOWNLOAD_REDIRECT");
  }
  if (status !== 200) {
    response.resume?.();
    fail("UPDATE_METADATA_DOWNLOAD_FAILED");
  }

  const encoding = String(
    response.headers?.["content-encoding"] ?? "",
  ).toLowerCase();
  if (encoding && encoding !== "identity") {
    response.resume?.();
    fail("UPDATE_DOWNLOAD_ENCODING_REJECTED");
  }

  if (!response || typeof response[Symbol.asyncIterator] !== "function")
    fail("UPDATE_METADATA_DOWNLOAD_FAILED");

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) fail("UPDATE_METADATA_TOO_LARGE");
    chunks.push(data);
  }
  if (bytes < 1) fail("UPDATE_METADATA_INVALID");
  return Buffer.concat(chunks, bytes);
}

function safeWorkDirectory(workDir) {
  if (typeof workDir !== "string" || !path.isAbsolute(workDir))
    fail("UPDATE_WORK_DIR_INVALID");
  const resolved = path.resolve(workDir);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail("UPDATE_WORK_DIR_INVALID");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UPDATE_WORK_DIR_INVALID");
  return resolved;
}

export async function downloadVerifiedReleaseArchive(
  manifest,
  workDir,
  {
    resolveAddress = resolvePublicReleaseAddress,
    request = openPinnedHttpsResponse,
  } = {},
) {
  releaseManifestSchema.parse(manifest);
  const root = safeWorkDirectory(workDir);
  const url = new URL(manifest.archive);
  const pinned = await resolveAddress(url.hostname);
  if (!pinned || pinned.family !== 4 || !isPublicReleaseAddress(pinned.address))
    fail("UPDATE_DOWNLOAD_ADDRESS_REJECTED");

  const response = await request(url, {
    address: pinned.address,
    family: pinned.family,
    timeoutMs: 15000,
  });
  const status = Number(response?.statusCode ?? 0);
  if (status >= 300 && status < 400) {
    response.resume?.();
    fail("UPDATE_DOWNLOAD_REDIRECT");
  }
  if (status !== 200) {
    response.resume?.();
    fail("UPDATE_DOWNLOAD_FAILED");
  }

  const encoding = String(
    response.headers?.["content-encoding"] ?? "",
  ).toLowerCase();
  if (encoding && encoding !== "identity") {
    response.resume?.();
    fail("UPDATE_DOWNLOAD_ENCODING_REJECTED");
  }
  const lengthHeader = response.headers?.["content-length"];
  if (lengthHeader !== undefined) {
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared !== manifest.bytes) {
      response.resume?.();
      fail("UPDATE_ARCHIVE_SIZE_MISMATCH");
    }
  }
  if (!response || typeof response[Symbol.asyncIterator] !== "function")
    fail("UPDATE_DOWNLOAD_FAILED");

  const target = path.join(
    root,
    `.download-${releaseDirectoryName(manifest)}-${randomUUID()}.tar.gz`,
  );
  let fd = null;
  try {
    fd = fs.openSync(target, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > manifest.bytes) fail("UPDATE_ARCHIVE_SIZE_MISMATCH");
      fs.writeSync(fd, data);
      hash.update(data);
    }
    if (bytes !== manifest.bytes) fail("UPDATE_ARCHIVE_SIZE_MISMATCH");
    const sha256 = hash.digest("hex");
    if (sha256 !== manifest.sha256) fail("UPDATE_ARCHIVE_HASH_MISMATCH");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return { path: target, bytes, sha256 };
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(target);
    } catch {}
    if (error instanceof CodeBridgeError) throw error;
    fail("UPDATE_DOWNLOAD_FAILED");
  }
}

export function validateRuntimeArchiveEntries(entries, manifest) {
  releaseManifestSchema.parse(manifest);
  validateArchiveEntries(entries);
  if (new Set(entries).size !== entries.length)
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  const root = `kmj-codebridge-${releaseDirectoryName(manifest)}`;
  if (
    entries.some(
      (entry) => entry !== `${root}/` && !entry.startsWith(`${root}/`),
    ) ||
    !entries.includes(`${root}/package.json`) ||
    !entries.includes(`${root}/src/cli.js`)
  )
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  return root;
}

function defaultTarRun(args) {
  return execFileSync("tar", args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
  });
}

function archiveListing(archivePath, run) {
  let namesText;
  let verboseText;
  try {
    namesText = run(["--list", "--gzip", "--file", archivePath]);
    verboseText = run([
      "--list",
      "--verbose",
      "--numeric-owner",
      "--gzip",
      "--file",
      archivePath,
    ]);
  } catch {
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  }
  const entries = String(namesText)
    .split("\n")
    .filter((line) => line.length > 0);
  const metadata = String(verboseText)
    .split("\n")
    .filter((line) => line.length > 0);
  if (entries.length !== metadata.length) fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  if (metadata.some((line) => !["-", "d"].includes(line[0])))
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  validateArchiveEntries(entries);
  return entries;
}

function validateExtractedTree(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
      if (stat.isDirectory()) stack.push(target);
      else if (!stat.isFile() || stat.nlink !== 1)
        fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
    }
  }
}

export function extractVerifiedRuntimeArchive(
  archivePath,
  stagingDir,
  manifest,
  { run = defaultTarRun } = {},
) {
  if (process.platform === "win32") fail("UPDATE_ACTIVATION_UNSUPPORTED");
  releaseManifestSchema.parse(manifest);
  if (
    typeof archivePath !== "string" ||
    typeof stagingDir !== "string" ||
    !path.isAbsolute(archivePath) ||
    !path.isAbsolute(stagingDir)
  )
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");

  let archiveStat;
  let stagingStat;
  try {
    archiveStat = fs.lstatSync(archivePath);
    stagingStat = fs.lstatSync(stagingDir);
  } catch {
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");
  }
  if (
    !archiveStat.isFile() ||
    archiveStat.isSymbolicLink() ||
    !stagingStat.isDirectory() ||
    stagingStat.isSymbolicLink() ||
    fs.readdirSync(stagingDir).length !== 0
  )
    fail("UPDATE_ARCHIVE_LAYOUT_INVALID");

  const entries = archiveListing(archivePath, run);
  const root = validateRuntimeArchiveEntries(entries, manifest);
  try {
    run([
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      stagingDir,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
      "--delay-directory-restore",
    ]);
    validateExtractedTree(stagingDir);
    const pkg = path.join(stagingDir, "package.json");
    const cli = path.join(stagingDir, "src", "cli.js");
    if (
      !fs.existsSync(pkg) ||
      !fs.lstatSync(pkg).isFile() ||
      !fs.existsSync(cli) ||
      !fs.lstatSync(cli).isFile()
    )
      fail("UPDATE_STAGED_RUNTIME_INVALID");
    return { root, entries: entries.length };
  } catch (error) {
    try {
      for (const name of fs.readdirSync(stagingDir))
        fs.rmSync(path.join(stagingDir, name), {
          recursive: true,
          force: true,
        });
    } catch {}
    if (error instanceof CodeBridgeError) throw error;
    fail("UPDATE_ARCHIVE_EXTRACT_FAILED");
  }
}
