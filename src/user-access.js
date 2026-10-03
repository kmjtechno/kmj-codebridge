import { createHash } from "node:crypto";
import { readJsonLimited } from "./http.js";

const id = /^[A-Za-z0-9_-]{1,64}$/;
const allowedPermissions = new Set(["read", "write", "execute"]);

export function createUserIntrospector(config) {
  const cache = new Map();
  return async (authorization, subject) => {
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ") ||
      authorization.length > 16384
    )
      return null;
    const tokenHash = createHash("sha256")
      .update(authorization.slice(7))
      .digest("hex");
    const cached = cache.get(tokenHash);
    if (
      cached &&
      Date.now() - cached.verifiedAt < config.cacheSeconds * 1000 &&
      cached.user.subject === subject
    )
      return cached.user;

    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      cache.delete(tokenHash);
      return null;
    }

    let data;
    try {
      data = await readJsonLimited(response.body, 32768);
    } catch {
      return null;
    }
    if (
      data?.active !== true ||
      data.user_id !== subject ||
      !Array.isArray(data.memberships) ||
      data.memberships.length < 1 ||
      data.memberships.length > 100
    )
      return null;

    const memberships = [];
    for (const membership of data.memberships) {
      if (
        !membership ||
        typeof membership.tenant_id !== "string" ||
        !id.test(membership.tenant_id) ||
        !Array.isArray(membership.permissions) ||
        membership.permissions.length < 1 ||
        membership.permissions.some(
          (permission) =>
            typeof permission !== "string" ||
            !allowedPermissions.has(permission),
        )
      )
        return null;
      let devices;
      if (membership.devices !== undefined) {
        const grants = membership.devices;
        if (
          grants === null ||
          typeof grants !== "object" ||
          Array.isArray(grants) ||
          Object.keys(grants).length > 100 ||
          Object.entries(grants).some(
            ([device, projects]) =>
              !id.test(device) ||
              !Array.isArray(projects) ||
              projects.length > 100 ||
              projects.some(
                (project) => typeof project !== "string" || !id.test(project),
              ),
          )
        )
          return null;
        devices = Object.fromEntries(
          Object.entries(grants).map(([device, projects]) => [
            device,
            [...new Set(projects)],
          ]),
        );
      }
      memberships.push({
        tenant: membership.tenant_id,
        permissions: [...new Set(membership.permissions)],
        ...(devices === undefined ? {} : { devices }),
      });
    }

    const user = {
      id: `oauth-${tokenHash.slice(0, 24)}`,
      subject,
      memberships,
      permissions: [
        ...new Set(memberships.flatMap((item) => item.permissions)),
      ],
      dynamic: true,
    };
    cache.set(tokenHash, { user, verifiedAt: Date.now() });
    return user;
  };
}
