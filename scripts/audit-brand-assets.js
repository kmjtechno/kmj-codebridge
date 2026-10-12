#!/usr/bin/env node
// Offline branding diagnostics. Repository icon validity cannot attest
// to a cached/approved marketplace listing on OpenAI or Claude.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relative = "assets/icon.png";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function info(buffer) {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString("ascii", 12, 16) !== "IHDR")
    throw new Error("BRAND_ICON_NOT_PNG");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== height || width < 64 || width > 4096 || buffer.length > 2 * 1024 * 1024)
    throw new Error("BRAND_ICON_INVALID_DIMENSIONS");
  return { width, height, bytes: buffer.length, sha256: digest(buffer) };
}

export function auditBrandAssets(root = repoRoot) {
  const icon = fs.readFileSync(path.join(root, "plugin", relative));
  const second = fs.readFileSync(path.join(root, "claude-plugin", relative));
  const source = info(icon);
  if (digest(second) !== source.sha256) throw new Error("BRAND_ICON_PACKAGE_DRIFT");
  const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const plugin = json("plugin/plugin.json");
  const claude = json("claude-plugin/.claude-plugin/plugin.json");
  const product = json("product/codebridge-product.json");
  const selected = plugin.extensions?.["com.openai"]?.interface;
  const contract = ["logo", "logoDark", "composerIcon", "composerIconDark"];
  if (!selected || contract.some((field) => selected[field] !== "./" + relative) || claude.icon !== "./" + relative)
    throw new Error("BRAND_ICON_METADATA_DRIFT");
  if (product.product?.assets?.icon !== "plugin/assets/icon.png" || product.product?.assets?.logo !== "plugin/assets/icon.png")
    throw new Error("BRAND_PRODUCT_ASSET_DRIFT");
  if (plugin.extensions["com.openai"].apps !== "./.app.json") throw new Error("BRAND_APP_CONFIG_DRIFT");
  const app = json("plugin/.app.json");
  if (app.apps?.codebridge?.id !== product.marketplaces?.openai?.appId)
    throw new Error("BRAND_APP_ID_DRIFT");
  return {
    sourceStatus: "PASS",
    icon: source,
    packagesIdentical: true,
    metadataConsistent: true,
    appId: app.apps.codebridge.id,
    liveMarketplaceListingStatus: "NOT_VERIFIED",
    liveBrandingReady: false,
    nextAction: "Inspect actual installed ChatGPT app listing against this canonical icon SHA-256; republish/refresh the same authorized app ID through official marketplace controls if it differs.",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(auditBrandAssets(), null, 2) + "\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "BRAND_AUDIT_FAILED");
    process.exitCode = 1;
  }
}
