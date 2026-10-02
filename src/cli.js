#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { startGateway } from "./gateway.js";
import { startAgent } from "./agent.js";
const version = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const [mode, file] = process.argv.slice(2);
if (!["gateway", "agent"].includes(mode) || !file) {
  console.error(
    "Usage: node src/cli.js gateway|agent /absolute/path/config.json",
  );
  process.exit(2);
}
try {
  const absolute = path.resolve(file);
  const stat = fs.statSync(absolute);
  if (process.platform !== "win32" && stat.mode & 0o077)
    throw Error("Configuration must have mode 0600.");
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (mode === "agent")
    for (const p of config.projects ?? []) {
      const relative = path.relative(
        fs.realpathSync(p.root),
        fs.realpathSync(absolute),
      );
      if (
        !relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      )
        throw Error("Agent configuration must be outside authorized projects.");
    }
  const service =
    mode === "gateway" ? await startGateway(config) : await startAgent(config);
  console.log(`KMJ CodeBridge ${mode} started; version ${version}.`);
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      await service.close();
      process.exit(0);
    });
} catch {
  console.error(
    "Startup failed. Check configuration, file permissions, project roots and state lock. No secrets were logged.",
  );
  process.exitCode = 1;
}
