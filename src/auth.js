import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
export const scopes = ["read", "write", "execute"].map(
  (p) => `codebridge:${p}`,
);
export function createOAuthVerifier(config, users, resolveUser) {
  const keys = config.jwksUri
    ? createRemoteJWKSet(new URL(config.jwksUri), {
        timeoutDuration: 3000,
        cooldownDuration: 30000,
        cacheMaxAge: 600000,
      })
    : createLocalJWKSet(config.jwks);
  return async (authorization) => {
    try {
      if (
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ") ||
        authorization.length > 16384
      )
        return null;
      const { payload } = await jwtVerify(authorization.slice(7), keys, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["EdDSA", "RS256", "ES256"],
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 0,
      });
      if (payload.iat > Math.floor(Date.now() / 1000)) return null;
      const user =
        users.find((u) => u.subject === payload.sub) ??
        (resolveUser ? await resolveUser(authorization, payload.sub) : null);
      if (!user || typeof payload.scope !== "string") return null;
      const granted = new Set(payload.scope.split(" "));
      const filterPermissions = (permissions) =>
        permissions.filter((permission) =>
          granted.has(`codebridge:${permission}`),
        );
      const memberships = user.memberships?.map((membership) => ({
        ...membership,
        permissions: filterPermissions(membership.permissions),
      }));
      const permissions = memberships
        ? [...new Set(memberships.flatMap((membership) => membership.permissions))]
        : filterPermissions(user.permissions);
      return {
        ...user,
        ...(memberships ? { memberships } : {}),
        grantedScopes: [...granted],
        permissions,
      };
    } catch {
      return null;
    }
  };
}
export function oauthMetadata(config) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: scopes,
  };
}
export function oauthChallenge(config, scope) {
  const url = new URL("/.well-known/oauth-protected-resource", config.resource)
    .href;
  return `Bearer resource_metadata="${url}", scope="${scope ?? scopes.join(" ")}"`;
}
