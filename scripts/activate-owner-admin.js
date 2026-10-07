#!/usr/bin/env node
import { activateOwnerAdmin } from "../src/owner-admin-activation.js";

const [configPath, publicKeysPath, credentialPath] = process.argv.slice(2);
if (!configPath || !publicKeysPath || !credentialPath || process.argv.length !== 5) {
  console.error(
    "Usage: node scripts/activate-owner-admin.js <absolute-agent-config> <absolute-public-keys-json> <absolute-private-device-credential>",
  );
  process.exit(2);
}

try {
  const result = await activateOwnerAdmin({
    configPath,
    publicKeysPath,
    credentialPath,
  });
  console.log(
    JSON.stringify({
      activated: result.activated,
      device: result.device,
      signedConcurrentJobs: result.signedConcurrentJobs,
      restartRequired: result.restartRequired,
    }),
  );
} catch {
  // Avoid disclosing credential paths, tokens, internal HTTP responses or
  // signed lease material in terminals and shared CI logs.
  console.error("Owner plan activation refused. Verify owner grant, signed lease, files and permissions.");
  process.exitCode = 1;
}
