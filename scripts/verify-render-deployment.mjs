import { pathToFileURL } from "node:url";

const RENDER_HEALTH_URL = "https://kmj-codebridge-gateway.onrender.com/healthz";
const SHA = /^[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 16 * 1024;

export function assertDeployedCommit(payload, expectedSha) {
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha)) {
    throw new Error("EXPECTED_COMMIT_INVALID");
  }
  if (!payload || typeof payload !== "object" || payload.status !== "ok") {
    throw new Error("DEPLOYED_GATEWAY_UNHEALTHY");
  }
  if (typeof payload.commit !== "string" || !SHA.test(payload.commit)) {
    throw new Error("DEPLOYED_COMMIT_UNVERIFIED");
  }
  if (payload.commit !== expectedSha) {
    throw new Error("DEPLOYED_COMMIT_STALE");
  }
  return payload.commit;
}

async function readSmallBody(response) {
  if (!response.body) throw new Error("DEPLOYED_HEALTH_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("DEPLOYED_HEALTH_BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function verifyDeployedGatewayOnce(expectedSha, request = fetch) {
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha)) {
    throw new Error("EXPECTED_COMMIT_INVALID");
  }
  const response = await request(RENDER_HEALTH_URL, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "application/json" },
  });
  if (response.status !== 200)
    throw new Error("DEPLOYED_HEALTH_HTTP_UNAVAILABLE");
  let payload;
  try {
    payload = JSON.parse(await readSmallBody(response));
  } catch (error) {
    if (
      error.message === "DEPLOYED_HEALTH_BODY_MISSING" ||
      error.message === "DEPLOYED_HEALTH_BODY_TOO_LARGE"
    ) {
      throw error;
    }
    throw new Error("DEPLOYED_HEALTH_JSON_INVALID");
  }
  return assertDeployedCommit(payload, expectedSha);
}

export async function verifyDeployedGateway(
  expectedSha,
  request = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  if (typeof expectedSha !== "string" || !SHA.test(expectedSha)) {
    throw new Error("EXPECTED_COMMIT_INVALID");
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await verifyDeployedGatewayOnce(expectedSha, request);
    } catch (error) {
      const retriable = new Set([
        "DEPLOYED_COMMIT_STALE",
        "DEPLOYED_COMMIT_UNVERIFIED",
        "DEPLOYED_GATEWAY_UNHEALTHY",
        "DEPLOYED_HEALTH_HTTP_UNAVAILABLE",
      ]);
      // Fetch may reject before an HTTP response when a free-tier Render
      // instance is sleeping. Retry only known transport/timeout failures;
      // never soften malformed JSON, oversized responses or a bad SHA.
      const transientNetwork =
        error instanceof TypeError ||
        error?.name === "TimeoutError" ||
        error?.name === "AbortError";
      if (!retriable.has(error.message) && !transientNetwork) {
        const known = new Set([
          "EXPECTED_COMMIT_INVALID",
          "DEPLOYED_HEALTH_BODY_MISSING",
          "DEPLOYED_HEALTH_BODY_TOO_LARGE",
          "DEPLOYED_HEALTH_JSON_INVALID",
        ]);
        if (known.has(error.message)) throw error;
        throw new Error("DEPLOYED_HEALTH_REQUEST_FAILED");
      }
      if (attempt === 5) {
        if (transientNetwork) {
          throw new Error("DEPLOYED_HEALTH_REQUEST_FAILED");
        }
        throw error;
      }
      await pause((attempt + 1) * 3000);
    }
  }
  throw new Error("DEPLOYMENT_PARITY_NOT_VERIFIED");
}

async function main() {
  const commit = await verifyDeployedGateway(process.env.GITHUB_SHA);
  console.log("RENDER_DEPLOYMENT_PARITY=PASS sha=" + commit);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const known = new Set([
      "EXPECTED_COMMIT_INVALID",
      "DEPLOYED_GATEWAY_UNHEALTHY",
      "DEPLOYED_COMMIT_UNVERIFIED",
      "DEPLOYED_COMMIT_STALE",
      "DEPLOYED_HEALTH_HTTP_UNAVAILABLE",
      "DEPLOYED_HEALTH_BODY_MISSING",
      "DEPLOYED_HEALTH_BODY_TOO_LARGE",
      "DEPLOYED_HEALTH_JSON_INVALID",
      "DEPLOYED_HEALTH_REQUEST_FAILED",
    ]);
    const code = known.has(error.message)
      ? error.message
      : "DEPLOYMENT_PARITY_NOT_VERIFIED";
    console.error("RENDER_DEPLOYMENT_PARITY=FAIL " + code);
    process.exitCode = 1;
  });
}
