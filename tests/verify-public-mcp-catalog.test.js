import test from "node:test";
import assert from "node:assert/strict";
import {
  CRITICAL_TOOL_PROPERTIES,
  ENDPOINTS,
  REQUIRED_TOOLS,
  compareDeployedCommit,
  failedCommitAssertions,
  parseServerCommit,
  parseToolCatalog,
  parseToolNames,
  probeCatalog,
  probeServerCommit,
  probeWithWarmup,
  verifyCatalogs,
  verifyCriticalToolSchemas,
  verifyCriticalSchemaParity,
} from "../scripts/verify-public-mcp-catalog.mjs";

const validNames = () =>
  new Set([
    ...REQUIRED_TOOLS,
    ...Array.from({ length: 90 }, (_, index) => "mock_tool_" + index),
  ]);
const body = (names) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [...names].map((name) => ({ name })) },
  });

// Production may expose fewer optional GitHub tools than Render, but critical
// project-scoped and lease-fenced MCP contracts must be identical.
const criticalBody = (overrides = {}) => {
  const tools = [
    ...new Set([...validNames(), ...Object.keys(CRITICAL_TOOL_PROPERTIES)]),
  ].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        (CRITICAL_TOOL_PROPERTIES[name] ?? []).map((key) => [
          key,
          { type: "string" },
        ]),
      ),
    },
  }));
  return bodyResponse(
    tools.map((tool) => ({
      ...tool,
      ...(overrides[tool.name] ?? {}),
    })),
  );
};
const bodyResponse = (tools) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });

test("critical tool schemas and lease-token fields are mandatory on each MCP origin", async () => {
  const catalog = parseToolCatalog(criticalBody());
  assert.equal(verifyCriticalToolSchemas(catalog), true);
  assert.ok(catalog.names.has("coordination_post"));
  assert.ok(catalog.names.has("coordination_list"));

  const requests = [];
  const detail = await probeCatalog(
    ENDPOINTS.production,
    async (url, options) => {
      requests.push({ url, options });
      return new Response(criticalBody(), { status: 200 });
    },
    { withSchemas: true },
  );
  assert.equal(verifyCriticalToolSchemas(detail), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://kmjtechno.com/mcp");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.match(requests[0].options.body, /"method":"tools\/list"/);
});

test("a high tool count cannot hide missing agent coordination features", () => {
  const good = parseToolCatalog(criticalBody());
  good.names.delete("coordination_post");
  good.tools.delete("coordination_post");
  assert.throws(
    () => verifyCriticalToolSchemas(good),
    (error) =>
      error.message === "MCP_CRITICAL_TOOL_MISSING" &&
      error.criticalTool === "coordination_post",
  );
});

test("critical input schemas match even if JSON property key order differs", () => {
  const render = parseToolCatalog(criticalBody());
  const production = parseToolCatalog(criticalBody());
  const a = render.tools.get("autopilot_complete").inputSchema;
  const b = production.tools.get("autopilot_complete").inputSchema;
  a.properties.leaseToken = { type: "string", format: "uuid" };
  b.properties.leaseToken = { format: "uuid", type: "string" };
  a.required = ["task", "device"];
  b.required = ["device", "task"];
  a.additionalProperties = false;
  b.additionalProperties = false;
  assert.equal(verifyCriticalSchemaParity(render, production), true);
  production.tools.set("unrelated_optional_tool", {
    name: "unrelated_optional_tool",
    inputSchema: { type: "object", properties: {} },
  });
  production.names.add("unrelated_optional_tool");
  assert.equal(verifyCriticalSchemaParity(render, production), true);
});

test("critical leaseToken format drift fails the cross-origin gate", () => {
  const render = parseToolCatalog(criticalBody());
  const production = parseToolCatalog(criticalBody());
  render.tools.get("autopilot_complete").inputSchema.properties.leaseToken = {
    type: "string",
    format: "uuid",
  };
  production.tools.get("autopilot_complete").inputSchema.properties.leaseToken =
    {
      type: "string",
    };
  assert.throws(
    () => verifyCriticalSchemaParity(render, production),
    (error) =>
      error.message === "MCP_CRITICAL_SCHEMA_DRIFT" &&
      error.criticalTool === "autopilot_complete",
  );
});

test("critical requiredness and object closure drift fail safely", () => {
  const render = parseToolCatalog(criticalBody());
  const production = parseToolCatalog(criticalBody());
  render.tools.get("autopilot_wait").inputSchema.required = [
    "device",
    "project",
    "task",
  ];
  production.tools.get("autopilot_wait").inputSchema.required = [
    "device",
    "project",
    "task",
    "leaseToken",
  ];
  assert.throws(
    () => verifyCriticalSchemaParity(render, production),
    /MCP_CRITICAL_SCHEMA_DRIFT/,
  );
  production.tools.get("autopilot_wait").inputSchema.required = [
    "task",
    "project",
    "device",
  ];
  render.tools.get("coordination_post").inputSchema.additionalProperties =
    false;
  assert.throws(
    () => verifyCriticalSchemaParity(render, production),
    (error) =>
      error.message === "MCP_CRITICAL_SCHEMA_DRIFT" &&
      error.criticalTool === "coordination_post",
  );
});

test("malformed critical required properties cannot report parity", () => {
  const render = parseToolCatalog(criticalBody());
  const production = parseToolCatalog(criticalBody());
  render.tools.get("autopilot_checkpoint").inputSchema.required = "leaseToken";
  assert.throws(
    () => verifyCriticalSchemaParity(render, production),
    /MCP_CRITICAL_SCHEMA_DRIFT/,
  );
});

test("autopilot leaseToken schemas fail closed when absent or incorrectly typed", () => {
  for (const property of [
    "autopilot_checkpoint",
    "autopilot_wait",
    "autopilot_complete",
  ]) {
    const absent = parseToolCatalog(criticalBody());
    delete absent.tools.get(property).inputSchema.properties.leaseToken;
    assert.throws(
      () => verifyCriticalToolSchemas(absent),
      /MCP_CRITICAL_SCHEMA_MISSING/,
    );
    const wrong = parseToolCatalog(criticalBody());
    wrong.tools.get(property).inputSchema.properties.leaseToken = {
      type: "number",
    };
    assert.throws(
      () => verifyCriticalToolSchemas(wrong),
      /MCP_CRITICAL_SCHEMA_INVALID/,
    );
  }
});

test("critical schema validator rejects missing and malformed objects", () => {
  const missing = parseToolCatalog(
    criticalBody({ coordination_list: { inputSchema: null } }),
  );
  assert.throws(
    () => verifyCriticalToolSchemas(missing),
    /MCP_CRITICAL_SCHEMA_MISSING/,
  );
  assert.throws(
    () =>
      verifyCriticalToolSchemas(new Set(Object.keys(CRITICAL_TOOL_PROPERTIES))),
    /MCP_CATALOG_INCOMPLETE/,
  );
});

test("public MCP catalogs accept valid JSON and streaming SSE responses", () => {
  const names = validNames();
  assert.deepEqual(parseToolNames(body(names)), names);
  const sse = "event: message\ndata: " + body(names) + "\n\n";
  assert.deepEqual(parseToolNames(sse), names);
  assert.deepEqual(verifyCatalogs(names, names), {
    renderCount: 103,
    productionCount: 103,
  });
});

test("known 101-versus-88 production drift fails closed", () => {
  const render = validNames();
  const production = new Set(
    [...render].filter((name) => !REQUIRED_TOOLS.includes(name)),
  );
  assert.equal(production.size, 90);
  assert.throws(
    () => verifyCatalogs(render, production),
    /MCP_CATALOG_INCOMPLETE/,
  );
  const incompleteButLarge = new Set(
    [...render].filter((name) => name !== "local_model_generate"),
  );
  assert.equal(incompleteButLarge.size, 102);
  assert.throws(
    () => verifyCatalogs(render, incompleteButLarge),
    /MCP_REQUIRED_TOOLS_MISSING/,
  );
});

test("malformed, duplicate and missing RPC catalogs never pass", () => {
  assert.throws(
    () => parseToolNames('{"error":"unauthorized"}'),
    /MCP_CATALOG_TOOLS_MISSING/,
  );
  assert.throws(
    () => parseToolNames(body(["local_model_status", "local_model_status"])),
    /MCP_CATALOG_NAMES_INVALID/,
  );
  assert.throws(
    () => parseToolNames(body(["bad tool name"])),
    /MCP_CATALOG_NAMES_INVALID/,
  );
  assert.throws(
    () => parseToolNames("x".repeat(1024 * 1024 + 1)),
    /MCP_CATALOG_RESPONSE_INVALID/,
  );
});

test("public discovery uses only fixed OAuth-free origins and no tools/call", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return new Response(body(validNames()), { status: 200 });
  };
  const names = await probeCatalog(ENDPOINTS.production, request);
  assert.equal(names.size, 103);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://kmjtechno.com/mcp");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.match(calls[0].options.body, /"method":"tools\/list"/);
  assert.doesNotMatch(calls[0].options.body, /tools\/call/);
  await assert.rejects(
    probeCatalog("https://unapproved.example", request),
    /MCP_CATALOG_ENDPOINT_DENIED/,
  );
  assert.equal(calls.length, 1);
});

test("non-200 and oversized streamed responses fail without echoing secrets", async () => {
  await assert.rejects(
    probeCatalog(
      ENDPOINTS.render,
      async () => new Response("private body", { status: 401 }),
    ),
    /MCP_CATALOG_HTTP_NOT_OK/,
  );
  await assert.rejects(
    probeCatalog(
      ENDPOINTS.render,
      async () => new Response("x".repeat(1024 * 1024 + 12)),
    ),
    /MCP_CATALOG_BODY_TOO_LARGE/,
  );
});

test("bounded cold-start transport retries never conceal malformed catalogs", async () => {
  const pauses = [];
  let calls = 0;
  const mockRequest = async () => {
    calls++;
    if (calls === 1) return new Response("starting", { status: 503 });
    return new Response(body(validNames()), { status: 200 });
  };
  const names = await probeWithWarmup(
    ENDPOINTS.render,
    mockRequest,
    async (ms) => pauses.push(ms),
  );
  assert.equal(names.size, 103);
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [2000]);

  let malformedCalls = 0;
  await assert.rejects(
    probeWithWarmup(
      ENDPOINTS.production,
      async () => {
        malformedCalls++;
        return new Response("not an MCP catalog", { status: 200 });
      },
      async () => {
        throw new Error("RETRY_NOT_ALLOWED");
      },
    ),
    /MCP_CATALOG_TOOLS_MISSING/,
  );
  assert.equal(malformedCalls, 1);

  let attempts = 0;
  const boundedPauses = [];
  await assert.rejects(
    probeWithWarmup(
      ENDPOINTS.render,
      async () => {
        attempts++;
        return new Response("service unavailable", { status: 503 });
      },
      async (ms) => boundedPauses.push(ms),
    ),
    /MCP_CATALOG_PROBE_UNAVAILABLE/,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(boundedPauses, [2000, 4000, 6000]);
});

const initialized = (serverInfo) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo },
  });

test("deployed commit is read only from validated public initialize serverInfo", () => {
  const sha = "f".repeat(40);
  assert.equal(
    parseServerCommit(initialized({ name: "kmj-codebridge", commit: sha })),
    sha,
  );
  assert.equal(
    parseServerCommit(
      "event: message\ndata: " +
        initialized({ name: "kmj-codebridge", commit: "39bc227" }),
    ),
    "39bc227",
  );
  // A gateway without the marker, or with a hostile value, is unknown.
  assert.equal(
    parseServerCommit(initialized({ name: "kmj-codebridge" })),
    null,
  );
  assert.equal(
    parseServerCommit(initialized({ commit: "<script>alert(1)</script>" })),
    null,
  );
  assert.equal(parseServerCommit("not json"), null);
  assert.throws(
    () => parseServerCommit("x".repeat(1024 * 1024 + 1)),
    /MCP_CATALOG_RESPONSE_INVALID/,
  );
});

test("identical catalogs from an older gateway commit are reported stale, never current", () => {
  const main = "ff11bb79b2faa14dd0a4c9bda9176f968e3fba60";
  assert.equal(compareDeployedCommit(main, main), "current");
  assert.equal(compareDeployedCommit(main, "ff11bb7"), "current");
  assert.equal(
    compareDeployedCommit(main, "055fd88ebfd56125abbe2bcec8f99819ed54ae80"),
    "stale",
  );
  assert.equal(compareDeployedCommit(main, null), "unknown");
  assert.equal(compareDeployedCommit("", main), "unverified");
});

test("commit probe uses fixed origins, public initialize only and no credentials", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return new Response(initialized({ commit: "a".repeat(40) }), {
      status: 200,
    });
  };
  assert.equal(
    await probeServerCommit(ENDPOINTS.production, request),
    "a".repeat(40),
  );
  assert.equal(calls[0].url, "https://kmjtechno.com/mcp");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.match(calls[0].options.body, /"method":"initialize"/);
  assert.doesNotMatch(calls[0].options.body, /tools\/call/);
  await assert.rejects(
    probeServerCommit("https://unapproved.example", request),
    /MCP_CATALOG_ENDPOINT_DENIED/,
  );
  const unavailable = async () => new Response("", { status: 503 });
  assert.equal(await probeServerCommit(ENDPOINTS.render, unavailable), null);
});

test("strict post-cutover assertion needs every origin on the exact expected commit", () => {
  const want = "e83167161da9c742bfe92317b56f32758eded48b";
  assert.deepEqual(
    failedCommitAssertions(want, { render: want, production: want }),
    [],
  );
  // A short deployed prefix of the expected commit is accepted.
  assert.deepEqual(
    failedCommitAssertions(want, { render: "e831671", production: want }),
    [],
  );
  // Stale, unknown and unrelated commits all fail; unknown proves nothing.
  assert.deepEqual(
    failedCommitAssertions(want, {
      render: "055fd88ebfd56125abbe2bcec8f99819ed54ae80",
      production: null,
    }),
    ["render", "production"],
  );
  assert.deepEqual(
    failedCommitAssertions(want, { render: want, production: "055fd88" }),
    ["production"],
  );
  // The expectation itself must be a full lowercase SHA.
  for (const bad of [
    "",
    "main",
    "E83167161DA9C742BFE92317B56F32758EDED48B",
    "e831671",
  ])
    assert.throws(
      () => failedCommitAssertions(bad, { render: want }),
      /MCP_EXPECTED_COMMIT_INVALID/,
    );
});
