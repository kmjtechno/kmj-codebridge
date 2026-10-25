// Fail-closed, no-credential preflight BEFORE creating an owner pairing.
// A legacy Main Platform response (404) must not create an orphan device grant.
import { readJsonLimited } from "./http.js";
import { fail } from "./errors.js";

const READY_PATH = "/api/codebridge/v1/device-enrollments/readiness";

export async function assertEnrollmentServerReady(base, options = {}) {
  let origin;
  try {
    origin = new URL(base);
  } catch {
    fail("ENROLLMENT_URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  ) {
    fail("ENROLLMENT_URL");
  }

  const target = new URL(READY_PATH, origin);
  let response;
  try {
    response = await (options.fetch ?? fetch)(target, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  } catch {
    fail("PAIRING_READINESS_NETWORK");
  }
  // Never read arbitrary non-200 response bodies; they can contain secrets.
  if (response.status === 404) fail("PAIRING_SERVER_FIX_NOT_LIVE");
  if (response.status === 503) fail("PAIRING_PUBLIC_ORIGIN_NOT_READY");
  if (response.status !== 200) fail("PAIRING_READINESS_UNAVAILABLE");

  let payload;
  try {
    payload = await readJsonLimited(response.body, 1024);
  } catch {
    fail("PAIRING_READINESS_SCHEMA");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.protocol !== 2 ||
    payload.pairing_config !== "ready"
  ) {
    fail("PAIRING_READINESS_SCHEMA");
  }
  return { state: "configured_not_device_ready" };
}
