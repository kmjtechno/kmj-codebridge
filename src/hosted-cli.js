import { startHostedGateway } from "./hosted.js";
try {
  const service = await startHostedGateway(
    process.env.CODEBRIDGE_GATEWAY_CONFIG,
    process.env.PORT ?? "10000",
  );
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
  process.exitCode = 1;
}
