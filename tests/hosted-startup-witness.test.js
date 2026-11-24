import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/hosted-cli.js", import.meta.url));

function runHosted(env) {
  return spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

test("hosted validation failure emits only safe stage, never a private config value", () => {
  const privateMarker = "DO_NOT_PRINT_PRIVATE_OWNER_CONFIG_123456";
  const result = runHosted({
    CODEBRIDGE_GATEWAY_CONFIG: JSON.stringify({ hidden: privateMarker }),
    PORT: "10000",
    CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY: "true",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SAFE_STARTUP_STAGE=CONFIG_VALIDATION/);
  assert.match(result.stderr, /Hosted startup failed/);
  assert.doesNotMatch(
    result.stderr + result.stdout,
    /DO_NOT_PRINT_PRIVATE_OWNER_CONFIG_123456/,
  );
  assert.doesNotMatch(
    result.stderr,
    /\bAuthorization\b|\btokenEnv\b|\bpassword\b/,
  );
});

test("hosted duplicate identity emits runtime stage without private details", () => {
  const privateMarker = "DO_NOT_PRINT_OWNER_JWKS_789012";
  const candidate = {
    allowedHosts: ["bridge.example"],
    oauth: {
      issuer: "https://bridge.example",
      resource: "https://bridge.example/mcp",
      jwksUri: "https://bridge.example/jwks.json",
    },
    users: [],
    agents: [
      { id: "d1", tenant: "t1", tokenHash: "a".repeat(64) },
      { id: "d1", tenant: "t1", tokenHash: "b".repeat(64) },
    ],
    // Non-secret sentinel intentionally omitted from schema: never log it.
    privateProbeMarker: privateMarker,
  };
  const result = runHosted({
    CODEBRIDGE_GATEWAY_CONFIG: JSON.stringify(candidate),
    PORT: "0",
    CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY: "false",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SAFE_STARTUP_STAGE=GATEWAY_RUNTIME/);
  assert.match(result.stderr, /Hosted startup failed/);
  assert.doesNotMatch(
    result.stderr + result.stdout,
    /DO_NOT_PRINT_OWNER_JWKS_789012/,
  );
  assert.doesNotMatch(
    result.stderr,
    /\bDUPLICATE_IDENTITY\b|\bpassword\b|\btokenEnv\b/,
  );
});
