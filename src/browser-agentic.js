// CodeBridge-only, default-off Browsentic observer. No generic agent tools or navigation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const BROWSENTIC_VERSION = "0.9.0";

export function pinnedBrowsenticEntry(platform = process.platform) {
  if (platform === "win32")
    return "C:\\ProgramData\\KMJ\\CodeBridge\\browsentic\\v0.9.0\\node_modules\\browsentic\\dist\\cli.js";
  if (platform === "linux")
    return "/opt/kmj-codebridge-tools/browsentic/v0.9.0/node_modules/browsentic/dist/cli.js";
  return null;
}

export function verifyBrowsenticEntry(expected, options = {}) {
  const entry = pinnedBrowsenticEntry(options.platform);
  const lstat = options.lstat ?? fs.lstatSync;
  const read = options.read ?? fs.readFileSync;
  if (!entry || !/^[a-f0-9]{64}$/.test(expected ?? ""))
    throw Error("BROWSENTIC_PIN_NOT_APPROVED");
  try {
    const pkg = path.join(path.dirname(path.dirname(entry)), "package.json");
    for (const file of [entry, pkg]) {
      const stat = lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("BROWSENTIC_PIN_INVALID");
    }
    const meta = JSON.parse(read(pkg, "utf8"));
    if (meta.name !== "browsentic" || meta.version !== BROWSENTIC_VERSION)
      throw Error("BROWSENTIC_VERSION_MISMATCH");
    const digest = createHash("sha256").update(read(entry)).digest("hex");
    if (digest !== expected) throw Error("BROWSENTIC_SHA_MISMATCH");
    return entry;
  } catch {
    throw Error("BROWSENTIC_PIN_UNVERIFIED");
  }
}

export function browserAgenticReadiness(config = {}, options = {}) {
  const enabled = config?.enabled === true;
  let approved = false;
  if (enabled && config?.entrySha256) {
    try {
      verifyBrowsenticEntry(config.entrySha256, options);
      approved = true;
    } catch {}
  }
  return {
    engine: "browsentic_mcp",
    pinnedVersion: BROWSENTIC_VERSION,
    enabled,
    packageVerified: approved,
    browserPairingVerified: false,
    liveProbeVerified: false,
    supportedWork: "owner_opt_in_read_only_element_counts",
    unsupported: [
      "unattended_writes",
      "generic_mcp_calls",
      "headless_visual_qa",
    ],
  };
}

export function assertApprovedPage(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw Error("BROWSENTIC_ORIGIN_BLOCKED");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("BROWSENTIC_ORIGIN_BLOCKED");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "kmjtechno.com" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%|\\/.test(url.pathname) ||
    !(
      ["/", "/login", "/products", "/admin", "/super-admin"].includes(
        url.pathname,
      ) ||
      url.pathname.startsWith("/admin/") ||
      url.pathname.startsWith("/super-admin/")
    )
  )
    throw Error("BROWSENTIC_ORIGIN_BLOCKED");
  return url.pathname;
}

export function unpackMcpText(result) {
  if (result?.isError || !Array.isArray(result?.content))
    throw Error("BROWSENTIC_MCP_RESULT_INVALID");
  const items = result.content.filter((part) => part?.type === "text");
  if (
    items.length !== 1 ||
    typeof items[0].text !== "string" ||
    items[0].text.length > 150000
  )
    throw Error("BROWSENTIC_MCP_RESULT_INVALID");
  try {
    const value = items[0].text;
    // Browsentic intentionally fences all page-authored MCP data.
    // Strictly recognize the canonical wrapper; never run or forward its text.
    const fenced = value.match(
      /^Untrusted page content follows\.[^\n]*\n<<<untrusted-page-data:([a-f0-9]{12})>>>\n([\s\S]*)\n<<<\/untrusted-page-data:\1>>>$/,
    );
    if (value.startsWith("Untrusted page content follows.") && !fenced)
      throw Error("invalid fence");
    const parsed = JSON.parse(fenced ? fenced[2] : value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error("invalid");
    return parsed;
  } catch {
    throw Error("BROWSENTIC_MCP_RESULT_INVALID");
  }
}

export function pageUrl(payload) {
  const candidates = [
    payload?.activeTab?.url,
    payload?.tab?.url,
    payload?.page?.url,
    payload?.document?.url,
    payload?.url,
  ];
  return candidates.find((candidate) => typeof candidate === "string") ?? null;
}

function boundedCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100000
    ? value
    : null;
}

export async function observeWithReadOnlyCalls(call) {
  const status = unpackMcpText(await call("browsentic_status", {}));
  const initialUrl = pageUrl(status);
  const route = assertApprovedPage(initialUrl);
  const info = unpackMcpText(
    await call("page_getPageInfo", { maxPerKind: 10, geometry: false }),
  );
  const finalUrl = pageUrl(info);
  if (assertApprovedPage(finalUrl) !== route || initialUrl !== finalUrl)
    throw Error("BROWSENTIC_TAB_CHANGED");
  const counts = info?.interactive?.counts ?? {};
  return {
    verdict: "OBSERVATION_ONLY",
    engine: "browsentic_mcp",
    route,
    counts: {
      links: boundedCount(counts.links),
      buttons: boundedCount(counts.buttons),
      fields: boundedCount(counts.fields),
      forms: boundedCount(counts.forms),
    },
    visualQaPassed: false,
    ownerActionsPerformed: false,
  };
}

export function browsenticChildEnvironment(parent = process.env) {
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ])
    if (typeof parent[key] === "string") result[key] = parent[key];
  return result;
}
