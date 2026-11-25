import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { httpRequest } from "../src/freellmapi-client.js";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    port: server.address().port,
    method: "GET",
    path: "/v1/models",
    apiKey: "synthetic-test-key",
    timeoutMs: 1500,
  };
}

test("trickling response cannot extend the absolute request deadline", async (t) => {
  const request = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":[');
    const interval = setInterval(() => res.write(" "), 15);
    res.on("close", () => clearInterval(interval));
  });
  await assert.rejects(httpRequest({ ...request, timeoutMs: 150 }), {
    message: "FREELLMAPI_TIMEOUT",
  });
});

test("truncated 429 is ambiguous and must not trigger quota fallback", async (t) => {
  const request = await fixture(t, (_req, res) => {
    res.writeHead(429, { "content-length": 100 });
    res.write("partial", () => res.destroy());
  });
  await assert.rejects(httpRequest(request), {
    message: "FREELLMAPI_INCOMPLETE_RESPONSE",
  });
});

test("complete responses and explicit quota refusals retain their behavior", async (t) => {
  const request = await fixture(t, (req, res) => {
    if (req.url === "/quota") {
      res.writeHead(429);
      res.end("{}");
      return;
    }
    res.end('{"data":[]}');
  });
  assert.deepEqual(await httpRequest(request), { data: [] });
  await assert.rejects(httpRequest({ ...request, path: "/quota" }), {
    message: "FREELLMAPI_QUOTA_EXHAUSTED",
  });
});
