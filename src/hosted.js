import { gatewaySchema } from "./config.js";
import { startGateway } from "./gateway.js";
import { fail } from "./errors.js";
export function hostedConfig(text, port = "10000") {
  try {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > 1048576 ||
      typeof port !== "string" ||
      !/^\d{1,5}$/.test(port)
    )
      fail("HOSTED_CONFIG_INVALID");
    const config = gatewaySchema.parse({
      ...JSON.parse(text),
      host: "0.0.0.0",
      port: Number(port),
    });
    if (
      !config.oauth ||
      !config.allowedHosts.includes(new URL(config.oauth.resource).hostname)
    )
      fail("HOSTED_CONFIG_INVALID");
    return config;
  } catch {
    fail("HOSTED_CONFIG_INVALID");
  }
}
export async function startHostedGateway(text, port) {
  return startGateway(hostedConfig(text, port));
}
