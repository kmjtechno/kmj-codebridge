import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const installer = path.resolve(
  import.meta.dirname,
  "../scripts/install-vscode-copilot.cmd",
);
const source = fs.readFileSync(installer, "utf8");

test("one-click Copilot setup is standalone and preserves OAuth consent", () => {
  assert.match(source, /KMJ_CODEBRIDGE_COPILOT_POWERSHELL_V1/);
  assert.match(source, /https:\/\/kmjtechno\.com\/mcp/);
  assert.match(source, /type = 'http'/);
  assert.match(source, /Code\\User\\mcp\.json/);
  assert.match(source, /OAuth in the browser when requested/);
  assert.match(source, /\[IO\.File\]::Replace\(\$tmp, \$path, \$backup/);
  assert.doesNotMatch(source, /mcp-remote|npm install|npx\.cmd|access.token/i);
});

function install(appData) {
  return spawnSync("cmd.exe", ["/d", "/c", installer], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      APPDATA: appData,
      KMJ_COPILOT_SETUP_TEST_MODE: "1",
    },
  });
}

test(
  "Windows installer migrates stdio, keeps other servers and is repeatable",
  { skip: process.platform !== "win32" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-copilot-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = path.join(dir, "Code", "User");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "mcp.json");
    const original = JSON.stringify({
      inputs: [{ id: "other-key", type: "promptString" }],
      servers: {
        other: { type: "http", url: "https://example.org/mcp" },
        "kmj-codebridge": {
          type: "stdio",
          command: "npx.cmd",
          args: ["-y", "legacy-bridge", "https://kmjtechno.com/mcp"],
        },
      },
    });
    fs.writeFileSync(file, original);

    const first = install(dir);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const updated = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(updated.servers["kmj-codebridge"], {
      type: "http",
      url: "https://kmjtechno.com/mcp",
    });
    assert.equal(updated.servers.other.url, "https://example.org/mcp");
    assert.equal(updated.inputs[0].id, "other-key");
    const backups = fs
      .readdirSync(folder)
      .filter((entry) => entry.includes(".kmj-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(folder, backups[0]), "utf8"), original);

    const second = install(dir);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(
      fs.readdirSync(folder).filter((entry) => entry.includes(".kmj-backup-"))
        .length,
      1,
    );
  },
);

test(
  "Windows installer does not replace malformed existing JSON",
  { skip: process.platform !== "win32" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-invalid-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const folder = path.join(dir, "Code", "User");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "mcp.json");
    fs.writeFileSync(file, "{broken");

    const result = install(dir);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  },
);
