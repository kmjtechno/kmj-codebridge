import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/hosted-smoke.yml", "utf8");
const render = workflow
  .split("\n  gateway:\n")[1]
  ?.split("\n  public_oauth:\n")[0];
const production = workflow.split("\n  public_oauth:\n")[1];

test("hosted acceptance separates Render and production-origin failures", () => {
  assert.ok(render, "a distinct Render gateway job is required");
  assert.ok(production, "a distinct public OAuth job is required");
  assert.match(render, /actions\/checkout@v5/);
  assert.match(render, /kmj-codebridge-gateway\.onrender\.com\/healthz/);
  assert.match(render, /payload\.version !== process\.env\.EXPECTED/);
  assert.match(render, /payload\.capabilities\?\.github !== true/);
  assert.doesNotMatch(render, /kmjtechno\.com\/mcp/);
  assert.doesNotMatch(production, /needs:\s*gateway/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test("Render gateway freshness is checked against the deployed commit, not just the hand-bumped version (issue #274)", () => {
  assert.ok(render);
  assert.match(render, /payload\.commit/);
  assert.match(render, /GITHUB_SHA/);
  assert.match(render, /Hosted gateway may be stale/);
  // A lagging free-tier deploy is a warning, never a hard CI failure.
  assert.doesNotMatch(render, /throw new Error\(`Deployed commit/);
});

test("production OAuth still fails closed on missing discovery or scoped 401", () => {
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

test("scheduled and on-push deployment surveillance stays enabled", () => {
  assert.match(workflow, /schedule:\s*\n\s*- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- "\.github\/workflows\/hosted-smoke\.yml"/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test("release acceptance refuses stale Render deployed SHA independently of health", () => {
  const parity = workflow.split("\n  deployment_parity:\n")[1];
  assert.ok(parity, "a strict deployment parity job is required");
  assert.match(parity, /actions\/checkout@v5/);
  assert.match(parity, /node scripts\/verify-render-deployment\.mjs/);
  assert.doesNotMatch(parity, /continue-on-error:\s*true/);
  assert.doesNotMatch(parity, /needs:\s*gateway/);
  assert.match(workflow, /- "scripts\/verify-render-deployment\.mjs"/);
});
