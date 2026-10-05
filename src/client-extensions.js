// Client-facing protocol extensions, kept outside core authorization.
//
// Every MCP client receives the same tools, schemas, annotations and errors.
// The OpenAI Apps SDK additionally reads `_meta.securitySchemes` on tools and
// `_meta["mcp/www_authenticate"]` on insufficient-scope results. MCP `_meta` is
// an open extension point, so other clients (Claude.ai, Claude Desktop, Claude
// Code) ignore these keys. Authorization decisions never depend on which client
// is connected; these helpers only describe decisions already made.
import { oauthChallenge } from "./auth.js";

export function toolSecurityMeta(oauth, access) {
  if (!oauth) return {};
  const securitySchemes = [
    { type: "oauth2", scopes: [`codebridge:${access}`] },
  ];
  return {
    securitySchemes,
    _meta: {
      securitySchemes,
    },
  };
}

export function insufficientScopeMeta(oauth, user, access) {
  const scope = `codebridge:${access}`;
  if (!oauth || user.grantedScopes.includes(scope)) return {};
  return {
    _meta: {
      "mcp/www_authenticate": [
        oauthChallenge(oauth, scope) + ', error="insufficient_scope"',
      ],
    },
  };
}
