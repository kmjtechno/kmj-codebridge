import { createOAuthVerifier, oauthMetadata, oauthChallenge } from "./auth.js";
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
import { fail, publicError } from "./errors.js";
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
  const verifyOAuth = config.oauth
    ? createOAuthVerifier(config.oauth, config.users)
    : null;
  const agents = new Map(config.agents.map((a) => [a.id, a]));
  const pending = new Map(),
    waiting = new Map(),
    lastSeen = new Map(),
    rate = new Map();
  function authorize(user, args, access) {
    const a = agents.get(args.device);
    if (
      !a ||
      a.tenant !== user.tenant ||
      !user.devices[args.device]?.includes(args.project) ||
      !user.permissions.includes(access)
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
        permissions: user.permissions,
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
      if (\n        config.openaiAppsChallenge &&\n        req.url === "/.well-known/openai-apps-challenge" &&\n        req.method === "GET"\n      ) {\n        res.writeHead(200, {\n          "content-type": "text/plain; charset=utf-8",\n          "cache-control": "no-store",\n        });\n        res.end(config.openaiAppsChallenge);\n        return;\n      }\n      // RFC 9728: the path-suffixed location is canonical for the /mcp
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
        json(res, 200, { status: "ok", version: "0.1.0" });
        return;
      }
      if (req.url?.startsWith("/agent/")) {
        const a = identify(req, config.agents);
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
            timer = setTimeout(finish, 10000);
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
      const user = verifyOAuth
        ? await verifyOAuth(req.headers.authorization)
        : identify(req, config.users);
      if (!user) {
        if (config.oauth)
          res.setHeader("WWW-Authenticate", oauthChallenge(config.oauth));
        json(res, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
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
      const data = await body(req);
      const mcp = new McpServer({ name: "kmj-codebridge", version: "0.1.0" });
      for (const [name, d] of Object.entries(definitions))
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
              openWorldHint: name === "run_quality_gate",
            },
          },
          async (args) => {
            try {
              if (!user.permissions.includes(d.access))
                return {
                  isError: true,
                  content: [
                    { type: "text", text: '{"error":"ACCESS_DENIED"}' },
                  ],
                  ...insufficientScopeMeta(config.oauth, user, d.access),
                };
              if (name === "list_devices") {
                const devices = config.agents
                  .filter(
                    (a) =>
                      a.tenant === user.tenant &&
                      Object.hasOwn(user.devices, a.id),
                  )
                  .map((a) => ({
                    id: a.id,
                    projects: user.devices[a.id],
                    online: Date.now() - (lastSeen.get(a.id) ?? 0) < 30000,
                  }));
                return {
                  content: [
                    { type: "text", text: JSON.stringify({ devices }) },
                  ],
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
