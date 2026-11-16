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
  // The live gateway must run exactly the newest owner-signed release; main may
  // legitimately be ahead with docs/tests/metadata-only merges.
  assert.ok(
    gateway.includes(
      "EXPECT_DEPLOYED_COMMIT: ${{ steps.release.outputs.revision }}",
    ),
  );
  assert.ok(!gateway.includes("EXPECT_DEPLOYED_COMMIT: ${{ github.sha }}"));
  assert.match(gateway, /node scripts\/latest-signed-release\.mjs/);
  assert.match(gateway, /exact deployed signed release commit/);
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
  // The required scope must be a whole token inside the challenge's scope
  // attribute, so the wider list from oauth.signInScopes=all is accepted while
  // a wrong or prefix-only scope is not.
  const grep = production.match(
    /grep -Eq "(scope=\\"\(\[\^\\"\]\* \)\?codebridge:\$\{scope\}\( \[\^\\"\]\*\)\?\\")" "\$headers"/,
  );
  assert.ok(grep, "scope token check is missing from the workflow");
  const pattern = (scope) =>
    new RegExp(grep[1].replaceAll('\\"', '"').replace("${scope}", scope));
  const challenge = (value) =>
    `www-authenticate: Bearer resource_metadata="https://x/", scope="${value}"`;
  assert.ok(pattern("read").test(challenge("codebridge:read")));
  assert.ok(
    pattern("read").test(
      challenge("codebridge:read codebridge:write codebridge:execute"),
    ),
  );
  assert.ok(
    pattern("write").test(
      challenge("codebridge:read codebridge:write codebridge:execute"),
    ),
  );
  assert.ok(!pattern("write").test(challenge("codebridge:read")));
  assert.ok(!pattern("read").test(challenge("codebridge:readwrite")));
  assert.ok(!pattern("read").test(challenge("xcodebridge:read")));
  assert.ok(
    !pattern("read").test(
      `www-authenticate: Bearer resource_metadata="https://x/"`,
    ),
  );
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
