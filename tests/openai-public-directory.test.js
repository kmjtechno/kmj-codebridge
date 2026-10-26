import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  buildOpenAIDirectoryCandidate,
  DIRECTORY_MCP_URL,
} from "../scripts/package-openai-directory.mjs";

function withTemp(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kmj-openai-public-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("public ZIP staging preserves branding and excludes local execution", (t) => {
  const base = withTemp(t);
  const result = buildOpenAIDirectoryCandidate({
    outBase: base,
    zip: false,
  });
  assert.equal(result.archive, null);
  const files = fs.readdirSync(result.directory).sort();
  assert.deepEqual(files, [
    "LICENSE",
    "PRIVACY.md",
    "TERMS.md",
    "assets",
    "mcp.json",
    "plugin.json",
    "skills",
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.directory, "plugin.json"), "utf8"),
  );
  const mcp = JSON.parse(
    fs.readFileSync(path.join(result.directory, "mcp.json"), "utf8"),
  );
  assert.equal(manifest.name, "kmj-codebridge");
  assert.equal(manifest.extensions["com.openai"].apps, undefined);
  assert.equal(manifest.extensions["com.openai"].hooks, undefined);
  assert.equal(
    manifest.extensions["com.openai"].review.test_cases.positive.length,
    5,
  );
  assert.equal(
    manifest.extensions["com.openai"].review.test_cases.negative.length,
    3,
  );
  assert.deepEqual(mcp.mcpServers, {
    codebridge: { type: "streamable-http", url: DIRECTORY_MCP_URL },
  });
  assert.equal(fs.existsSync(path.join(result.directory, ".app.json")), false);
  assert.equal(fs.existsSync(path.join(result.directory, "desktop")), false);
  const icon = "assets/icon.png";
  assert.deepEqual(
    fs.readFileSync(path.join(result.directory, icon)),
    fs.readFileSync(path.join("plugin", icon)),
  );
});

test("public candidate builder never overwrites a prior output", (t) => {
  const base = withTemp(t);
  buildOpenAIDirectoryCandidate({ outBase: base, zip: false });
  assert.throws(
    () => buildOpenAIDirectoryCandidate({ outBase: base, zip: false }),
    /PUBLIC_PACKAGE_DESTINATION_EXISTS/,
  );
});

test("public candidate creates a ZIP with a single plugin root", (t) => {
  if (
    process.platform === "win32" ||
    spawnSync("zip", ["-v"], { stdio: "ignore" }).status !== 0 ||
    spawnSync("unzip", ["-v"], { stdio: "ignore" }).status !== 0
  ) {
    t.skip("Host zip and unzip tools are unavailable");
    return;
  }
  const base = withTemp(t);
  const result = buildOpenAIDirectoryCandidate({ outBase: base });
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  const listing = spawnSync("unzip", ["-Z1", result.archive], {
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^kmj-codebridge\/plugin\.json$/m);
  assert.match(listing.stdout, /^kmj-codebridge\/mcp\.json$/m);
  assert.doesNotMatch(listing.stdout, /\.app\.json|desktop\/|hooks\//);
});
