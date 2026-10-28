import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/hosted-smoke.yml", "utf8");
const gateway = workflow
  .split("\n  gateway:\n")[1]
  ?.split("\n  public_oauth:\n")[0];
const production = workflow.split("\n  public_oauth:\n")[1];

test("scheduled deployment smoke checks the owner VPS and not Render", () => {
  assert.ok(gateway, "VPS MCP gateway gate is required");
  assert.ok(production, "public OAuth gate is required");
  assert.match(workflow, /name: VPS Deployment Smoke/);
  assert.match(gateway, /actions\/checkout@v5/);
  assert.match(gateway, /node scripts\/verify-vps-catalog\.mjs/);
  // A green gateway gate must attest current code, not merely an older
  // healthy MCP process with the right public catalog.
  assert.match(gateway, /EXPECT_DEPLOYED_COMMIT: \\$\\{\\{ github\\.sha \\}\\}/);
  assert.match(gateway, /exact deployed main commit/);
  assert.doesNotMatch(workflow, /onrender\.com|verify-render-deployment\.mjs/);
  assert.doesNotMatch(production, /needs:\s*gateway/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test("production OAuth still fails closed on discovery and scoped 401", () => {
  assert.ok(production);
  assert.match(production, /oauth-authorization-server/);
  assert.match(production, /oauth-protected-resource\/mcp/);
  assert.match(production, /oauth\/jwks\.json/);
  assert.match(production, /test "\$status" = "401"/);
  assert.match(production, /www-authenticate:.*resource_metadata/);
  assert.match(
    production,
    /for spec in 'list_devices:read' 'write_file:write'/,
  );
  assert.match(production, /scope=\\\"codebridge:\$scope\\\"/);
  assert.match(production, /exit 1/);
});

test("scheduled and on-push VPS deployment surveillance stays enabled", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- "\.github\/workflows\/hosted-smoke\.yml"/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /scripts\/verify-vps-catalog\.mjs/);
});

test("VPS smoke requires a real catalog, schemas, and known running commit", () => {
  const probe = readFileSync("scripts/verify-vps-catalog.mjs", "utf8");
  assert.match(probe, /probeWithWarmup/);
  assert.match(probe, /verifyCriticalToolSchemas/);
  assert.match(probe, /probeServerCommit/);
  assert.match(probe, /VPS_COMMIT_UNVERIFIED/);
  assert.match(probe, /VPS_SOURCE_PARITY=NOT_CURRENT_RELEASE/);
  assert.doesNotMatch(probe, /onrender\.com|RENDER_GIT_COMMIT/);
});
