# Browser local grants (issue #575, slices 1-2) — SOURCE ONLY

Status: **source-only data validator.** `src/browser-grants.js` is not imported by
any MCP tool, gateway route or agent. It launches no browser, opens no socket and
reads no profile, cookie or credential. A valid grant here is not proof that an
interactive session exists, and nothing in this slice makes a browser action
possible.

## What it enforces (tested in `tests/browser-grants.test.js`)

- One exact HTTPS origin per grant: no credentials, path, query, fragment or
  non-default port; no IP literal (decimal/hex/IPv6 forms normalize to IPs and are
  rejected), no `localhost`, single-label host, or `.local`/`.internal`/`.lan`
  names.
- Scopes are only `read`, `click`, `type`. `submit`, `upload`, `download`,
  `purchase` and anything else cannot be granted.
- TTL between 10 s and 15 min. Expired, revoked (hook must return exactly `false`
  to allow) or clock-skewed grants are denied.
- tenant, device and project must all equal the grant's. The request URL origin
  must equal the grant origin (subdomain, scheme, port or credentials differ ->
  denied).
- Navigation and redirects may not leave the granted origin.
- Sensitive input needs a consent id supplied by the trusted host for that exact
  action id; the AI request cannot consent for itself.
- `assertResolvedAddressesPublic` fails closed unless every resolved address is a
  public IPv4 (private, loopback, link-local/metadata, CGNAT, IPv6 and mixed
  answers rejected). It reuses `isPublicReleaseAddress`.

## Slice 2: bounded in-memory registry

`BrowserGrantRegistry` authorizes by grant **id** against the copy it registered,
never a caller-supplied object, so a forged or replayed grant is `GRANT_UNKNOWN`.
Only frozen grants made by `createBrowserGrant` register; duplicates are refused;
at most 16 are active; expired grants are pruned on every call; `revoke` and
scoped `revokeAll` (tenant/device/project, empty scope = revoke everything) take
effect on the next call. Nothing is persisted: a process restart drops all grants,
which fails closed. Tests cover six mutations of these checks.

## Not done (still pending for #575)

Grant issuance from the Main Platform, any durable or cross-process revocation, the
Playwright launcher on ephemeral profiles, enforcing the origin and address checks
inside a real browser (a Playwright `--allowed-origins` flag is not a security
boundary), receipts, a real Windows/Linux/macOS smoke test, and any benchmark.

## Slice 3: read-only `browser_grant_status` (DRAFT, owner review)

The dispatcher holds one in-memory `BrowserGrantRegistry`; the read-only MCP tool
`browser_grant_status` lists its active grants for this device/project (id,
origin, scopes, issue/expiry time). There is deliberately **no** MCP path that
creates, extends or uses a grant: issuance stays `TRUSTED_HOST_ONLY`, so the list
is empty until a trusted host component registers one, and the tool reports
`browserLaunch: NOT_AVAILABLE`. This slice widens no browser permission; it only
makes the (currently empty) grant state observable. Issuance, durable revocation
and the launcher remain pending as listed above.
