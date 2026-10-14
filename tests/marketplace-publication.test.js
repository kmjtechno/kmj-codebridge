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
  assert.ok(registry.description.length <= 100);
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
  assert.match(
    registry.$schema,
    /^https:\/\/static\.modelcontextprotocol\.io\/schemas\//,
  );
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
  assert.match(guide, /never under Add Marketplace/i);
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
  assert.match(workflow, /Require live production OAuth discovery/);
  assert.match(workflow, /codebridge:read/);
  assert.match(workflow, /codebridge:write/);
  assert.match(workflow, /verify-public-mcp-catalog\.mjs/);
  assert.ok(workflow.includes("mcp-publisher publish server.json"));
  assert.ok(
    workflow.includes("releases/download/v1.8.1/mcp-publisher_linux_amd64"),
  );
  const digest = [
    "a06c9096dcb9727c13555b6be26c7eff",
    "a707b01f06a4c561ba7a3635443cf2cc",
  ].join("");
  assert.ok(workflow.includes(digest));
  assert.ok(workflow.includes("sha256sum --check --status"));
  assert.doesNotMatch(workflow, /MCP_(?:PRIVATE_KEY|GITHUB_TOKEN)/);
  assert.doesNotMatch(workflow, /on:\s*\n\s*push:/);
});

test("Claude OAuth distribution includes complete manifests and production endpoint", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(
    workflow,
    /package-claude\.js https:\/\/kmjtechno\.com\/mcp --out/,
  );
  assert.match(
    workflow,
    /name: kmj-codebridge-claude-oauth-marketplace[\s\S]*?include-hidden-files: true/,
  );
  assert.match(
    workflow,
    /name: codebridge-release-candidate[\s\S]*?include-hidden-files: true/,
  );
});

test("every candidate validates official MCP Registry manifest with pinned publisher", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  const release = fs.readFileSync(
    ".github/workflows/publish-mcp-registry.yml",
    "utf8",
  );
  const digest = [
    "a06c9096dcb9727c13555b6be26c7eff",
    "a707b01f06a4c561ba7a3635443cf2cc",
  ].join("");
  assert.match(workflow, /registry_manifest:/);
  assert.match(workflow, /mcp-publisher_linux_amd64\.tar\.gz/);
  assert.ok(workflow.includes(digest));
  assert.ok(release.includes(digest));
  assert.match(workflow, /sha256sum --check --status/);
  assert.match(workflow, /validate server\.json/);
});

test("Claude and GitHub Copilot share a documented opt-in Git marketplace", () => {
  const guide = fs.readFileSync("docs/AI-CLIENT-QUICKSTART.md", "utf8");
  const catalog = json(".claude-plugin/marketplace.json");
  const plugin = json("claude-plugin/.claude-plugin/plugin.json");
  const mcp = json("claude-plugin/.mcp.json");
  assert.equal(catalog.name, "kmj-techno");
  assert.equal(catalog.plugins[0].source, "./claude-plugin");
  assert.equal(plugin.name, "kmj-codebridge");
  assert.equal(mcp.mcpServers.codebridge.url, "https://kmjtechno.com/mcp");
  assert.match(
    guide,
    /copilot plugin marketplace add kmjtechno\/kmj-codebridge/,
  );
  assert.match(
    guide,
    /copilot plugin install kmj-codebridge@kmj-techno/,
  );
  assert.match(
    guide,
    /claude plugin install kmj-codebridge@kmj-techno/,
  );
  assert.match(guide, /do not.*auto-post|never auto-post/i);
  assert.match(guide, /not.*yet/i);
  assert.doesNotMatch(guide, /Bearer [a-zA-Z0-9]/);
});

test("README links to opt-in AI setup without advertising active payment checkout", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  const section = readme.indexOf("## Connect CodeBridge to your AI");
  assert.ok(section > 0);
  assert.ok(section < readme.indexOf("## Why CodeBridge?"));
  assert.match(readme, /docs\/AI-CLIENT-QUICKSTART\.md/);
  assert.match(readme, /copilot plugin install kmj-codebridge@kmj-techno/);
  assert.match(readme, /developer preview/i);
});
