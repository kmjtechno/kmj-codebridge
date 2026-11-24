import { hostedConfig } from "./hosted.js";
import { startGateway } from "./gateway.js";
// Fixed, non-secret lifecycle labels only. No error object, configuration,
// token, repository list or stack trace is ever written to deployment logs.
let startupStage = "CONFIG_VALIDATION";
try {
  const config = hostedConfig(
    process.env.CODEBRIDGE_GATEWAY_CONFIG,
    process.env.PORT ?? "10000",
  );
  startupStage = "GATEWAY_RUNTIME";
  const service = await startGateway(config);
  console.log("KMJ CodeBridge gateway started with OAuth required.");
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      try {
        await service.close();
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      }
    });
} catch {
  console.error(
    "Hosted startup failed. Check private gateway configuration, OAuth and PORT.",
  );
  console.error(`SAFE_STARTUP_STAGE=${startupStage}`);
  process.exitCode = 1;
}
