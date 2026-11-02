// Read-only cryptographic entry point for the stable canary evidence gate.
// Never signs, publishes, starts, upgrades or activates a service.
import { verifySignedReleaseBundle } from "../verify-signed-bundle.mjs";
import { assessSignedStableCanary } from "./assess-signed-stable-canary.mjs";

export async function verifySignedStableCanary({
  bundlePaths,
  expectedSha,
  runtime,
  operator,
} = {}) {
  // Never permit a caller to lower the protected accepted sequence.
  if (
    !Number.isSafeInteger(runtime?.acceptedSequence) ||
    runtime.acceptedSequence < 0 ||
    !bundlePaths ||
    typeof bundlePaths !== "object" ||
    Array.isArray(bundlePaths)
  )
    throw Error("STABLE_CANARY_INPUT_INVALID");

  const bundle = await verifySignedReleaseBundle({
    ...bundlePaths,
    minimumSequence: runtime.acceptedSequence,
    expectedChannel: "stable",
  });
  return assessSignedStableCanary({ bundle, expectedSha, runtime, operator });
}
