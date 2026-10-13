import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const json = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

test("official MCP registry uses existing OAuth HTTPS endpoint without unpublished npm package", () => {
  const registry = json("server.json");
  const product = json("product/codebridge-product.json");
  const pkg = json("package.json");
  assert.equal(registry.name, "io.github.kmjtechno/kmj-codebridge");
  assert.equal(registry.title, "KMJ CodeBridge");
  assert.equal(registry.version, pkg.version);
  assert.equal(registry.version, product.versions.stable);
  assert.equal(registry.websiteUrl, product.product.homepage);
  assert.deepEqual(registry.repository, {
    url: product.product.repository,
    source: "github",
  });
  assert.deepEqual(registry.remotes, [
    { type: "streamable-http", url: product.endpoints.mcp },
  ]);
  assert.equal(pkg.private, true);
  assert.equal(registry.packages, undefined);
  assert.equal(JSON.stringify(registry).includes("Bearer "), false);
  assert.match(registry.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\//);
});

test("Claude Cowork git marketplace and remote MCP connector remain separate", () => {
  const listing = json(".claude-plugin/marketplace.json");
  const endpoint = json("claude-plugin/.mcp.json");
  const manifest = json("claude-plugin/.claude-plugin/plugin.json");
  assert.equal(listing.name, "kmj-techno");
  assert.equal(listing.plugins[0].name, "kmj-codebridge");
  assert.equal(listing.plugins[0].source, "./claude-plugin");
  assert.equal(manifest.name, "kmj-codebridge");
  assert.equal(endpoint.mcpServers.codebridge.url, "https://kmjtechno.com/mcp");
  const guide = fs.readFileSync("docs/MARKETPLACE-PUBLISHING.md", "utf8");
  assert.match(guide, /https:\/\/github\.com\/kmjtechno\/kmj-codebridge/);
  assert.match(guide, /not.*under Add Marketplace/i);
});

test("Glama claim metadata references authorized connected GitHub identity", () => {
  const glama = json("glama.json");
  assert.equal(glama.$schema, "https://glama.ai/mcp/schemas/server.json");
  assert.deepEqual(glama.maintainers, ["kmjtechno"]);
});

test("official registry workflow is manual, scoped and has no static registry token", () => {
  const workflow = fs.readFileSync(
    ".github/workflows/publish-mcp-registry.yml",
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirmation.*PUBLISH_KMJ_CODEBRIDGE/s);
  assert.match(workflow, /environment: mcp-registry-publish/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /login github-oidc/);
  assert.match(workflow, /mcp-publisher validate server\.json/);
  assert.match(workflow, /mcp-publisher publish server\.json/);
  assert.doesNotMatch(workflow, /MCP_(?:PRIVATE_KEY|GITHUB_TOKEN)/);
  assert.doesNotMatch(workflow, /on:\s*\n\s*push:/);
});
