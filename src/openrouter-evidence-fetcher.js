// Trusted-device fetcher for the two OpenRouter reads the zero-cost verifier needs:
// GET /api/v1/key (account spend/quota) and GET /api/v1/models (published prices).
// The owner's OpenRouter key is passed in by trusted device code (never chat/MCP),
// is sent only to openrouter.ai over HTTPS, follows no redirects, and never appears
// in an error. Not imported by anything yet, so it enables nothing by itself.
import https from "node:https";

const HOST = "openrouter.ai";
const KEY = /^[A-Za-z0-9._-]{16,200}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const coded = (code) => Object.assign(new Error(code), { code });

function httpsGet({ path, apiKey, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        method: "GET",
        path,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) req.destroy(coded("OPENROUTER_TOO_LARGE"));
          else chunks.push(c);
        });
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(coded(`OPENROUTER_HTTP_${res.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(coded("OPENROUTER_BAD_RESPONSE"));
          }
        });
        res.on("error", () => reject(coded("OPENROUTER_NETWORK")));
      },
    );
    req.on("timeout", () => req.destroy(coded("OPENROUTER_TIMEOUT")));
    req.on("error", (e) =>
      reject(
        e?.code?.startsWith?.("OPENROUTER_") ? e : coded("OPENROUTER_NETWORK"),
      ),
    );
    req.end();
  });
}

export function createOpenRouterEvidenceFetcher({
  apiKey,
  request = httpsGet,
} = {}) {
  if (typeof apiKey !== "string" || !KEY.test(apiKey))
    throw coded("OPENROUTER_KEY_NOT_CONFIGURED");
  const get = (path, maxBytes) =>
    request({ path, apiKey, timeoutMs: TIMEOUT_MS, maxBytes });
  return {
    fetchOpenRouterKey: () => get("/api/v1/key", 65536),
    fetchOpenRouterModels: () => get("/api/v1/models", MAX_BYTES),
  };
}
