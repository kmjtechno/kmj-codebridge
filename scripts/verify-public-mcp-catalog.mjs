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

export function parseToolNames(body) {
  if (typeof body !== "string" || body.length > MAX_RESPONSE_BYTES) {
    throw new Error("MCP_CATALOG_RESPONSE_INVALID");
  }
  const lines = body.split(/\r?\n/);
  const candidates = [
    body.trim(),
    ...lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()),
  ];
  for (const value of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
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
    return new Set(names);
  }
  throw new Error("MCP_CATALOG_TOOLS_MISSING");
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

export async function probeCatalog(endpoint, request = fetch) {
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
  return parseToolNames(await readBounded(response));
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

async function main() {
  const render = await probeCatalog(ENDPOINTS.render);
  const production = await probeCatalog(ENDPOINTS.production);
  const report = verifyCatalogs(render, production);
  console.log(
    "MCP_PUBLIC_CATALOG=PASS render=" +
      report.renderCount +
      " production=" +
      report.productionCount,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
    ]);
    const code = known.has(error.message)
      ? error.message
      : "MCP_CATALOG_PROBE_UNAVAILABLE";
    console.error("MCP_PUBLIC_CATALOG=FAIL " + code);
    process.exitCode = 1;
  });
}
