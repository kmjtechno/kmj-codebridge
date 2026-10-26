import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  verifyBrowsenticEntry,
  observeWithReadOnlyCalls,
  browsenticChildEnvironment,
} from "../src/browser-agentic.js";

export async function inspectOwnerBrowser(target, sha256, factory) {
  if (target !== "kmj_owner_browser") throw Error("BROWSENTIC_TARGET_BLOCKED");
  // The CLI is a separately reviewed operator-installed fixed-version package.
  // No npx, remote installer, arbitrary executable, shell, URL or user args.
  const entry = verifyBrowsenticEntry(sha256);
  const create =
    factory ??
    (async () => {
      const client = new Client(
        { name: "kmj-codebridge-readonly", version: "0.3.2" },
        { capabilities: {} },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry, "mcp"],
        env: browsenticChildEnvironment(),
        stderr: "pipe",
      });
      await client.connect(transport);
      return client;
    });
  let client;
  try {
    client = await create();
    return await observeWithReadOnlyCalls((name, args) =>
      client.callTool({ name, arguments: args }),
    );
  } finally {
    if (client) await client.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4) throw Error("BROWSENTIC_ARGUMENTS_INVALID");
    const result = await inspectOwnerBrowser(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never print upstream errors or browser text into CodeBridge job logs.
    const allowed = new Set([
      "BROWSENTIC_TARGET_BLOCKED",
      "BROWSENTIC_PIN_UNVERIFIED",
      "BROWSENTIC_ORIGIN_BLOCKED",
      "BROWSENTIC_TAB_CHANGED",
      "BROWSENTIC_MCP_RESULT_INVALID",
      "BROWSENTIC_ARGUMENTS_INVALID",
    ]);
    console.error(
      allowed.has(error?.message) ? error.message : "BROWSENTIC_NOT_READY",
    );
    process.exitCode = 2;
  }
}
