import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

// Windows ships npm as npm.cmd. Node >= 20.12 refuses to spawn .cmd files
// without a shell (EINVAL) and the job runner never uses a shell. Map only the
// bare names `npm` / `npm.cmd` to `node <npm-cli.js>` next to the running Node
// binary. Absolute paths, other executables and non-Windows are untouched.
export function resolveWindowsNpm(
  command,
  args,
  {
    platform = process.platform,
    execPath = process.execPath,
    exists = fs.existsSync,
  } = {},
) {
  if (platform !== "win32") return { command, args };
  const base = String(command).toLowerCase();
  if (base !== "npm" && base !== "npm.cmd") return { command, args };
  const cli = path.win32.join(
    path.win32.dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!exists(cli)) fail("NPM_CLI_NOT_FOUND");
  return { command: execPath, args: [cli, ...args] };
}
