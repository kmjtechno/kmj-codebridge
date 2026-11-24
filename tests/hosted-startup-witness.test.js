import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
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

test("hosted port collision emits runtime stage without error details or config", async (t) => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const privateMarker = "DO_NOT_PRINT_OWNER_JWKS_789012";
  const candidate = {
    allowedHosts: ["bridge.example"],
    oauth: {
      issuer: "https://bridge.example",
      resource: "https://bridge.example/mcp",
      jwksUri: "https://bridge.example/jwks.json",
    },
    users: [],
    agents: [],
    // Non-secret sentinel intentionally omitted from schema: never log it.
    privateProbeMarker: privateMarker,
  };
  const result = runHosted({
    CODEBRIDGE_GATEWAY_CONFIG: JSON.stringify(candidate),
    PORT: String(port),
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
    /\bEADDRINUSE\b|\bpassword\b|\btokenEnv\b/,
  );
});
