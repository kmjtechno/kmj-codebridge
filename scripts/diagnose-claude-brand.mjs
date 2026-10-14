#!/usr/bin/env node
/**
 * Read-only evidence for Claude connector branding.
 * The plugin PNG and the website favicon are independent surfaces.
 * A non-Laravel favicon does NOT prove Claude rendered the KMJ icon.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://kmjtechno.com";
const FAVICON_URL = `${ORIGIN}/favicon.ico`;
export const APPROVED_CLAUDE_ICON_SHA256 =
  "fcd5f1640cbc96be3df48c7e1fb9fd43b330960c9ca7fcdf2e39af0e3cdd720d";

// Stock Laravel browser/home-screen icons previously rejected by Main Platform.
const LARAVEL_DEFAULT_MD5 = new Set([
  "08242d646ff63d0fa7f43b1f34868700",
  "4ec34bfee5050d402638888ce2e9a968",
]);
const MAX_FAVICON_BYTES = 262_144;

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

export function verifyClaudeIcon(bytes) {
  const sha256 = digest("sha256", bytes);
  return {
    status:
      sha256 === APPROVED_CLAUDE_ICON_SHA256
        ? "LOCKED_ICON_PASS"
        : "LOCKED_ICON_MISMATCH",
    sha256,
    expectedSha256: APPROVED_CLAUDE_ICON_SHA256,
  };
}

export function classifyFavicon(bytes, contentType, md5 = digest("md5", bytes)) {
  const ico = bytes.length >= 6 && bytes.readUInt16LE(0) === 0 &&
    bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0;
  return {
    status: LARAVEL_DEFAULT_MD5.has(md5)
      ? "LARAVEL_DEFAULT_DETECTED"
      : ico
        ? "NON_STOCK_ICO_VISUAL_UNVERIFIED"
        : "UNRECOGNIZED_FAVICON_FORMAT",
    sha256: digest("sha256", bytes),
    md5,
    bytes: bytes.length,
    contentType,
    // This fingerprint cannot establish the icon Claude displays or caches.
    claudeVisibleIconVerified: false,
  };
}

async function readBounded(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FAVICON_BYTES) {
    throw new Error("FAVICON_TOO_LARGE");
  }
  if (!response.body) throw new Error("EMPTY_FAVICON_RESPONSE");
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > MAX_FAVICON_BYTES) throw new Error("FAVICON_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, count);
}

export async function diagnoseClaudeBrand({
  fetcher = fetch,
  readIcon = () =>
    readFile(new URL("../claude-plugin/assets/icon.png", import.meta.url)),
} = {}) {
  let sourceIcon;
  try {
    sourceIcon = verifyClaudeIcon(await readIcon());
  } catch {
    sourceIcon = { status: "LOCKED_ICON_UNVERIFIED" };
  }
  let favicon;
  try {
    const response = await fetcher(FAVICON_URL, {
      method: "GET",
      redirect: "error",
      headers: { accept: "image/x-icon, image/vnd.microsoft.icon" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const bytes = await readBounded(response);
    favicon = classifyFavicon(
      bytes,
      response.headers.get("content-type") ?? "unknown",
    );
  } catch (error) {
    const code = String(error?.message ?? "UNKNOWN");
    favicon = {
      status: "LIVE_FAVICON_UNVERIFIED",
      reason: /^HTTP_[0-9]{3}$|^FAVICON_TOO_LARGE$|^EMPTY_FAVICON_RESPONSE$/.test(code)
        ? code
        : "UNREACHABLE_OR_INVALID",
      claudeVisibleIconVerified: false,
    };
  }
  return {
    sourceIcon,
    favicon,
    inspectedUrl: FAVICON_URL,
    oauthConnectionVerified: false,
    claudeVisibleIconVerified: false,
    note:
      "This only fingerprints public favicon and the exact plugin PNG. " +
      "Claude OAuth and visible connector branding still need client-side verification.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await diagnoseClaudeBrand();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (
    result.sourceIcon.status !== "LOCKED_ICON_PASS" ||
    result.favicon.status === "LARAVEL_DEFAULT_DETECTED"
  ) {
    process.exitCode = 1;
  }
}
