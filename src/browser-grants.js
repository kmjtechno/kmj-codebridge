// Pure, deny-by-default validator for expiring, per-device browser action
// grants (issue #575, first slice). It launches no browser, opens no socket,
// reads no profile or credential and is NOT wired into any MCP tool yet: a
// grant here is a data check, never proof that an interactive session exists.
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { isPublicReleaseAddress } from "./update.js";

export const BROWSER_GRANT_SCOPES = Object.freeze(["read", "click", "type"]);
export const BROWSER_GRANT_MIN_TTL_MS = 10_000;
export const BROWSER_GRANT_MAX_TTL_MS = 15 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

// One exact HTTPS origin: no credentials, path, query or fragment, only the
// default port, a registrable-looking DNS name (never an IP literal, which also
// blocks decimal/hex/IPv6 tricks because the URL parser normalizes them first).
export function validateGrantOrigin(value) {
  if (typeof value !== "string" || value.length > 253 + 8)
    fail("BROWSER_GRANT_ORIGIN_INVALID");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("BROWSER_GRANT_ORIGIN_INVALID");
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin ||
    host !== host.toLowerCase() ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !/^[a-z0-9.-]+$/.test(host)
  )
    fail("BROWSER_GRANT_ORIGIN_REJECTED");
  return url.origin;
}

export function createBrowserGrant(
  { tenant, device, project, origin, scopes, ttlMs } = {},
  { now = Date.now, idFactory = randomUUID } = {},
) {
  if (
    ![tenant, device, project].every((v) => typeof v === "string" && ID.test(v))
  )
    fail("BROWSER_GRANT_SUBJECT_INVALID");
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !BROWSER_GRANT_SCOPES.includes(scope))
  )
    fail("BROWSER_GRANT_SCOPE_INVALID");
  if (
    !Number.isInteger(ttlMs) ||
    ttlMs < BROWSER_GRANT_MIN_TTL_MS ||
    ttlMs > BROWSER_GRANT_MAX_TTL_MS
  )
    fail("BROWSER_GRANT_TTL_INVALID");
  const issuedAt = now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0)
    fail("BROWSER_GRANT_CLOCK_INVALID");
  return Object.freeze({
    id: String(idFactory()),
    tenant,
    device,
    project,
    origin: validateGrantOrigin(origin),
    scopes: Object.freeze([...scopes]),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  });
}

// Every field of the request must match the grant exactly. Anything not in
// read/click/type (submit, upload, download, purchase, ...) has no scope and is
// denied. A sensitive input (password, payment, one-time code) additionally
// needs a consent id supplied by the trusted host, never by the AI request.
export function authorizeBrowserAction(
  grant,
  request,
  { now = Date.now, isRevoked = () => false, consentedActionId = null } = {},
) {
  if (
    !grant ||
    typeof grant !== "object" ||
    !request ||
    typeof request !== "object"
  )
    fail("BROWSER_GRANT_DENIED");
  const at = now();
  if (!Number.isSafeInteger(at) || at < grant.issuedAt)
    fail("BROWSER_GRANT_CLOCK_INVALID");
  if (at >= grant.expiresAt) fail("BROWSER_GRANT_EXPIRED");
  if (isRevoked(grant.id) !== false) fail("BROWSER_GRANT_REVOKED");
  if (
    request.tenant !== grant.tenant ||
    request.device !== grant.device ||
    request.project !== grant.project
  )
    fail("BROWSER_GRANT_SUBJECT_MISMATCH");
  if (
    !BROWSER_GRANT_SCOPES.includes(request.action) ||
    !grant.scopes.includes(request.action)
  )
    fail("BROWSER_GRANT_ACTION_NOT_ALLOWED");
  assertSameOrigin(grant, request.url);
  if (request.sensitive === true) {
    if (
      typeof request.actionId !== "string" ||
      !ID.test(request.actionId) ||
      consentedActionId !== request.actionId
    )
      fail("BROWSER_GRANT_CONSENT_REQUIRED");
  }
  return true;
}

function assertSameOrigin(grant, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("BROWSER_GRANT_URL_INVALID");
  }
  if (url.username !== "" || url.password !== "")
    fail("BROWSER_GRANT_URL_INVALID");
  if (url.origin !== grant.origin) fail("BROWSER_GRANT_ORIGIN_MISMATCH");
}

// A navigation may not leave the granted origin, including through a redirect.
export function authorizeBrowserNavigation(grant, requestedUrl, finalUrl) {
  assertSameOrigin(grant, requestedUrl);
  try {
    assertSameOrigin(grant, finalUrl);
  } catch {
    fail("BROWSER_GRANT_REDIRECT_OFF_ORIGIN");
  }
  return true;
}

// DNS-rebinding / SSRF guard for the future runner: every resolved address must
// be a public IPv4 address. IPv6, empty or mixed answers fail closed.
export function assertResolvedAddressesPublic(addresses) {
  if (
    !Array.isArray(addresses) ||
    addresses.length < 1 ||
    addresses.some(
      (entry) =>
        !isPublicReleaseAddress(entry?.address) || Number(entry?.family) !== 4,
    )
  )
    fail("BROWSER_GRANT_ADDRESS_REJECTED");
  return true;
}

// Bounded, in-memory registry of active grants for one device process. A grant
// that was never registered, was revoked, or has expired is denied, so a
// forged or replayed grant object cannot pass. Nothing is persisted: a restart
// drops every grant (fail closed), and the owner must issue a new one.
export const BROWSER_GRANT_MAX_ACTIVE = 16;

export class BrowserGrantRegistry {
  #active = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") fail("BROWSER_GRANT_CLOCK_INVALID");
    this.#now = now;
  }

  #prune() {
    const at = this.#now();
    for (const [id, grant] of this.#active)
      if (at >= grant.expiresAt) this.#active.delete(id);
  }

  register(grant) {
    this.#prune();
    if (
      !grant ||
      typeof grant.id !== "string" ||
      !Object.isFrozen(grant) ||
      this.#active.has(grant.id)
    )
      fail("BROWSER_GRANT_REGISTER_REJECTED");
    if (this.#active.size >= BROWSER_GRANT_MAX_ACTIVE)
      fail("BROWSER_GRANT_CAPACITY_REACHED");
    this.#active.set(grant.id, grant);
    return grant.id;
  }

  revoke(id) {
    return this.#active.delete(id);
  }

  revokeAll({ tenant, device, project } = {}) {
    let revoked = 0;
    for (const [id, grant] of this.#active)
      if (
        (tenant === undefined || grant.tenant === tenant) &&
        (device === undefined || grant.device === device) &&
        (project === undefined || grant.project === project)
      ) {
        this.#active.delete(id);
        revoked++;
      }
    return revoked;
  }

  // Read-only snapshot for status reporting: scoped to tenant/device/project,
  // never returns anything that could be replayed (callers authorize by id only
  // against this registry, and ids are not credentials to other processes).
  list({ tenant, device, project } = {}) {
    this.#prune();
    return [...this.#active.values()]
      .filter(
        (g) =>
          (tenant === undefined || g.tenant === tenant) &&
          (device === undefined || g.device === device) &&
          (project === undefined || g.project === project),
      )
      .map((g) => ({
        id: g.id,
        origin: g.origin,
        scopes: [...g.scopes],
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
      }));
  }

  get size() {
    this.#prune();
    return this.#active.size;
  }

  // Authorize by grant id against the registered copy, never a caller object.
  authorize(grantId, request, { consentedActionId = null } = {}) {
    this.#prune();
    const grant = this.#active.get(grantId);
    if (!grant) fail("BROWSER_GRANT_UNKNOWN");
    return authorizeBrowserAction(grant, request, {
      now: this.#now,
      consentedActionId,
    });
  }
}
