import test from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsNpm } from "../src/windows-command.js";

const node = "C:\\Program Files\\nodejs\\node.exe";
const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";

test("bare npm and npm.cmd map to node + npm-cli.js on win32", () => {
  for (const c of ["npm", "npm.cmd", "NPM.CMD"]) {
    const r = resolveWindowsNpm(c, ["ci", "--ignore-scripts"], {
      platform: "win32",
      execPath: node,
      exists: (p) => p === cli,
    });
    assert.equal(r.command, node);
    assert.deepEqual(r.args, [cli, "ci", "--ignore-scripts"]);
  }
});

test("non-win32, other executables and absolute paths are untouched", () => {
  const opts = { platform: "win32", execPath: node, exists: () => true };
  assert.deepEqual(
    resolveWindowsNpm("npm", ["x"], { ...opts, platform: "linux" }),
    {
      command: "npm",
      args: ["x"],
    },
  );
  for (const c of ["node.exe", "cargo", "C:\\evil\\npm.cmd", "npx"])
    assert.equal(resolveWindowsNpm(c, ["x"], opts).command, c);
});

test("missing npm-cli.js fails closed", () => {
  assert.throws(
    () =>
      resolveWindowsNpm("npm", [], {
        platform: "win32",
        execPath: node,
        exists: () => false,
      }),
    /NPM_CLI_NOT_FOUND/,
  );
});
