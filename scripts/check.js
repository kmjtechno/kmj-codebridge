import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
for (const dir of ["src", "scripts", "tests"])
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".js")))
    execFileSync(process.execPath, ["--check", path.join(dir, name)], {
      stdio: "pipe",
    });
const pkg = JSON.parse(fs.readFileSync("package.json"));
const lock = JSON.parse(fs.readFileSync("package-lock.json"));
const plugin = JSON.parse(fs.readFileSync("plugin/plugin.json"));
const claude = JSON.parse(
  fs.readFileSync("claude-plugin/.claude-plugin/plugin.json"),
);
const versions = [
  pkg.version,
  lock.version,
  lock.packages?.[""]?.version,
  plugin.version,
  claude.version,
];
if (versions.some((version) => version !== pkg.version))
  throw Error("Version mismatch");
console.log("JavaScript syntax and package/plugin versions verified.");
