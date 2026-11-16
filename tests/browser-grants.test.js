import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_GRANT_MAX_TTL_MS,
  assertResolvedAddressesPublic,
  authorizeBrowserAction,
  authorizeBrowserNavigation,
  createBrowserGrant,
  validateGrantOrigin,
} from "../src/browser-grants.js";

const T0 = 1_800_000_000_000;
const subject = { tenant: "t1", device: "dev1", project: "proj1" };
const make = (over = {}) =>
  createBrowserGrant(
    {
      ...subject,
      origin: "https://app.example.com",
      scopes: ["read", "click"],
      ttlMs: 60_000,
      ...over,
    },
    { now: () => T0, idFactory: () => "grant-1" },
  );
const act = (over = {}) => ({
  ...subject,
  action: "read",
  url: "https://app.example.com/page?x=1",
  ...over,
});
const code = (re) => (error) => re.test(error.message ?? String(error));

test("a valid grant allows an in-scope action on the exact origin", () => {
  const grant = make();
  assert.equal(grant.expiresAt, T0 + 60_000);
  assert.equal(
    authorizeBrowserAction(grant, act(), { now: () => T0 + 1 }),
    true,
  );
  assert.equal(
    authorizeBrowserAction(grant, act({ action: "click" }), {
      now: () => T0 + 1,
    }),
    true,
  );
});

test("origin must be one exact public-looking HTTPS origin", () => {
  for (const bad of [
    "http://app.example.com",
    "https://app.example.com/path",
    "https://app.example.com/?q=1",
    "https://app.example.com/#h",
    "https://app.example.com:8443",
    "https://user:pw@app.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://printer.local",
    "https://db.internal",
    "https://intranet",
    "https://APP.example.com",
    "app.example.com",
    "",
    42,
  ])
    assert.throws(
      () => validateGrantOrigin(bad),
      /BROWSER_GRANT_ORIGIN_/,
      String(bad),
    );
  assert.equal(
    validateGrantOrigin("https://app.example.com"),
    "https://app.example.com",
  );
});

test("scope, ttl and subject are validated; submit/upload/purchase cannot be granted", () => {
  assert.throws(() => make({ scopes: [] }), /SCOPE_INVALID/);
  assert.throws(() => make({ scopes: ["read", "read"] }), /SCOPE_INVALID/);
  for (const bad of ["submit", "upload", "download", "purchase", "*", "admin"])
    assert.throws(() => make({ scopes: [bad] }), /SCOPE_INVALID/, bad);
  assert.throws(() => make({ ttlMs: 1000 }), /TTL_INVALID/);
  assert.throws(
    () => make({ ttlMs: BROWSER_GRANT_MAX_TTL_MS + 1 }),
    /TTL_INVALID/,
  );
  assert.throws(() => make({ ttlMs: 60_000.5 }), /TTL_INVALID/);
  assert.throws(() => make({ tenant: "../x" }), /SUBJECT_INVALID/);
  assert.throws(() => make({ device: undefined }), /SUBJECT_INVALID/);
});

test("expiry and revocation take effect immediately", () => {
  const grant = make();
  assert.throws(
    () => authorizeBrowserAction(grant, act(), { now: () => grant.expiresAt }),
    code(/EXPIRED/),
  );
  assert.throws(
    () => authorizeBrowserAction(grant, act(), { now: () => T0 - 1 }),
    /CLOCK_INVALID/,
  );
  assert.throws(
    () =>
      authorizeBrowserAction(grant, act(), {
        now: () => T0 + 1,
        isRevoked: (id) => id === "grant-1",
      }),
    /REVOKED/,
  );
  // A revocation hook that returns anything but exactly false denies.
  assert.throws(
    () =>
      authorizeBrowserAction(grant, act(), {
        now: () => T0 + 1,
        isRevoked: () => undefined,
      }),
    /REVOKED/,
  );
});

test("tenant, device and project must all match; other tenants are denied", () => {
  const grant = make();
  for (const field of ["tenant", "device", "project"])
    assert.throws(
      () =>
        authorizeBrowserAction(grant, act({ [field]: "other" }), {
          now: () => T0 + 1,
        }),
      /SUBJECT_MISMATCH/,
      field,
    );
});

test("actions outside the granted scope are denied", () => {
  const grant = make();
  assert.throws(
    () =>
      authorizeBrowserAction(grant, act({ action: "type" }), {
        now: () => T0 + 1,
      }),
    /ACTION_NOT_ALLOWED/,
  );
  for (const action of [
    "submit",
    "upload",
    "download",
    "purchase",
    "eval",
    undefined,
  ])
    assert.throws(
      () =>
        authorizeBrowserAction(grant, act({ action }), { now: () => T0 + 1 }),
      /ACTION_NOT_ALLOWED/,
      String(action),
    );
});

test("a different origin, subdomain, scheme or embedded credentials are denied", () => {
  const grant = make();
  for (const url of [
    "https://evil.example.com/",
    "https://sub.app.example.com/",
    "http://app.example.com/",
    "https://app.example.com.evil.net/",
    "https://app.example.com:8443/",
    "https://u:p@app.example.com/",
  ])
    assert.throws(
      () => authorizeBrowserAction(grant, act({ url }), { now: () => T0 + 1 }),
      /ORIGIN_MISMATCH|URL_INVALID/,
      url,
    );
  assert.throws(
    () =>
      authorizeBrowserAction(grant, act({ url: "not a url" }), {
        now: () => T0 + 1,
      }),
    /URL_INVALID/,
  );
});

test("sensitive input needs a host-supplied consent for that exact action", () => {
  const grant = make({ scopes: ["type"] });
  const request = act({ action: "type", sensitive: true, actionId: "act-7" });
  assert.throws(
    () => authorizeBrowserAction(grant, request, { now: () => T0 + 1 }),
    /CONSENT_REQUIRED/,
  );
  assert.throws(
    () =>
      authorizeBrowserAction(grant, request, {
        now: () => T0 + 1,
        consentedActionId: "act-8",
      }),
    /CONSENT_REQUIRED/,
  );
  assert.equal(
    authorizeBrowserAction(grant, request, {
      now: () => T0 + 1,
      consentedActionId: "act-7",
    }),
    true,
  );
  // The AI cannot self-consent through the request body.
  assert.throws(
    () =>
      authorizeBrowserAction(
        grant,
        { ...request, consent: true, consentedActionId: "act-7" },
        { now: () => T0 + 1 },
      ),
    /CONSENT_REQUIRED/,
  );
});

test("redirects may not leave the granted origin", () => {
  const grant = make();
  assert.equal(
    authorizeBrowserNavigation(
      grant,
      "https://app.example.com/a",
      "https://app.example.com/b",
    ),
    true,
  );
  assert.throws(
    () =>
      authorizeBrowserNavigation(
        grant,
        "https://app.example.com/a",
        "https://login.evil.net/",
      ),
    /REDIRECT_OFF_ORIGIN/,
  );
  assert.throws(
    () =>
      authorizeBrowserNavigation(
        grant,
        "https://app.example.com/a",
        "http://169.254.169.254/latest/meta-data",
      ),
    /REDIRECT_OFF_ORIGIN/,
  );
  assert.throws(
    () =>
      authorizeBrowserNavigation(
        grant,
        "https://evil.net/",
        "https://app.example.com/",
      ),
    /ORIGIN_MISMATCH/,
  );
});

test("resolved addresses must all be public IPv4 (rebinding / metadata / private ranges)", () => {
  const v4 = (address) => ({ address, family: 4 });
  assert.equal(assertResolvedAddressesPublic([v4("93.184.216.34")]), true);
  for (const bad of [
    [],
    null,
    [v4("127.0.0.1")],
    [v4("10.0.0.5")],
    [v4("192.168.1.1")],
    [v4("172.16.0.1")],
    [v4("169.254.169.254")],
    [v4("100.64.0.1")],
    [v4("93.184.216.34"), v4("10.0.0.5")],
    [{ address: "2606:2800:220:1::1", family: 6 }],
    [{ address: "93.184.216.34", family: 6 }],
    [{ address: "93.184.216.34" }],
  ])
    assert.throws(
      () => assertResolvedAddressesPublic(bad),
      /ADDRESS_REJECTED/,
      JSON.stringify(bad),
    );
});

test("grants are immutable", () => {
  const grant = make();
  assert.throws(() => {
    "use strict";
    grant.origin = "https://evil.net";
  }, TypeError);
  assert.throws(() => {
    "use strict";
    grant.scopes.push("type");
  }, TypeError);
});
