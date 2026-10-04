import { createOAuthVerifier, oauthMetadata, oauthChallenge } from "./auth.js";
import { createUserIntrospector } from "./user-access.js";
import {
  insufficientScopeMeta,
  toolSecurityMeta,
} from "./client-extensions.js";
import { readJsonLimited } from "./http.js";
import http from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { gatewaySchema } from "./config.js";
import { definitions } from "./tools.js";
import { createGitHubBridge, githubDefinitions } from "./github.js";
import { fail, publicError } from "./errors.js";
import { VERSION } from "./version.js";
function identify(req, records) {
  const raw = req.headers.authorization;
  if (
    typeof raw !== "string" ||
    !raw.startsWith("Bearer ") ||
    raw.length > 1024
  )
    return null;
  const digest = createHash("sha256").update(raw.slice(7)).digest();
  return (
    records.find((r) =>
      timingSafeEqual(digest, Buffer.from(r.tokenHash, "hex")),
    ) ?? null
  );
}
function json(res, status, data) {
  if (!res.writableEnded) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
}
const body = readJsonLimited;
export async function startGateway(rawConfig) {
  const config = gatewaySchema.parse(rawConfig);
  if (
    new Set(config.agents.map((a) => a.id)).size !== config.agents.length ||
    new Set(
      [...config.users, ...config.agents]
        .map((a) => a.tokenHash)
        .filter(Boolean),
    ).size !==
      [...config.users, ...config.agents].filter((a) => a.tokenHash).length
  )
    fail("DUPLICATE_IDENTITY");
  const resolveOAuthUser = config.userIntrospection
    ? createUserIntrospector(config.userIntrospection)
    : null;
  const verifyOAuth = config.oauth
    ? createOAuthVerifier(config.oauth, config.users, resolveOAuthUser)
    : null;
  const githubDispatch = createGitHubBridge(config.github);
  const enabledGitHubDefinitions = config.github?.publicReadOnly
    ? Object.fromEntries(
        Object.entries(githubDefinitions).filter(
          ([, definition]) => definition.access === "read",
        ),
      )
    : githubDefinitions;
  const allDefinitions = githubDispatch
    ? { ...definitions, ...enabledGitHubDefinitions }
    : definitions;
  let githubReadiness = { checkedAt: 0, ready: false };
  const probeGitHub = async () => {
    if (!githubDispatch) return false;
    const now = Date.now();
    if (now - githubReadiness.checkedAt < 30000) return githubReadiness.ready;
    githubReadiness = { checkedAt: now, ready: false };
    try {
      await githubDispatch("github_repository", {
        repository: config.github.repositories[0],
      });
      githubReadiness.ready = true;
    } catch {
      githubReadiness.ready = false;
    }
    return githubReadiness.ready;
  };
  const agents = new Map(config.agents.map((a) => [a.id, a]));
  const dynamicByToken = new Map();
  const pending = new Map(),
    waiting = new Map(),
    lastSeen = new Map(),
    rate = new Map();
  const membershipFor = (user, tenant) =>
    user.memberships?.find((membership) => membership.tenant === tenant) ??
    (user.tenant === tenant ? user : undefined);
  const allowedProjects = (user, agent) => {
    const membership = membershipFor(user, agent.tenant);
    if (!membership) return undefined;
    if (user.dynamic && membership.devices !== undefined)
      return Object.hasOwn(membership.devices, agent.id)
        ? membership.devices[agent.id]
        : undefined;
    return (
      membership.devices?.[agent.id] ??
      (agent.dynamic ? agent.projects : undefined)
    );
  };
  const allowedPermissions = (user, agent) =>
    membershipFor(user, agent.tenant)?.permissions ?? [];

  async function identifyAgent(req) {
    const configured = identify(req, config.agents);
    if (configured) return configured;
    if (!config.agentIntrospection) return null;

    const raw = req.headers.authorization;
    if (
      typeof raw !== "string" ||
      !raw.startsWith("Bearer ") ||
      raw.length > 4096
    )
      return null;
    const tokenHash = createHash("sha256").update(raw.slice(7)).digest("hex");
    const cached = dynamicByToken.get(tokenHash);
    if (
      cached &&
      Date.now() - cached.verifiedAt <
        config.agentIntrospection.cacheSeconds * 1000
    )
      return cached.agent;

    let response;
    try {
      response = await fetch(config.agentIntrospection.endpoint, {
        method: "POST",
        headers: {
          authorization: raw,
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
      dynamicByToken.delete(tokenHash);
      return null;
    }
    let data;
    try {
      data = await readJsonLimited(response.body, 16384);
    } catch {
      return null;
    }
    if (
      data?.active !== true ||
      typeof data.device_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(data.device_id) ||
      typeof data.tenant_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(data.tenant_id) ||
      !Array.isArray(data.projects) ||
      data.projects.length < 1 ||
      data.projects.length > 100 ||
      data.projects.some(
        (project) =>
          typeof project !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(project),
      ) ||
      !Array.isArray(data.permissions) ||
      data.permissions.length < 1 ||
      data.permissions.some(
        (permission) => !["read", "write", "execute"].includes(permission),
      )
    )
      return null;

    const existing = agents.get(data.device_id);
    if (
      existing &&
      (!existing.dynamic ||
        existing.tenant !== data.tenant_id ||
        existing.tokenHash !== tokenHash)
    )
      return null;

    const agent = {
      id: data.device_id,
      tenant: data.tenant_id,
      tokenHash,
      projects: [...new Set(data.projects)],
      permissions: [...new Set(data.permissions)],
      dynamic: true,
    };
    agents.set(agent.id, agent);
    dynamicByToken.set(tokenHash, { agent, verifiedAt: Date.now() });
    return agent;
  }

  function authorize(user, args, access) {
    const a = agents.get(args.device);
    const projects = a ? allowedProjects(user, a) : undefined;
    const permissions = a ? allowedPermissions(user, a) : [];
    if (
      !a ||
      !membershipFor(user, a.tenant) ||
      !projects?.includes(args.project) ||
      !permissions.includes(access) ||
      (a.permissions && !a.permissions.includes(access))
    )
      fail("ACCESS_DENIED");
    return a;
  }
  function next(agent) {
    for (const job of pending.values())
      if (job.agent === agent.id && !job.delivered) {
        job.delivered = true;
        return {
          id: job.id,
          tool: job.tool,
          args: job.args,
          permissions: job.permissions,
        };
      }
    return null;
  }
  async function forward(user, name, args) {
    const a = authorize(user, args, definitions[name].access);
    if (
      pending.size >= 256 ||
      [...pending.values()].filter((p) => p.agent === a.id).length >= 16
    )
      fail("GATEWAY_BUSY");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(), { code: "DEVICE_TIMEOUT" }));
      }, config.deviceTimeoutMs);
      pending.set(id, {
        id,
        agent: a.id,
        tool: name,
        args,
        permissions: allowedPermissions(user, a).filter(
          (permission) => !a.permissions || a.permissions.includes(permission),
        ),
        delivered: false,
        resolve: (value) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(value);
        },
        reject: () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("closed"));
        },
      });
      const wake = waiting.get(a.id);
      if (wake) wake();
    });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const allowedHosts = config.allowedHosts.length
        ? config.allowedHosts
        : ["127.0.0.1", "localhost", "[::1]"];
      let hostname;
      try {
        hostname = new URL("http://" + req.headers.host).hostname;
      } catch {
        json(res, 400, { error: "INVALID_HOST" });
        return;
      }
      if (!allowedHosts.includes(hostname)) {
        json(res, 403, { error: "HOST_DENIED" });
        return;
      }
      if (
        req.headers.origin &&
        !config.allowedOrigins.includes(req.headers.origin)
      ) {
        json(res, 403, { error: "ORIGIN_DENIED" });
        return;
      }
      if (
        config.openaiAppsChallenge &&
        req.url === "/.well-known/openai-apps-challenge" &&
        req.method === "GET"
      ) {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(config.openaiAppsChallenge);
        return;
      }
      // RFC 9728: the path-suffixed location is canonical for the /mcp
      // resource; the root location is kept for existing clients.
      if (
        config.oauth &&
        (req.url === "/.well-known/oauth-protected-resource" ||
          req.url === "/.well-known/oauth-protected-resource/mcp") &&
        req.method === "GET"
      ) {
        json(res, 200, oauthMetadata(config.oauth));
        return;
      }
      if (req.url === "/healthz" && req.method === "GET") {
        const githubReady = await probeGitHub();
        json(res, 200, {
          status: "ok",
          version: VERSION,
          capabilities: {
            github: Boolean(githubDispatch),
            githubReady,
          },
        });
        return;
      }
      if (req.url?.startsWith("/agent/")) {
        const a = await identifyAgent(req);
        if (!a) {
          json(res, 401, { error: "UNAUTHORIZED" });
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        const data = await body(req);
        lastSeen.set(a.id, Date.now());
        if (req.url === "/agent/health") {
          json(res, 200, { ok: true });
          return;
        }
        if (req.url === "/agent/poll") {
          if (waiting.has(a.id)) {
            json(res, 409, { error: "POLL_ALREADY_OPEN" });
            return;
          }
          const immediate = next(a);
          if (immediate) {
            json(res, 200, immediate);
            return;
          }
          await new Promise((resolve) => {
            let timer,
              settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              waiting.delete(a.id);
              if (!res.destroyed) json(res, 200, next(a));
              resolve();
            };
            waiting.set(a.id, finish);
            timer = setTimeout(finish, config.pollWaitMs);
            res.once("close", finish);
          });
          return;
        }
        if (req.url === "/agent/result") {
          const p = pending.get(data?.id);
          if (!p || p.agent !== a.id || !p.delivered) {
            json(res, 404, { error: "REQUEST_NOT_FOUND" });
            return;
          }
          if (
            !data.result ||
            typeof data.result !== "object" ||
            !Array.isArray(data.result.content)
          ) {
            json(res, 400, { error: "INVALID_RESULT" });
            return;
          }
          p.resolve(data.result);
          json(res, 200, { ok: true });
          return;
        }
        json(res, 404, { error: "NOT_FOUND" });
        return;
      }
      if (req.url !== "/mcp") {
        json(res, 404, { error: "NOT_FOUND" });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const data = await body(req);
      const publicDiscovery =
        !config.oauth &&
        [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "ping",
        ].includes(data?.method);
      const user = verifyOAuth
        ? await verifyOAuth(req.headers.authorization)
        : identify(req, config.users);
      if (!user && !publicDiscovery) {
        if (config.oauth)
          res.setHeader("WWW-Authenticate", oauthChallenge(config.oauth));
        json(res, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (user) {
        const minute = Math.floor(Date.now() / 60000);
        let quota = rate.get(user.id);
        if (!quota || quota.minute !== minute) {
          quota = { minute, count: 0 };
          rate.set(user.id, quota);
        }
        if (++quota.count > 240) {
          json(res, 429, { error: "RATE_LIMIT" });
          return;
        }
      }
      const mcp = new McpServer({
        name: "kmj-codebridge",
        title: "KMJ CodeBridge",
        version: VERSION,
        description:
          "Secure, project-scoped AI coding across authorized computers and VPSs through one MCP bridge.",
        websiteUrl: "https://kmjtechno.com",
        // Standard MCP `Implementation.icons` (spec 2025-11-25 / SEP-973).
        // Omitted entirely unless the operator configures a real, publicly
        // reachable HTTPS icon URL via `iconUrl` — never a fabricated or
        // guessed path. See docs/CLIENTS.md "Connector and plugin icon
        // behavior" for which clients currently honor this.
        ...(config.iconUrl
          ? { icons: [{ src: config.iconUrl, mimeType: "image/png" }] }
          : {}),
      });
      for (const [name, d] of Object.entries(allDefinitions))
        mcp.registerTool(
          name,
          {
            title: d.title,
            description: d.description,
            inputSchema: d.input,
            ...toolSecurityMeta(config.oauth, d.access),
            annotations: {
              title: d.title,
              readOnlyHint: d.access === "read",
              destructiveHint: d.access !== "read",
              idempotentHint: d.access === "read",
              openWorldHint:
                name === "run_quality_gate" || name.startsWith("github_"),
            },
          },
          async (args) => {
            try {
              if (!user) {
                const authenticate = config.oauth
                  ? [oauthChallenge(config.oauth, `codebridge:${d.access}`)]
                  : null;
                return {
                  isError: true,
                  content: [{ type: "text", text: '{"error":"UNAUTHORIZED"}' }],
                  ...(authenticate
                    ? { _meta: { "mcp/www_authenticate": authenticate } }
                    : {}),
                };
              }
              if (!user.permissions.includes(d.access))
                return {
                  isError: true,
                  content: [
                    { type: "text", text: '{"error":"ACCESS_DENIED"}' },
                  ],
                  ...insufficientScopeMeta(config.oauth, user, d.access),
                };
              if (name === "account_diagnostics") {
                const memberships = (
                  user.memberships?.length ? user.memberships : [user]
                ).map((membership) => ({
                  tenant: membership.tenant,
                  permissions: [...(membership.permissions ?? [])].sort(),
                  devices:
                    membership.devices === undefined
                      ? null
                      : Object.fromEntries(
                          Object.entries(membership.devices)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([device, projects]) => [
                              device,
                              [...projects].sort(),
                            ]),
                        ),
                }));
                const visibleAgents = [...agents.values()]
                  .filter((agent) => membershipFor(user, agent.tenant))
                  .map((agent) => ({
                    id: agent.id,
                    tenant: agent.tenant,
                    projects: [...(agent.projects ?? [])].sort(),
                    online: Date.now() - (lastSeen.get(agent.id) ?? 0) < 30000,
                    dynamic: Boolean(agent.dynamic),
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id));
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        subject: user.subject ?? null,
                        dynamic: Boolean(user.dynamic),
                        memberships,
                        visibleAgents,
                      }),
                    },
                  ],
                };
              }
              if (name === "list_devices") {
                const devicesById = new Map();
                for (const agent of agents.values()) {
                  const projects = allowedProjects(user, agent);
                  if (!membershipFor(user, agent.tenant) || !projects?.length)
                    continue;
                  devicesById.set(agent.id, {
                    id: agent.id,
                    projects,
                    online: Date.now() - (lastSeen.get(agent.id) ?? 0) < 30000,
                  });
                }

                const memberships = user.memberships?.length
                  ? user.memberships
                  : [user];
                for (const membership of memberships) {
                  if (!membership?.devices) continue;
                  for (const [device, projects] of Object.entries(
                    membership.devices,
                  )) {
                    const knownAgent = agents.get(device);
                    if (
                      !projects?.length ||
                      devicesById.has(device) ||
                      (knownAgent && knownAgent.tenant !== membership.tenant)
                    )
                      continue;
                    devicesById.set(device, {
                      id: device,
                      projects,
                      online: false,
                    });
                  }
                }

                const devices = [...devicesById.values()].sort((a, b) =>
                  a.id.localeCompare(b.id),
                );
                const account = {
                  tenants: memberships
                    .map((membership) => membership.tenant)
                    .filter(Boolean)
                    .sort(),
                  explicitDeviceGrants: Object.fromEntries(
                    memberships
                      .filter((membership) => membership.devices)
                      .flatMap((membership) =>
                        Object.entries(membership.devices).map(
                          ([device, projects]) => [
                            device,
                            [...projects].sort(),
                          ],
                        ),
                      )
                      .sort(([a], [b]) => a.localeCompare(b)),
                  ),
                };
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ devices, account }),
                    },
                  ],
                };
              }
              if (githubDispatch && name.startsWith("github_")) {
                const result = await githubDispatch(name, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                };
              }
              return await forward(user, name, args);
            } catch (e) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      e.code === "DEVICE_TIMEOUT"
                        ? {
                            error: "DEVICE_TIMEOUT",
                            retry:
                              "Inspect state before repeating writes; reuse the same quality-gate requestKey.",
                          }
                        : publicError(e),
                    ),
                  },
                ],
              };
            }
          },
        );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, data);
    } catch (e) {
      json(res, e.code === "BODY_TOO_LARGE" ? 413 : 400, publicError(e));
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return {
    url: `http://${config.host}:${server.address().port}`,
    close: async () => {
      for (const wake of waiting.values()) wake();
      for (const p of pending.values()) p.reject();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
