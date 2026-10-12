import test from "node:test";
import assert from "node:assert/strict";
import {
  ENDPOINTS,
  REQUIRED_LOCAL_TOOLS,
  catalogFromResponse,
  probeCatalog,
} from "../scripts/probe-live-mcp-catalog.mjs";

const allTools = [
  { name: "inspect_project" },
  ...REQUIRED_LOCAL_TOOLS.map((name) => ({ name })),
];
const json = (tools) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });

test("read-only public MCP catalog parses standard JSON and SSE", () => {
  const plain = catalogFromResponse(json(allTools));
  const sse = catalogFromResponse(
    `event: message\ndata: ${json(allTools)}\n\n`,
  );
  assert.deepEqual(plain, sse);
  assert.equal(plain.count, allTools.length);
  assert.deepEqual(plain.missing, []);
  assert.match(plain.nameSha256, /^[a-f0-9]{64}$/);
});

test("absent local AI tools are an explicit failure, never a false green", () => {
  const catalog = catalogFromResponse(json([{ name: "inspect_project" }]));
  assert.deepEqual(catalog.missing, [...REQUIRED_LOCAL_TOOLS]);
  assert.throws(
    () => catalogFromResponse("event: message\ndata: {}"),
    /CATALOG_TOOLS_LIST_NOT_RECEIVED/,
  );
  assert.throws(
    () => catalogFromResponse(json([{ name: "x" }, { name: "x" }])),
    /CATALOG_DUPLICATE_TOOL/,
  );
});

test("fixed endpoints, no auth headers, no tools/call and no local inference", async () => {
  const captures = [];
  const fetchImpl = async (url, options) => {
    captures.push({ url, options });
    return {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(json(allTools)));
          controller.close();
        },
      }),
    };
  };
  for (const target of ["render", "production"]) {
    const response = await probeCatalog(target, fetchImpl);
    assert.equal(response.status, "PASS");
    assert.equal(response.target, target);
  }
  assert.deepEqual(
    captures.map((x) => x.url),
    [ENDPOINTS.render, ENDPOINTS.production],
  );
  for (const { options } of captures) {
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(JSON.parse(options.body).method, "tools/list");
  }
  await assert.rejects(
    probeCatalog("https://other.example/mcp", fetchImpl),
    /CATALOG_TARGET_NOT_ALLOWED/,
  );
  assert.equal(captures.length, 2);
});

test("non-200 response fails without echoing body or requesting credentials", async () => {
  await assert.rejects(
    probeCatalog("render", async () => ({
      status: 401,
      headers: { get: () => null },
    })),
    /CATALOG_HTTP_401/,
  );
});
