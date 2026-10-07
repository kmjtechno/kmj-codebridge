import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  generatedArtifacts,
  generatedDrift,
} from "../scripts/generate-product-artifacts.js";
import { readCanonical } from "../scripts/package-common.js";

const manifest = JSON.parse(
  fs.readFileSync("product/codebridge-product.json", "utf8"),
);

test("generated product artifacts match the canonical manifest", () => {
  assert.deepEqual(generatedDrift(), []);
  const artifacts = generatedArtifacts();
  assert.equal(artifacts.size, 6);
  assert.ok(artifacts.has("product/clients.generated.json"));
  assert.ok(artifacts.has("product/plans.generated.json"));
  assert.ok(artifacts.has("product/main-platform-catalog.generated.json"));
  assert.ok(artifacts.has("product/release-dashboard.generated.json"));
  assert.ok(artifacts.has("product/PLAN-TABLE.generated.md"));
  assert.ok(artifacts.has("product/LAUNCH-OFFER.generated.md"));
});

test(
  "generated Main Platform catalog is non-secret and preserves commercial authority",
  () => {
    const catalog = JSON.parse(
      fs.readFileSync("product/main-platform-catalog.generated.json", "utf8"),
    );
    assert.equal(catalog.runtimeAuthority, "KMJ Main Platform");
    assert.equal(catalog.version, manifest.versions.stable);
    assert.deepEqual(catalog.launch, manifest.launch);
    assert.deepEqual(catalog.plans, manifest.plans);

    const serialized = JSON.stringify(catalog).toLowerCase();
    for (const forbidden of [
      "private_key",
      "client_secret",
      "access_token",
      "refresh_token",
      "bearer ",
    ])
      assert.ok(!serialized.includes(forbidden), forbidden);
  },
);ort test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  generatedArtifacts,
  generatedDrift,
} from "../scripts/generate-product-artifacts.js";
import { readCanonical } from "../scripts/package-common.js";

const manifest = JSON.parse(
  fs.readFileSync("product/codebridge-product.json", "utf8"),
);

test("generated product artifacts match the canonical manifest", () => {
  assert.deepEqual(generatedDrift(), []);
  const artifacts = generatedArtifacts();
  assert.equal(artifacts.size, 6);
  assert.ok(artifacts.has("product/clients.generated.json"));
  assert.ok(artifacts.has("product/plans.generated.json"));
  assert.ok(artifacts.has("product/main-platform-catalog.generated.json"));
  assert.ok(artifacts.has("product/release-dashboard.generated.json"));
  assert.ok(artifacts.has("product/PLAN-TABLE.generated.md"));
  assert.ok(artifacts.has("product/LAUNCH-OFFER.generated.md"));
});

test("generated Main Platform catalog is non-secret and preserves commercial authority", () => {
  const catalog = JSON.parse(
    fs.readFileSync("product/main-platform-catalog.generated.json", "utf8"),
  );
  assert.equal(catalog.runtimeAuthority, "KMJ Main Platform");
  assert.equal(catalog.version, manifest.versions.stable);
  assert.deepEqual(catalog.launch, manifest.launch);
  assert.deepEqual(catalog.plans, manifest.plans);

  const serialized = JSON.stringify(catalog).toLowerCase();
  for (const forbidden of [
    "private_key",
    "client_secret",
    "access_token",
    "refresh_token",
    "bearer ",
  ])
    assert.ok(!serialized.includes(forbidden), forbidden);
});

test("client packaging canonical metadata comes from the product manifest", () => {
  const meta = readCanonical();
  assert.equal(meta.version, manifest.versions.stable);
  assert.equal(meta.mcpEndpoint, manifest.endpoints.mcp);
  assert.equal(meta.enrollmentOrigin, manifest.endpoints.enrollment);
  assert.equal(meta.agentGateway, manifest.endpoints.agentGateway);
  assert.equal(meta.homepage, manifest.product.homepage);
  assert.equal(meta.repository, manifest.product.repository);
  assert.equal(meta.privacy, manifest.product.privacy);
  assert.equal(meta.terms, manifest.product.terms);
  assert.equal(meta.support, manifest.product.support);
});

test("generated release dashboard reports marketplace state without claiming approval", () => {
  const dashboard = JSON.parse(
    fs.readFileSync("product/release-dashboard.generated.json", "utf8"),
  );
  assert.equal(dashboard.stableVersion, manifest.versions.stable);
  assert.equal(dashboard.marketplaces.openai.status, "prepared");
  assert.equal(dashboard.marketplaces.claude.status, "prepared");
  assert.equal(
    dashboard.marketplaces.chatgptDesktop.status,
    "repository_marketplace_available",
  );
  assert.notEqual(dashboard.marketplaces.openai.status, "approved");
  assert.notEqual(dashboard.marketplaces.claude.status, "approved");
});

test("ChatGPT registered app identity matches the canonical product contract", () => {
  const plugin = JSON.parse(fs.readFileSync("plugin/plugin.json", "utf8"));
  const app = JSON.parse(fs.readFileSync("plugin/.app.json", "utf8"));
  const ui = plugin.extensions["com.openai"].interface;
  assert.equal(manifest.product.developer, "KMJ TECHNO");
  assert.equal(manifest.product.category, "Developer Tools");
  assert.equal(manifest.product.assets.icon, "plugin/assets/icon.png");
  assert.equal(manifest.product.assets.logo, manifest.product.assets.icon);
  assert.equal(ui.developerName, manifest.product.developer);
  assert.equal(ui.category, manifest.product.category);
  assert.equal(ui.websiteURL, manifest.product.homepage);
  assert.equal(ui.logo, "./assets/icon.png");
  assert.equal(ui.composerIcon, "./assets/icon.png");
  assert.equal(app.apps.codebridge.id, manifest.marketplaces.openai.appId);
  assert.equal(manifest.marketplaces.openai.mcpEndpoint, manifest.endpoints.mcp);
});
