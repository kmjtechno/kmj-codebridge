// Claude Code integration package, following the Claude Code plugin and
// marketplace references (https://code.claude.com/docs/en/plugins-reference,
// https://code.claude.com/docs/en/plugins/marketplace-reference).
//
// Output (<base> is dist/claude-code by default):
//   <base>/.claude-plugin/marketplace.json      local marketplace
//   <base>/kmj-codebridge/.claude-plugin/plugin.json
//   <base>/kmj-codebridge/.mcp.json             remote Streamable HTTP server
//   <base>/kmj-codebridge/skills/codebridge/SKILL.md  canonical skill copy
//   <base>/../kmj-codebridge-claude-code.tar.gz (default location only)
//
// The MCP server is the same gateway every client uses. Authentication:
//   --auth oauth (default): no credential in the package; Claude Code runs the
//     MCP OAuth flow against the gateway's protected-resource metadata.
//   --auth bearer-env: developer-preview gateways without OAuth. The header
//     references ${KMJ_CODEBRIDGE_TOKEN}, expanded by Claude Code from the
//     user's environment; no token is ever written into the package.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseArgs,
  prepareOutput,
  readCanonical,
  root,
  validateEndpoint,
  writeClaudeMarketplace,
  writeClaudePlugin,
} from "./package-common.js";

const TOKEN_ENV = "KMJ_CODEBRIDGE_TOKEN";

try {
  const options = parseArgs(process.argv.slice(2));
  const auth = options.auth ?? "oauth";
  if (!["oauth", "bearer-env"].includes(auth))
    throw Error("--auth must be oauth or bearer-env.");
  const url = validateEndpoint(options.endpoint);
  const meta = readCanonical();
  const base = options.out
    ? prepareOutput(options.out, "claude-code")
    : path.join(prepareOutput(undefined, "claude-code"), "claude-code");
  fs.mkdirSync(base, { recursive: true });
  const pluginDir = path.join(base, meta.name);

  const server = { type: "http", url: url.href };
  if (auth === "bearer-env")
    server.headers = { Authorization: `Bearer \${${TOKEN_ENV}}` };
  writeClaudePlugin(pluginDir, meta, server);
  writeClaudeMarketplace(base, meta, `./${meta.name}`);

  let archive = "";
  if (!options.out) {
    archive = path.join(root, "dist", "kmj-codebridge-claude-code.tar.gz");
    fs.rmSync(archive, { force: true });
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      path.dirname(base),
      path.basename(base),
    ]);
  }
  console.log(
    `Created Claude Code marketplace at ${path.relative(process.cwd(), base) || "."}` +
      (archive ? ` and ${path.relative(process.cwd(), archive)}` : "") +
      `. Auth mode: ${auth}. Packaging does not validate reachability or publish the plugin.`,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
