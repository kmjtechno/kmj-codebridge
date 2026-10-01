#!/usr/bin/env node
import { validateEndpoint } from "./package-common.js";

function usage() {
  console.error(
    "Usage: node scripts/client-config.js <https://host/mcp> [--format generic|mcp-json|claude-json]",
  );
  process.exit(2);
}

try {
  const args = process.argv.slice(2);
  const endpoint = args.shift();
  let format = "generic";
  while (args.length) {
    const flag = args.shift();
    if (flag === "--format") {
      format = args.shift();
      if (!format) usage();
    } else usage();
  }
  const url = validateEndpoint(endpoint).href;
  if (!["generic", "mcp-json", "claude-json"].includes(format))
    throw Error("Unsupported format.");

  if (format === "generic") {
    console.log(
      JSON.stringify(
        {
          name: "kmj-codebridge",
          transport: "streamable-http",
          url,
          authentication: "oauth",
          note: "Use the client MCP OAuth flow; do not put bearer tokens in config.",
        },
        null,
        2,
      ),
    );
  } else if (format === "mcp-json") {
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "kmj-codebridge": { type: "streamable-http", url },
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            "kmj-codebridge": { type: "http", url },
          },
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
