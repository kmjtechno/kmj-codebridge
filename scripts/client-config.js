#!/usr/bin/env node
import { validateEndpoint } from "./package-common.js";

const FORMATS = [
  "generic",
  "mcp-json",
  "claude-json",
  "claude-cli",
  "vscode-json",
  "vscode-install-url",
  "vscode-insiders-install-url",
  "cursor-json",
  "windsurf-json",
  "gemini-json",
  "gemini-cli",
  "copilot-json",
  "copilot-cli",
  "jetbrains-json",
  "codex-toml",
  "codex-cli",
];

function usage() {
  console.error(
    "Usage: node scripts/client-config.js <https://host/mcp> [--format " +
      FORMATS.join("|") +
      "]",
  );
  process.exit(2);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
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
  if (!FORMATS.includes(format)) throw Error("Unsupported format.");

  const portableHttp = {
    mcpServers: {
      "kmj-codebridge": { type: "http", url },
    },
  };

  switch (format) {
    case "generic":
      printJson({
        name: "kmj-codebridge",
        transport: "streamable-http",
        url,
        authentication: "oauth",
        note: "Use the client MCP OAuth flow; do not put bearer tokens in config.",
      });
      break;

    case "mcp-json":
    case "claude-json":
      printJson(portableHttp);
      break;

    case "claude-cli":
      console.log(
        `claude mcp add --transport http --scope user kmj-codebridge ${shellQuote(url)}`,
      );
      break;

    case "vscode-json":
      printJson({
        servers: {
          "kmj-codebridge": { type: "http", url },
        },
      });
      break;

    case "vscode-install-url":
    case "vscode-insiders-install-url": {
      const scheme =
        format === "vscode-insiders-install-url" ? "vscode-insiders" : "vscode";
      // VS Code's registered URI handler requires the single server object,
      // not a full { servers: ... } config. VS Code owns confirmation/consent.
      const payload = JSON.stringify({
        name: "kmj-codebridge",
        type: "http",
        url,
      });
      console.log(`${scheme}:mcp/install?${encodeURIComponent(payload)}`);
      break;
    }

    case "cursor-json":
      printJson({
        mcpServers: {
          "kmj-codebridge": { url },
        },
      });
      break;

    case "windsurf-json":
      printJson({
        mcpServers: {
          "kmj-codebridge": { serverUrl: url },
        },
      });
      break;

    case "gemini-json":
      printJson({
        mcpServers: {
          "kmj-codebridge": { httpUrl: url },
        },
      });
      break;

    case "gemini-cli":
      console.log(
        `gemini mcp add --transport http kmj-codebridge ${shellQuote(url)}`,
      );
      break;

    case "copilot-json":
      printJson({
        mcpServers: {
          "kmj-codebridge": {
            type: "http",
            url,
            tools: ["*"],
          },
        },
      });
      break;

    case "copilot-cli":
      console.log(
        `copilot mcp add --transport http --tools '*' kmj-codebridge ${shellQuote(url)}`,
      );
      break;

    case "jetbrains-json":
      printJson({
        mcpServers: {
          "kmj-codebridge": { url },
        },
      });
      break;

    case "codex-toml":
      console.log(
        [
          '[mcp_servers."kmj-codebridge"]',
          `url = ${JSON.stringify(url)}`,
          'auth = "oauth"',
          'default_tools_approval_mode = "writes"',
        ].join("\n"),
      );
      break;

    case "codex-cli":
      console.log(`codex mcp add kmj-codebridge --url ${shellQuote(url)}`);
      console.log("codex mcp login kmj-codebridge");
      break;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
