import test from "node:test";
import assert from "node:assert/strict";
import {
  ENDPOINTS,
  REQUIRED_TOOLS,
  compareDeployedCommit,
  parseServerCommit,
  parseToolNames,
  probeCatalog,
  probeServerCommit,
  probeWithWarmup,
  verifyCatalogs,
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
