import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { readJsonLimited } from "./http.js";
import { fail } from "./errors.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const permission = z.enum(["read", "write", "execute"]);
const gatewayOrigin = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === "/" || url.pathname === "")
      );
    },
    "Gateway must be a canonical HTTPS origin",
  );
const beginSchema = z.object({
  device_code: z.string().min(32).max(4096),
  user_code: z.string().min(4).max(32),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().min(60).max(1800),
  interval: z.number().int().min(1).max(30).default(5),
});
const successSchema = z.object({
  gateway: gatewayOrigin.optional(),
  agent: z.object({
    token: z.string().min(32).max(4096),
    id,
    tenant: id,
  }),
  projects: z.array(z.object({ id })).min(1).max(100),
  permissions: z.array(permission).min(1),
  credential_expires_at: z.string().datetime().optional(),
});

function endpoint(base, path) {
  const url = new URL(path, base);
  const origin = new URL(base);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    url.origin !== origin.origin
  )
    fail("ENROLLMENT_URL");
  return url;
}

export function createEnrollmentProof() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function beginDeviceEnrollment(base, request, options = {}) {
  const proof = options.proof ?? createEnrollmentProof();
  const url = endpoint(base, "/api/codebridge/v1/device-enrollments");
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      product: "KMJ_CODEBRIDGE",
      device: request.device,
      project: request.project,
      requested_permissions: request.permissions,
      code_challenge: proof.challenge,
      code_challenge_method: "S256",
    }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (response.status !== 201) fail("ENROLLMENT_UNAVAILABLE");
  const data = beginSchema.parse(await readJsonLimited(response.body, 16384));
  const verification = new URL(data.verification_uri);
  if (
    verification.protocol !== "https:" ||
    verification.origin !== new URL(base).origin
  )
    fail("ENROLLMENT_VERIFICATION_URL");
  if (data.verification_uri_complete) {
    const complete = new URL(data.verification_uri_complete);
    if (
      complete.protocol !== "https:" ||
      complete.origin !== verification.origin
    )
      fail("ENROLLMENT_VERIFICATION_URL");
  }
  return {
    ...data,
    verifier: proof.verifier,
    expires_at_ms: Date.now() + data.expires_in * 1000,
  };
}

export async function pollDeviceEnrollment(
  base,
  handle,
  request,
  options = {},
) {
  if (Date.now() >= handle.expires_at_ms) fail("ENROLLMENT_EXPIRED");
  const url = endpoint(base, "/api/codebridge/v1/device-enrollments/token");
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      product: "KMJ_CODEBRIDGE",
      device_code: handle.device_code,
      code_verifier: handle.verifier,
      device_id: request.device.id,
    }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (response.status === 428) return { state: "pending" };
  if (response.status === 429) return { state: "slow_down" };
  if (response.status === 410) fail("ENROLLMENT_EXPIRED");
  if (response.status === 403) fail("ENROLLMENT_DENIED");
  if (!response.ok) fail("ENROLLMENT_INVALID");
  const data = successSchema.parse(await readJsonLimited(response.body, 32768));
  if (data.agent.id !== request.device.id) fail("ENROLLMENT_BINDING");
  if (!data.projects.some((p) => p.id === request.project.id))
    fail("ENROLLMENT_BINDING");
  for (const permission of request.permissions)
    if (!data.permissions.includes(permission)) fail("ENROLLMENT_BINDING");
  return { state: "approved", ...data };
}
