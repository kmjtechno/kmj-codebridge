#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ENDPOINTS = Object.freeze({
  render: "https://kmj-codebridge-gateway.onrender.com/mcp",
  production: "https://kmjtechno.com/mcp",
});

export const REQUIRED_LOCAL_TOOLS = Object.freeze([
  "local_model_status",
  "local_model_generate",
  "autopilot_local_draft",
]);

export function catalogFromResponse(raw) {
  if (typeof raw !== "string" || raw.length > 2_097_152)
    throw new Error("CATALOG_RESPONSE_INVALID");

  const candidates = [raw];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:"))
      candidates.push(line.slice(5).trim());
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      const tools = value?.result?.tools;
      if (!Array.isArray(tools)) continue;
      if (
        tools.length < 1 ||
        tools.length > 250 ||
        tools.some(
          (tool) =>
            typeof tool?.name !== "string" ||
            !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.name),
        )
      )
        throw new Error("CATALOG_TOOLS_INVALID");
      const names = tools.map((tool) => tool.name);
      if (new Set(names).size !== names.length)
        throw new Error("CATALOG_DUPLICATE_TOOL");
      return {
        count: names.length,
        missing: REQUIRED_LOCAL_TOOLS.filter((name) => !names.includes(name)),
        // Deterministic name-only checksum; never hash bearer tokens or response content.
        nameSha256: createHash("sha256")
          .update([...names].sort().join("\n"))
          .digest("hex"),
      };
    } catch (error) {
      if (error.message?.startsWith("CATALOG_")) throw error;
    }
  }
  throw new Error("CATALOG_TOOLS_LIST_NOT_RECEIVED");
}

export async function probeCatalog(target, fetchImpl = fetch) {
  if (!Object.hasOwn(ENDPOINTS, target))
    throw new Error("CATALOG_TARGET_NOT_ALLOWED");
  const response = await fetchImpl(ENDPOINTS[target], {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200)
    throw new Error(`CATALOG_HTTP_${response.status}`);
  const reportedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(reportedLength) && reportedLength > 2_097_152)
    throw new Error("CATALOG_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CATALOG_RESPONSE_INVALID");
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2_097_152) throw new Error("CATALOG_RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const catalog = catalogFromResponse(raw);
  return {
    target,
    ...catalog,
    status: catalog.missing.length === 0 ? "PASS" : "FAIL",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const result = await probeCatalog(process.argv[2]);
    console.log(JSON.stringify(result));
    if (result.status !== "PASS") process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify({
        target: process.argv[2] ?? null,
        status: "BLOCKED",
        code:
          typeof error?.message === "string" &&
          /^CATALOG_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "CATALOG_TRANSPORT_FAILED",
      }),
    );
    process.exitCode = 2;
  }
}
