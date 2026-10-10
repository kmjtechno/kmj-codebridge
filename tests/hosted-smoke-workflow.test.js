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
  assert.match(render, /actions\/checkout@v4/);
  assert.match(render, /kmj-codebridge-gateway\.onrender\.com\/healthz/);
  assert.match(render, /payload\.version !== process\.env\.EXPECTED/);
  assert.match(render, /payload\.capabilities\?\.github !== true/);
  assert.doesNotMatch(render, /kmjtechno\.com\/mcp/);
  assert.doesNotMatch(production, /needs:\s*gateway/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
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
