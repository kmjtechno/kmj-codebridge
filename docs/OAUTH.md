# OAuth resource-server integration

KMJ CodeBridge can validate OAuth JWT access tokens at the MCP gateway. KMJ Main
Platform provides the matching authorization/account-linking service for the hosted
KMJ deployment; self-hosted operators may use another compatible issuer.

## Gateway configuration

Set:

- `oauth.issuer` to the exact HTTPS authorization-server issuer;
- `oauth.resource` to the canonical public MCP resource URL, ending in `/mcp`;
- exactly one of `oauth.jwks` (pinned public JWKs) or `oauth.jwksUri`.

When `jwksUri` is used it must share the issuer origin. Supported JWT signing
algorithms are EdDSA, RS256, and ES256. Private/symmetric signing material is rejected
from gateway configuration.

Access tokens are checked for signature, issuer, audience, `sub`, `exp`, `iat`,
and timing validity. The hosted permission scopes are:

- `codebridge:read`
- `codebridge:write`
- `codebridge:execute`

The gateway never treats a Main Platform billing/license envelope as an OAuth access
token.

### Which scopes the first sign-in asks for

By default a caller with no valid token is challenged only for the scope of the tool
it called (`codebridge:read` for a read tool). A client is expected to step up later
when a write or execute tool returns an `insufficient_scope` challenge.

Some clients never act on that later challenge. Observed on 14 November 2026: a
Claude.ai connector sign-in was granted `codebridge:read` only, and every write tool
then returned `ACCESS_DENIED` with reason `OAUTH_SCOPE_NOT_GRANTED`, while a ChatGPT
sign-in on the same account held all three scopes.

For such clients set the optional `oauth.signInScopes` to `"all"`. The sign-in
challenge then asks for all three CodeBridge scopes at once. It grants nothing by
itself: the authorization server and the account's own permissions still decide, and a
token that was granted less is still refused, with the same exact step-up challenge.
The default, `"requested-tool"`, keeps the current behaviour. This is an operator
choice about how much a first consent screen asks for; the option has not been tested
against a live Claude client yet.

## User and device authorization

OAuth identity is only the first boundary. The gateway maps the authenticated subject
to tenant/device/project permissions. It may use administrator-configured users or the
Main Platform user-introspection endpoint. Device agents authenticate independently and
may likewise be resolved through the device-credential introspection endpoint.

A model-supplied tenant/device/project value never grants access by itself.

## Discovery

The gateway publishes RFC 9728 protected-resource metadata at:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

Unauthenticated MCP requests receive a `WWW-Authenticate` challenge carrying
`resource_metadata` and the required scopes. OpenAI-specific MCP metadata is an
extension only; authorization is not client-specific.

The hosted resource used by current client setup is:

```text
https://kmjtechno.com/mcp
```

## Authorization-server requirements

A compatible issuer must provide the discovery and authorization capabilities required
by the client, including PKCE S256 and supported client registration. KMJ Main Platform
source includes the CodeBridge OAuth/OIDC server, dynamic client registration, account
linking, userinfo, and signed access/ID token paths used by the hosted deployment.

Observed live evidence on 3 October 2026 includes a successful Claude Code OAuth login
and a successful Claude web custom-connector authorization against the hosted MCP
resource. This proves those client/account-linking paths, not every deployment mode or
future directory review.

Claude Desktop third-party-inference Gateway profiles configure remote MCP servers in
their managed connector settings; record a successful `Sign in & test` and real tool
call before treating that specific deployment path as verified.

## Tests and operations

Repository tests cover signed-token verification, scope restriction, malformed/forged
tokens, wrong audiences, subject mapping, protected-resource discovery, local/remote
JWKS configuration, and hosted startup constraints. Main Platform has separate OAuth
and OIDC regression coverage.

Keep access tokens short-lived, rotate issuer keys through the issuer/JWKS contract,
and verify production issuer/resource/allowed-host settings before every rollout.
