import { pathToFileURL } from "node:url";

export const REQUIRED_TOOLS = Object.freeze([
  "autopilot_local_draft",
  "chat_lane_release",
  "chat_lane_reserve",
  "chat_lane_status",
  "compact_work_brief",
  "fleet_overview",
  "local_model_generate",
  "local_model_status",
  "project_progress",
  "render_codebridge_status",
  "worktree_lane_cleanup",
  "worktree_lane_prepare",
  "worktree_lane_status",
]);

// Public discovery must expose the current, security-sensitive tool contracts.
// Count alone is never sufficient: different origins may legitimately carry
// different hosted-only integrations, but these tools must exist on both.
export const CRITICAL_TOOL_PROPERTIES = Object.freeze({
  coordination_list: ["device", "project", "limit", "after"],
  coordination_post: [
    "device",
    "project",
    "actor",
    "recipient",
    "requestKey",
    "kind",
    "note",
  ],
  autopilot_claim: ["device", "project"],
  autopilot_checkpoint: ["device", "project", "task", "leaseToken"],
  autopilot_wait: ["device", "project", "task", "leaseToken"],
  autopilot_complete: ["device", "project", "task", "leaseToken"],
});

export const ENDPOINTS = Object.freeze({
  render: "https://kmj-codebridge-gateway.onrender.com",
  production: "https://kmjtechno.com",
});
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_TOOL_COUNT = 100;
const RPC = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codebridge-deploy-probe", version: "1.0.0" },
  },
});
const GIT_SHA = /^[0-9a-f]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

// Plain JSON or SSE `data:` frames, as returned by streamable HTTP MCP.
function rpcMessages(body) {
  if (typeof body !== "string" || body.length > MAX_RESPONSE_BYTES) {
    throw new Error("MCP_CATALOG_RESPONSE_INVALID");
  }
  const candidates = [
    body.trim(),
    ...body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()),
  ];
  const parsed = [];
  for (const value of candidates) {
    try {
      parsed.push(JSON.parse(value));
    } catch {
      continue;
    }
  }
  return parsed;
}

export function parseToolCatalog(body) {
  for (const parsed of rpcMessages(body)) {
    const tools = parsed?.result?.tools;
    if (!Array.isArray(tools)) continue;
    const names = tools.map((tool) => tool?.name);
    if (
      names.some(
        (name) =>
          typeof name !== "string" || !/^[a-z][a-z0-9_]{1,100}$/.test(name),
      ) ||
      new Set(names).size !== names.length
    ) {
      throw new Error("MCP_CATALOG_NAMES_INVALID");
    }
    return {
      names: new Set(names),
      tools: new Map(tools.map((tool) => [tool.name, tool])),
    };
  }
  throw new Error("MCP_CATALOG_TOOLS_MISSING");
}

export function parseToolNames(body) {
  return parseToolCatalog(body).names;
}

// Only verify published, public JSON schemas; do not send authentication,
// credentials, prompts or any tools/call requests. A missing or malformed
// lease-token field is a release blocker, not an invitation to bypass fences.
function criticalError(code, name) {
  const error = new Error(code);
  // Name comes from our static security-critical allowlist, never upstream.
  error.criticalTool = name;
  return error;
}

export function verifyCriticalToolSchemas(catalog) {
  if (!(catalog?.names instanceof Set) || !(catalog?.tools instanceof Map))
    throw new Error("MCP_CATALOG_INCOMPLETE");
  for (const [name, requiredProperties] of Object.entries(
    CRITICAL_TOOL_PROPERTIES,
  )) {
    const tool = catalog.tools.get(name);
    if (!catalog.names.has(name) || !tool)
      throw criticalError("MCP_CRITICAL_TOOL_MISSING", name);
    const schema = tool.inputSchema;
    if (
      !schema ||
      schema.type !== "object" ||
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)
    )
      throw criticalError("MCP_CRITICAL_SCHEMA_MISSING", name);
    for (const property of requiredProperties) {
      if (!Object.hasOwn(schema.properties, property))
        throw criticalError("MCP_CRITICAL_SCHEMA_MISSING", name);
    }
    for (const sensitive of ["leaseToken"]) {
      if (
        requiredProperties.includes(sensitive) &&
        schema.properties[sensitive]?.type !== "string"
      )
        throw criticalError("MCP_CRITICAL_SCHEMA_INVALID", name);
    }
  }
  return true;
}

async function readBounded(response) {
  if (!response.body) throw new Error("MCP_CATALOG_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks = [];
  let count = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("MCP_CATALOG_BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, count).toString("utf8");
}

export async function probeCatalog(
  endpoint,
  request = fetch,
  { withSchemas = false } = {},
) {
  if (!Object.values(ENDPOINTS).includes(endpoint)) {
    throw new Error("MCP_CATALOG_ENDPOINT_DENIED");
  }
  const response = await request(endpoint + "/mcp", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: RPC,
  });
  if (response.status !== 200) throw new Error("MCP_CATALOG_HTTP_NOT_OK");
  const catalog = parseToolCatalog(await readBounded(response));
  return withSchemas ? catalog : catalog.names;
}

// Only a strictly validated SHA is ever reported; anything else is unknown.
export function parseServerCommit(body) {
  for (const parsed of rpcMessages(body)) {
    const info = parsed?.result?.serverInfo;
    if (info && typeof info === "object") {
      return typeof info.commit === "string" && GIT_SHA.test(info.commit)
        ? info.commit
        : null;
    }
  }
  return null;
}

export async function probeServerCommit(endpoint, request = fetch) {
  if (!Object.values(ENDPOINTS).includes(endpoint)) {
    throw new Error("MCP_CATALOG_ENDPOINT_DENIED");
  }
  const response = await request(endpoint + "/mcp", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: INITIALIZE,
  });
  if (response.status !== 200) return null;
  return parseServerCommit(await readBounded(response));
}

// A tool catalog can be identical across commits (e.g. a gateway timeout fix),
// so the catalog check alone cannot prove the live gateway runs current main.
export function compareDeployedCommit(expectedSha, deployed) {
  if (deployed === null) return "unknown";
  if (typeof expectedSha !== "string" || !GIT_SHA.test(expectedSha))
    return "unverified";
  return expectedSha.startsWith(deployed) ? "current" : "stale";
}

// Strict post-cutover assertion (opt-in via EXPECT_DEPLOYED_COMMIT): every
// fixed origin must report exactly the expected commit. "unknown" cannot prove
// anything, so it fails too. Returns the failing labels; empty means PASS.
export function failedCommitAssertions(expectedSha, observed) {
  if (typeof expectedSha !== "string" || !FULL_SHA.test(expectedSha))
    throw new Error("MCP_EXPECTED_COMMIT_INVALID");
  return Object.entries(observed)
    .filter(
      ([, deployed]) =>
        compareDeployedCommit(expectedSha, deployed) !== "current",
    )
    .map(([label]) => label);
}

export function verifyCatalogs(render, production) {
  for (const names of [render, production]) {
    if (!(names instanceof Set) || names.size < MIN_TOOL_COUNT) {
      throw new Error("MCP_CATALOG_INCOMPLETE");
    }
    if (REQUIRED_TOOLS.some((name) => !names.has(name))) {
      throw new Error("MCP_REQUIRED_TOOLS_MISSING");
    }
  }
  return { renderCount: render.size, productionCount: production.size };
}

export async function probeWithWarmup(
  endpoint,
  request = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  { withSchemas = false } = {},
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await probeCatalog(endpoint, request, { withSchemas });
    } catch (error) {
      // A malformed or malicious catalog must never be retried into a PASS.
      const fatal = new Set([
        "MCP_CATALOG_RESPONSE_INVALID",
        "MCP_CATALOG_NAMES_INVALID",
        "MCP_CATALOG_TOOLS_MISSING",
        "MCP_CATALOG_BODY_TOO_LARGE",
        "MCP_CATALOG_ENDPOINT_DENIED",
      ]);
      if (fatal.has(error.message)) throw error;
      if (attempt === 3) {
        throw new Error("MCP_CATALOG_PROBE_UNAVAILABLE");
      }
      await pause(2000 * (attempt + 1));
    }
  }
}

async function main() {
  // Free-tier Render can cold-start; retry transport errors, never schema drift.
  const render = await probeWithWarmup(ENDPOINTS.render, fetch, undefined, {
    withSchemas: true,
  });
  const production = await probeWithWarmup(
    ENDPOINTS.production,
    fetch,
    undefined,
    { withSchemas: true },
  );
  const report = verifyCatalogs(render.names, production.names);
  // Production and Render may differ in optional integrations, but their
  // project-scoped agent collaboration and fenced task lifecycle must agree.
  for (const [origin, catalog] of [
    ["render", render],
    ["production", production],
  ]) {
    try {
      verifyCriticalToolSchemas(catalog);
      console.log(`MCP_CRITICAL_SCHEMA ${origin}=PASS`);
    } catch (error) {
      const tool =
        typeof error.criticalTool === "string" &&
        Object.hasOwn(CRITICAL_TOOL_PROPERTIES, error.criticalTool)
          ? error.criticalTool
          : "unknown";
      const code = [
        "MCP_CRITICAL_TOOL_MISSING",
        "MCP_CRITICAL_SCHEMA_MISSING",
        "MCP_CRITICAL_SCHEMA_INVALID",
        "MCP_CATALOG_INCOMPLETE",
      ].includes(error.message)
        ? error.message
        : "MCP_CATALOG_INCOMPLETE";
      console.error(
        `MCP_CRITICAL_SCHEMA ${origin}=FAIL tool=${tool} code=${code}`,
      );
      throw error;
    }
  }
  console.log(
    "MCP_PUBLIC_CATALOG=PASS render=" +
      report.renderCount +
      " production=" +
      report.productionCount +
      " criticalSchemas=PASS",
  );
  const strictExpected = process.env.EXPECT_DEPLOYED_COMMIT;
  const expected = strictExpected ?? process.env.GITHUB_SHA ?? "";
  const observed = {};
  for (const [label, endpoint] of Object.entries(ENDPOINTS)) {
    let deployed = null;
    try {
      deployed = await probeServerCommit(endpoint);
    } catch {
      deployed = null;
    }
    observed[label] = deployed;
    const state = compareDeployedCommit(expected, deployed);
    console.log(
      `MCP_DEPLOYED_COMMIT ${label}=${deployed ?? "unknown"} state=${state}`,
    );
    if (state === "stale") {
      console.log(
        `::warning title=${label} MCP gateway behind main::serverInfo.commit ${deployed} does not match ${expected}. Identical tool catalogs do not prove identical gateway behavior.`,
      );
    } else if (state === "unknown") {
      console.log(
        `::notice title=${label} MCP gateway commit unknown::serverInfo carries no validated commit. Non-Render deploys should set CODEBRIDGE_SOURCE_COMMIT.`,
      );
    }
  }
  if (strictExpected !== undefined) {
    const failed = failedCommitAssertions(strictExpected, observed);
    console.log(
      "MCP_DEPLOYED_COMMIT_ASSERT=" + (failed.length === 0 ? "PASS" : "FAIL"),
    );
    if (failed.length > 0) throw new Error("MCP_DEPLOYED_COMMIT_MISMATCH");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const known = new Set([
      "MCP_CATALOG_RESPONSE_INVALID",
      "MCP_CATALOG_NAMES_INVALID",
      "MCP_CATALOG_TOOLS_MISSING",
      "MCP_CATALOG_BODY_MISSING",
      "MCP_CATALOG_BODY_TOO_LARGE",
      "MCP_CATALOG_ENDPOINT_DENIED",
      "MCP_CATALOG_HTTP_NOT_OK",
      "MCP_CATALOG_INCOMPLETE",
      "MCP_REQUIRED_TOOLS_MISSING",
      "MCP_CRITICAL_TOOL_MISSING",
      "MCP_CRITICAL_SCHEMA_MISSING",
      "MCP_CRITICAL_SCHEMA_INVALID",
      "MCP_EXPECTED_COMMIT_INVALID",
      "MCP_DEPLOYED_COMMIT_MISMATCH",
    ]);
    const code = known.has(error.message)
      ? error.message
      : "MCP_CATALOG_PROBE_UNAVAILABLE";
    console.error("MCP_PUBLIC_CATALOG=FAIL " + code);
    process.exitCode = 1;
  });
}
