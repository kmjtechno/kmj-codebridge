import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createOpenRouterEvidenceFetcher } from "../src/openrouter-evidence-fetcher.js";

const KEY = "sk-or-v1-" + "a".repeat(24);

test("fixed host paths, bearer key passed only to the request function", async () => {
  const calls = [];
  const f = createOpenRouterEvidenceFetcher({
    apiKey: KEY,
    request: async (o) => {
      calls.push(o);
      return { data: [] };
    },
  });
  await f.fetchOpenRouterKey();
  await f.fetchOpenRouterModels();
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/v1/key", "/api/v1/models"],
  );
  assert.ok(calls.every((c) => c.apiKey === KEY && c.timeoutMs === 10000));
  assert.ok(calls[0].maxBytes <= 65536 && calls[1].maxBytes <= 8 * 1024 * 1024);
});

test("missing or malformed key fails closed without echoing the value", () => {
  for (const bad of [undefined, "", "short", "has space key 123456789012", 5]) {
    assert.throws(() => createOpenRouterEvidenceFetcher({ apiKey: bad }), {
      code: "OPENROUTER_KEY_NOT_CONFIGURED",
    });
  }
  try {
    createOpenRouterEvidenceFetcher({ apiKey: "bad key" });
  } catch (e) {
    assert.ok(!String(e.message).includes("bad key"));
  }
});

test("request errors pass through as stable codes, never containing the key", async () => {
  const f = createOpenRouterEvidenceFetcher({
    apiKey: KEY,
    request: async () => {
      throw Object.assign(new Error("OPENROUTER_HTTP_402"), {
        code: "OPENROUTER_HTTP_402",
      });
    },
  });
  await assert.rejects(f.fetchOpenRouterKey(), (e) => {
    assert.equal(e.code, "OPENROUTER_HTTP_402");
    assert.ok(!JSON.stringify(e).includes(KEY) && !e.message.includes(KEY));
    return true;
  });
});

test("module is hard-pinned to openrouter.ai, reads no env/files, follows no redirects, and is unwired", () => {
  const text = fs
    .readFileSync("src/openrouter-evidence-fetcher.js", "utf8")
    .replace(/\/\/.*$/gm, "");
  assert.match(text, /HOST = "openrouter\.ai"/);
  assert.ok(!/process\.env|readFile|child_process|http:\/\//.test(text));
  assert.ok(!/location|redirect/i.test(text));
  const importers = fs
    .readdirSync("src")
    .filter((f) => f.endsWith(".js") && f !== "openrouter-evidence-fetcher.js")
    .filter((f) =>
      /openrouter-evidence-fetcher/.test(
        fs.readFileSync(path.join("src", f), "utf8"),
      ),
    );
  assert.deepEqual(importers, []);
});
