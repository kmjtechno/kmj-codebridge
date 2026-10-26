// Fail-closed, no-credential preflight BEFORE creating an owner pairing.
// A legacy Main Platform response (404) must not create an orphan device grant.
import { readJsonLimited } from "./http.js";
import { fail } from "./errors.js";

const READY_PATH = "/api/codebridge/v1/device-enrollments/readiness";
const AGENT_HEALTH_PATH = "/agent/health";

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
  // Main Platform readiness validates configuration, not whether an actual
  // public gateway route is mounted and enforces agent authentication. Check
  // that BEFORE creating a short-lived pairing or a stranded server grant.
  // This request is anonymous; never read its response body or send a token.
  let challenge;
  try {
    challenge = await (options.fetch ?? fetch)(
      new URL(AGENT_HEALTH_PATH, origin),
      {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{}",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      },
    );
  } catch {
    fail("PAIRING_AGENT_ROUTE_NETWORK");
  }
  // The real CodeBridge gateway challenges anonymous POST /agent/health
  // with 401. A 200 is an unsafe unprotected route, not success.
  if (challenge.status === 200) fail("PAIRING_AGENT_ROUTE_UNPROTECTED");
  if (challenge.status !== 401) fail("PAIRING_AGENT_ROUTE_UNAVAILABLE");

  return { state: "configured_not_device_ready" };
}
