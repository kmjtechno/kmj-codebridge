// OpenAI / ChatGPT integration package. Output layout is unchanged from the
// original packager: <base>/kmj-codebridge/{plugin.json,skills/,mcp.json} plus
// <base>/kmj-codebridge.tar.gz. The skill and core metadata come from the
// canonical `plugin/` source shared with every other client.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseArgs,
  prepareOutput,
  root,
  validateEndpoint,
  writeJson,
} from "./package-common.js";
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.auth) throw Error("Unknown option --auth.");
  const url = validateEndpoint(options.endpoint);
  const base = prepareOutput(options.out, "kmj-codebridge");
  const out = path.join(base, "kmj-codebridge");
  fs.cpSync(path.join(root, "plugin"), out, { recursive: true });
  // The public/submission package uses the hosted remote MCP endpoint.
  // Desktop-only local bridge code stays in the repository marketplace package.
  fs.rmSync(path.join(out, "desktop"), { recursive: true, force: true });
  writeJson(path.join(out, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { codebridge: { type: "streamable-http", url: url.href } },
  });
  execFileSync("tar", [
    "-czf",
    path.join(base, "kmj-codebridge.tar.gz"),
    "-C",
    base,
    "kmj-codebridge",
  ]);
  console.log(
    `Created ${path.relative(process.cwd(), path.join(base, "kmj-codebridge.tar.gz")) || "kmj-codebridge.tar.gz"}. Packaging does not validate reachability or publish the plugin.`,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
