import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
try {
  const raw = process.argv[2];
  if (!raw)
    throw Error("Supply a real approved HTTPS MCP endpoint ending in /mcp.");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp"
  )
    throw Error("Endpoint must be credential-free HTTPS /mcp.");
  const out = path.resolve("dist/kmj-codebridge");
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync("plugin", out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "mcp.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { codebridge: { type: "streamable-http", url: url.href } },
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync("tar", [
    "-czf",
    path.resolve("dist/kmj-codebridge.tar.gz"),
    "-C",
    path.resolve("dist"),
    "kmj-codebridge",
  ]);
  console.log(
    "Created dist/kmj-codebridge.tar.gz. Packaging does not validate reachability or publish the plugin.",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
