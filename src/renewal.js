import { readJsonLimited } from "./http.js";
import { verifyEntitlement } from "./license.js";
import { fail } from "./errors.js";
export async function requestRenewal(
  config,
  keys,
  binding,
  sequence,
  options = {},
) {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("LICENSE_RENEWAL_URL");
  if (typeof config.credential !== "string" || config.credential.length < 32)
    fail("LICENSE_RENEWAL_CREDENTIAL");
  const response = await (options.fetch ?? fetch)(url.href, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${config.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ product: "KMJ_CODEBRIDGE", ...binding, sequence }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
  if (!response.ok) fail("LICENSE_RENEWAL_UNAVAILABLE");
  const data = await readJsonLimited(response.body, 32768);
  const claims = verifyEntitlement(
    data?.token,
    keys,
    binding,
    options.now ?? Math.floor(Date.now() / 1000),
  );
  if (claims.sequence <= sequence) fail("LICENSE_REPLAY");
  if (claims.state !== "ACTIVE") fail("LICENSE_RENEWAL_NOT_ACTIVE");
  return { token: data.token, claims };
}
