import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
for (const dir of ["src", "scripts", "tests"])
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".js")))
    execFileSync(process.execPath, ["--check", path.join(dir, name)], {
      stdio: "pipe",
    });
const pkg = JSON.parse(fs.readFileSync("package.json"));
const plugin = JSON.parse(fs.readFileSync("plugin/plugin.json"));
if (pkg.version !== plugin.version) throw Error("Version mismatch");
console.log("JavaScript syntax and package/plugin versions verified.");
