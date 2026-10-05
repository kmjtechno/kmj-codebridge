import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

test("KMJ Desktop marketplace installs CodeBridge by default", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "kmj-techno");
  assert.equal(marketplace.interface.displayName, "KMJ TECHNO");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "kmj-codebridge",
      source: { source: "local", path: "./plugin" },
      policy: {
        installation: "INSTALLED_BY_DEFAULT",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    },
  ]);
});

test("Desktop plugin uses the bundled stdio OAuth bridge", () => {
  const manifest = readJson("plugin/plugin.json");
  const mcp = readJson("plugin/mcp.json");
  assert.equal(manifest.name, "kmj-codebridge");
  assert.equal(manifest.version, "0.2.3");
  assert.deepEqual(mcp.mcpServers.codebridge, {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/desktop/bridge.mjs"],
    cwd: "${PLUGIN_ROOT}",
  });

  const bridge = path.join(root, "plugin/desktop/bridge.mjs");
  const syntax = spawnSync(process.execPath, ["--check", bridge], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test(
  "double-click Windows launcher pins and verifies the public setup script",
  () => {
  const script = fs.readFileSync(
    path.join(root, "scripts/install-chatgpt-desktop.cmd"),
    "utf8",
  );
  const installer = fs.readFileSync(
    path.join(root, "scripts/install-chatgpt-desktop.ps1"),
  );
  const ref = script.match(/KMJ_SETUP_REF=([0-9a-f]{40})/)?.[1];
  const expected = script.match(/KMJ_SETUP_SHA256=([0-9a-f]{64})/)?.[1];

  assert.equal(ref, "9b27cfa3fb38c7cb08e1fda0da8cec384e625b06");
  assert.equal(
    expected,
    createHash("sha256").update(installer).digest("hex"),
  );
  assert.match(
    script,
    /raw\.githubusercontent\.com\/kmjtechno\/kmj-codebridge\/%KMJ_SETUP_REF%\/scripts\/install-chatgpt-desktop\.ps1/,
  );
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.match(script, /ExecutionPolicy Bypass/);
  assert.match(script, /KMJ-CodeBridge-ChatGPT-Desktop\.ps1/);
  assert.doesNotMatch(script, /Bearer\s+[A-Za-z0-9._-]{16,}/);
    assert.doesNotMatch(script, /client_secret/i);
  },
);

test("Windows Desktop installer only configures the public KMJ marketplace", () => {
  const script = fs.readFileSync(
    path.join(root, "scripts/install-chatgpt-desktop.ps1"),
    "utf8",
  );
  assert.match(script, /codex plugin marketplace add \$repo --ref main/);
  assert.match(script, /kmjtechno\/kmj-codebridge/);
  assert.match(script, /codex plugin marketplace upgrade \$marketplace/);
  assert.match(
    script,
    /Codex CLI was not found; using the ChatGPT Desktop personal-marketplace fallback/,
  );
  assert.match(script, /\.codex\\plugins\\kmj-codebridge/);
  assert.match(script, /\.agents\\plugins\\marketplace\.json/);
  assert.match(script, /\.\/\.\.\/\.\.\/\.codex\/plugins\/kmj-codebridge/);
  assert.match(script, /INSTALLED_BY_DEFAULT/);
  assert.match(
    script,
    /Invoke-WebRequest[^\n]+kmjtechno\/kmj-codebridge\/archive\/refs\/heads\/main\.zip/,
  );
  assert.match(script, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.match(script, /Refresh-ProcessPath/);
  assert.doesNotMatch(script, /Bearer\s+[A-Za-z0-9._-]{16,}/);
  assert.doesNotMatch(script, /client_secret/i);

  if (process.platform === "win32") {
    const powershell = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:KMJ_PS1,[ref]$null,[ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          KMJ_PS1: path.join(root, "scripts/install-chatgpt-desktop.ps1"),
        },
      },
    );
    assert.equal(powershell.status, 0, powershell.stderr);
  }
});
