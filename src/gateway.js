import { buildMissionActivity } from "./mission-control-activity.js";
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
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { gatewaySchema } from "./config.js";
import { definitions, FAST_READ_TOOLS } from "./tools.js";
import { createGitHubBridge, githubDefinitions } from "./github.js";
import { createCiFailureReader, ciFailureDefinitions } from "./ci-failure.js";
import {
  createGitHubReadiness,
  githubReadinessOptions,
} from "./github-readiness.js";
import { fail, publicError } from "./errors.js";
import { VERSION } from "./version.js";
import {
  KMJ_STATUS_RESOURCE_URI,
  KMJ_STATUS_HTML,
  APPROVED_ICON_URL,
  compactWorkBrief,
  compactStatusText,
} from "./branded-status.js";
import { fleetLane, fleetSummary } from "./fleet-overview.js";
import { buildContextResume, unchangedResume } from "./context-resume.js";
const GIT_SHA = /^[0-9a-f]{7,40}$/;
// Render injects RENDER_GIT_COMMIT. Non-Render deploys (e.g. the VPS gateway
// behind the customer-domain /mcp) set CODEBRIDGE_SOURCE_COMMIT at deploy time,
// so a gateway publishing an unchanged tool catalog from an older commit is
// visible rather than assumed current. Malformed values are never echoed.
export function deployedCommit(env = process.env) {
  for (const value of [env.RENDER_GIT_COMMIT, env.CODEBRIDGE_SOURCE_COMMIT]) {
    if (typeof value === "string" && GIT_SHA.test(value)) return value;
  }
  return null;
}

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
const ONLINE_WINDOW_MS = 30000;
const STALE_WINDOW_MS = 120000;

export function connectionHealth(lastSeenAt, health, now = Date.now()) {
  const seen =
    Number.isFinite(lastSeenAt) && lastSeenAt > 0 ? lastSeenAt : null;
  const ageMs = seen === null ? null : Math.max(0, now - seen);
  const state =
    ageMs === null
      ? "never_seen"
      : ageMs < ONLINE_WINDOW_MS
        ? "online"
        : ageMs < STALE_WINDOW_MS
          ? "stale"
          : "offline";
  const sessionCount =
    Number.isInteger(health?.sessionCount) && health.sessionCount >= 0
      ? health.sessionCount
      : 0;
  const sessionStartedAt =
    Number.isFinite(health?.sessionStartedAt) && health.sessionStartedAt > 0
      ? new Date(health.sessionStartedAt).toISOString()
      : null;
  const lastHealthAt =
    Number.isFinite(health?.lastHealthAt) && health.lastHealthAt > 0
      ? new Date(health.lastHealthAt).toISOString()
      : null;

  return {
    online: state === "online",
    connectionState: state,
    lastSeenAt: seen === null ? null : new Date(seen).toISOString(),
    lastSeenAgeMs: ageMs,
    gatewaySessionCount: sessionCount,
    sessionStartedAt,
    lastHealthAt,
  };
}

// local_model_generate/autopilot_local_draft each accept their own
// timeoutSeconds (5-90s) for the Ollama call the P720 agent makes, but the
// gateway's own wait for the whole round trip was always capped by the
// single fixed config.deviceTimeoutMs (15s default, meant for fast
// filesystem/git tools). A cold 7B model load alone measured ~12s on real
// hardware, so any such call could be, and was, abandoned by the gateway
// as DEVICE_TIMEOUT - discarding real in-progress work - well before the
// caller's own requested timeoutSeconds, and well before the device-side
// Ollama call would have failed on its own. Give these two tools a wait
// floor that actually covers what they asked for, plus headroom for
// queue/poll/delivery latency, never shrinking the configured default and
// never exceeding gatewaySchema's own 120000ms ceiling.
const EXTENDED_TIMEOUT_TOOLS = new Set([
  "local_model_generate",
  "autopilot_local_draft",
]);
export function forwardTimeoutMs(deviceTimeoutMs, name, args) {
  if (
    !EXTENDED_TIMEOUT_TOOLS.has(name) ||
    !Number.isFinite(args?.timeoutSeconds)
  )
    return deviceTimeoutMs;
  return Math.min(
    120000,
    Math.max(deviceTimeoutMs, args.timeoutSeconds * 1000 + 15000),
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
  // Use the repository-approved, immutable CodeBridge icon when the operator
  // has not configured a different public HTTPS icon URL. MCP hosts decide
  // whether to display it; this only makes the standards metadata complete.
  const clientIconUrl = config.iconUrl ?? APPROVED_ICON_URL;
  const clientIcons = [{ src: clientIconUrl, mimeType: "image/png" }];
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
  const ciDispatch = createCiFailureReader(config.github?.circleci);
  const enabledGitHubDefinitions = config.github?.publicReadOnly
    ? Object.fromEntries(
        Object.entries(githubDefinitions).filter(
          ([, definition]) => definition.access === "read",
        ),
      )
    : githubDefinitions;
  const allDefinitions = {
    ...definitions,
    ...(githubDispatch ? enabledGitHubDefinitions : {}),
    ...(ciDispatch ? ciFailureDefinitions : {}),
  };
  const probeGitHub = createGitHubReadiness(
    githubDispatch
      ? () =>
          githubDispatch("github_repository", {
            repository: config.github.repositories[0],
          })
      : null,
    githubReadinessOptions(config.github),
  );
  const agents = new Map(config.agents.map((a) => [a.id, a]));
  const dynamicByToken = new Map();
  const pending = new Map(),
    waiting = new Map(),
    lastSeen = new Map(),
    agentHealth = new Map(),
    rate = new Map();
  const membershipFor = (user, tenant) =>
    user.memberships?.find((membership) => membership.tenant === tenant) ??
    (user.tenant === tenant ? user : undefined);
  const allowedProjects = (user, agent) => {
    const membership = membershipFor(user, agent.tenant);
    if (!membership) return undefined;
    if (membership.devices !== undefined) {
      if (!Object.hasOwn(membership.devices, agent.id)) return undefined;
      const granted = membership.devices[agent.id];
      return agent.dynamic
        ? granted.filter((project) => agent.projects?.includes(project))
        : granted;
    }
    if (!agent.dynamic) {
      const legacyUser = config.users.find(
        (candidate) =>
          candidate.subject === user.subject &&
          candidate.tenant === agent.tenant,
      );
      const legacyProjects = legacyUser?.devices?.[agent.id];
      if (legacyProjects !== undefined) return legacyProjects;
    }
    return agent.dynamic ? agent.projects : undefined;
  };
  const allowedPermissions = (user, agent) =>
    membershipFor(user, agent.tenant)?.permissions ?? [];
  const agentProjectPermissions = (agent, project) => {
    const grant = agent.projectGrants?.find((item) => item.id === project);
    if (grant?.status === "paused") return [];
    return (
      grant?.permissions ?? agent.permissions ?? ["read", "write", "execute"]
    );
  };

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
      data.projects.some((project) => {
        if (typeof project === "string")
          return !/^[A-Za-z0-9_-]{1,64}$/.test(project);
        if (!project || typeof project !== "object" || Array.isArray(project))
          return true;
        const keys = Object.keys(project);
        if (
          keys.some(
            (key) =>
              !["id", "permissions", "gate_preset", "status"].includes(key),
          ) ||
          typeof project.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(project.id)
        )
          return true;
        if (
          project.permissions !== undefined &&
          (!Array.isArray(project.permissions) ||
            project.permissions.length < 1 ||
            project.permissions.some(
              (permission) =>
                !["read", "write", "execute"].includes(permission),
            ))
        )
          return true;
        if (
          project.gate_preset !== undefined &&
          (typeof project.gate_preset !== "string" ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(project.gate_preset))
        )
          return true;
        return (
          project.status !== undefined &&
          !["active", "paused"].includes(project.status)
        );
      }) ||
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

    const normalizedProjectGrants = data.projects.map((project) =>
      typeof project === "string"
        ? {
            id: project,
            permissions: [...new Set(data.permissions)],
            gatePreset: null,
            status: "active",
          }
        : {
            id: project.id,
            permissions: [...new Set(project.permissions ?? data.permissions)],
            gatePreset: project.gate_preset ?? null,
            status: project.status ?? "active",
          },
    );
    if (
      new Set(normalizedProjectGrants.map((project) => project.id)).size !==
      normalizedProjectGrants.length
    )
      return null;
    const agent = {
      id: data.device_id,
      tenant: data.tenant_id,
      tokenHash,
      projects: normalizedProjectGrants
        .filter((project) => project.status === "active")
        .map((project) => project.id),
      projectGrants: normalizedProjectGrants,
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
      (a.permissions && !a.permissions.includes(access)) ||
      !agentProjectPermissions(a, args.project).includes(access)
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
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(Object.assign(new Error(), { code: "DEVICE_TIMEOUT" }));
        },
        forwardTimeoutMs(config.deviceTimeoutMs, name, args),
      );
      pending.set(id, {
        id,
        agent: a.id,
        tool: name,
        args,
        permissions: allowedPermissions(user, a).filter(
          (permission) =>
            (!a.permissions || a.permissions.includes(permission)) &&
            agentProjectPermissions(a, args.project).includes(permission),
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

  function decodeForwardedResult(result) {
    const text = result?.content?.find(
      (item) => item?.type === "text" && typeof item.text === "string",
    )?.text;
    let value = null;
    try {
      value = text === undefined ? null : JSON.parse(text);
    } catch {
      return { ok: false, error: "INVALID_AGENT_RESULT" };
    }
    if (result?.isError)
      return {
        ok: false,
        error:
          value && typeof value.error === "string"
            ? value.error
            : "AGENT_TOOL_FAILED",
      };
    return { ok: true, value };
  }

  async function fastContext(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    const calls = [
      ["project", "inspect_project", scope],
      ["git", "git_status", scope],
      [
        "autopilot",
        "autopilot_status",
        {
          ...scope,
          limit: args.autopilotLimit,
        },
      ],
    ];
    const settled = await Promise.all(
      calls.map(async ([key, name, input]) => {
        try {
          return [key, decodeForwardedResult(await forward(user, name, input))];
        } catch (error) {
          return [key, { ok: false, error: publicError(error).error }];
        }
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      device: args.device,
      project: args.project,
      parts: Object.fromEntries(settled),
    };
  }

  async function fleetOverview(user, args) {
    const grants = new Map();
    const add = (device, project, tenant) => {
      const agent = agents.get(device);
      if (
        agent?.tenant === tenant &&
        !allowedProjects(user, agent)?.includes(project)
      )
        return;
      const key = JSON.stringify([device, project]);
      if (!grants.has(key)) grants.set(key, { device, project, tenant });
    };
    for (const membership of user.memberships?.length
      ? user.memberships
      : [user]) {
      if (!membership?.permissions?.includes("read")) continue;
      for (const [device, projects] of Object.entries(
        membership.devices ?? {},
      )) {
        if (!Array.isArray(projects)) continue;
        for (const project of projects) add(device, project, membership.tenant);
      }
    }
    for (const agent of agents.values()) {
      if (!allowedPermissions(user, agent).includes("read")) continue;
      for (const project of allowedProjects(user, agent) ?? []) {
        add(agent.id, project, agent.tenant);
      }
    }
    const all = [...grants.values()].sort(
      (a, b) =>
        a.project.localeCompare(b.project) || a.device.localeCompare(b.device),
    );
    const limit = args.maxProjects ?? 8;
    const lanes = await Promise.all(
      all.slice(0, limit).map(async (item) => {
        const { device, project, tenant } = item;
        const agent = agents.get(device);
        const registered = agent?.tenant === tenant;
        const health = registered
          ? connectionHealth(lastSeen.get(device), agentHealth.get(device))
          : null;
        const status = !registered
          ? "GATEWAY_REGISTRATION_MISSING"
          : health.online
            ? "READY"
            : health.connectionState === "never_seen"
              ? "AGENT_NEVER_ONLINE"
              : "AGENT_OFFLINE";
        if (status !== "READY") return fleetLane(device, project, status);
        const results = await Promise.all(
          [
            ["autopilot_status", { device, project, limit: 1 }],
            ["execution_capacity", { device, project }],
          ].map(async ([name, input]) => {
            try {
              return decodeForwardedResult(await forward(user, name, input));
            } catch (error) {
              return { ok: false, error: publicError(error).error };
            }
          }),
        );
        return fleetLane(device, project, status, results[0], results[1]);
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      ...fleetSummary(lanes, all.length),
    };
  }

  async function getCompactWorkBrief(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    const requests = [
      ["git_status", scope],
      ["autopilot_status", { ...scope, limit: 1 }],
      ["execution_capacity", scope],
    ];
    const parts = await Promise.all(
      requests.map(async ([name, input]) => {
        try {
          return decodeForwardedResult(await forward(user, name, input));
        } catch (error) {
          return { ok: false, error: publicError(error).error };
        }
      }),
    );
    return compactWorkBrief({
      ...scope,
      git: parts[0],
      autopilot: parts[1],
      capacity: parts[2],
    });
  }

  async function getMissionControlBrief(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    const [brief, jobs] = await Promise.all([
      getCompactWorkBrief(user, args),
      (async () => {
        try {
          return decodeForwardedResult(
            await forward(user, "list_project_jobs", {
              ...scope,
              limit: 6,
              state: "all",
              cursor: null,
            }),
          );
        } catch (error) {
          return { ok: false, error: publicError(error).error };
        }
      })(),
    ]);
    return {
      ...brief,
      activity: buildMissionActivity({ project: args.project, jobs }),
    };
  }

  async function getContextResume(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    const requests = [
      ["git_status", scope],
      ["autopilot_status", { ...scope, limit: 10 }],
      ["chat_lane_status", scope],
      ["coordination_list", { ...scope, limit: 5, after: null }],
      ["execution_capacity", scope],
    ];
    const parts = await Promise.all(
      requests.map(async ([name, input]) => {
        try {
          return decodeForwardedResult(await forward(user, name, input));
        } catch (error) {
          return { ok: false, error: publicError(error).error };
        }
      }),
    );
    const packet = buildContextResume({
      ...scope,
      git: parts[0],
      autopilot: parts[1],
      lanes: parts[2],
      mailbox: parts[3],
      capacity: parts[4],
    });
    return args.ifNoneMatch === packet.digest
      ? unchangedResume(packet)
      : packet;
  }

  async function getMultiChatSync(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    // Request in parallel; a slow or temporarily offline lane should not
    // invent successful state or block the truthfulness of other evidence.
    const [context, continuity] = await Promise.all([
      getContextResume(user, scope),
      (async () => {
        try {
          return decodeForwardedResult(
            await forward(user, "chat_continuity_read", {
              ...scope,
              lane: args.lane,
            }),
          );
        } catch (error) {
          return { ok: false, error: publicError(error).error };
        }
      })(),
    ]);
    const summary = {
      version: 1,
      kind: "codebridge.multi_chat_sync",
      device: args.device,
      project: args.project,
      lane: args.lane,
      contextDigest: context.digest,
      checkpointRevision: continuity.ok
        ? (continuity.value?.revision ?? null)
        : "UNKNOWN",
      checkpointAvailable: continuity.ok,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(summary))
      .digest("hex");
    if (args.ifNoneMatch === digest)
      return {
        kind: summary.kind,
        device: args.device,
        project: args.project,
        lane: args.lane,
        unchanged: true,
        digest,
      };
    return {
      ...summary,
      digest,
      context,
      checkpoint: continuity.ok
        ? continuity.value
        : { status: "UNKNOWN", error: continuity.error },
      hostChatAutoWake: false,
      hostContextWindowExtended: false,
      notes:
        "Lane labels and saved summaries are client-authored claims. Background work requires separately enabled authorized device workers.",
    };
  }

  const fastReadTools = new Set(FAST_READ_TOOLS);

  async function fastReadBatch(user, args) {
    authorize(user, args, "read");
    const scope = { device: args.device, project: args.project };
    const results = await Promise.all(
      args.calls.map(async (call) => {
        if (!fastReadTools.has(call.tool))
          return {
            key: call.key,
            tool: call.tool,
            ok: false,
            error: "FAST_READ_TOOL_NOT_ALLOWED",
          };
        const input = { ...call.args, ...scope };
        try {
          return {
            key: call.key,
            tool: call.tool,
            ...decodeForwardedResult(await forward(user, call.tool, input)),
          };
        } catch (error) {
          return {
            key: call.key,
            tool: call.tool,
            ok: false,
            error: publicError(error).error,
          };
        }
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      device: args.device,
      project: args.project,
      results,
    };
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
        // One status read triggers at most one coalesced background refresh;
        // githubReadiness carries only fixed codes, never secrets or URLs.
        const githubReadiness = probeGitHub.status();
        const commit = deployedCommit();
        json(res, 200, {
          status: "ok",
          version: VERSION,
          capabilities: {
            github: Boolean(githubDispatch),
            githubReady: githubReadiness.state === "ready",
          },
          githubReadiness,
          ...(commit !== null ? { commit } : {}),
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
          const now = lastSeen.get(a.id) ?? Date.now();
          const previous = agentHealth.get(a.id);
          agentHealth.set(a.id, {
            sessionCount: (previous?.sessionCount ?? 0) + 1,
            sessionStartedAt: now,
            lastHealthAt: now,
          });
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
      const publicDiscovery = [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "ping",
      ].includes(data?.method);
      const user = verifyOAuth
        ? await verifyOAuth(req.headers.authorization)
        : identify(req, config.users);
      if (!user && !publicDiscovery) {
        if (config.oauth) {
          // HTTP authorization failures must be transport-level responses.
          // Tool-result challenges alone are invisible to IDE OAuth clients.
          const requestedTool =
            data?.method === "tools/call" &&
            typeof data?.params?.name === "string"
              ? allDefinitions[data.params.name]
              : null;
          const scope = requestedTool
            ? `codebridge:${requestedTool.access}`
            : undefined;
          res.setHeader(
            "WWW-Authenticate",
            oauthChallenge(config.oauth, scope) +
              ', error="invalid_token", error_description="Sign in to KMJ CodeBridge to continue"',
          );
        }
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
      const serverCommit = deployedCommit();
      const mcp = new McpServer({
        name: "kmj-codebridge",
        title: "KMJ CodeBridge",
        version: VERSION,
        description:
          "Secure, project-scoped AI coding across authorized computers and VPSs through one MCP bridge.",
        websiteUrl: "https://kmjtechno.com",
        // Same validated public deploy marker as /healthz; initialize is public
        // discovery, so origins that only route /mcp can still be verified.
        ...(serverCommit !== null ? { commit: serverCommit } : {}),
        // Standard MCP `Implementation.icons` (spec 2025-11-25 / SEP-973).
        // Defaults to CodeBridge's pinned, approved PNG; an operator can
        // explicitly override it with a validated public HTTPS iconUrl.
        // Rendering/permission-dialog appearance is controlled by the host.
        icons: clientIcons,
      });
      for (const [name, d] of Object.entries(allDefinitions))
        mcp.registerTool(
          name,
          {
            title: d.title,
            description: d.description,
            inputSchema: d.input,
            // Advertise the same pinned/validated icon as serverInfo.
            // Hosts may choose to ignore this metadata.
            icons: clientIcons,
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
                  ? [
                      oauthChallenge(config.oauth, `codebridge:${d.access}`) +
                        ', error="invalid_token", error_description="Sign in to KMJ CodeBridge to continue"',
                    ]
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
              if (name === "connection_overview") {
                const memberships = user.memberships?.length
                  ? user.memberships
                  : [user];
                const devices = [];
                const addDeviceProjects = (membership, device, projects) => {
                  if (args.expectedDevice && args.expectedDevice !== device)
                    return;
                  const agent = agents.get(device);
                  const registered =
                    agent !== undefined && agent.tenant === membership.tenant;
                  const health = registered
                    ? connectionHealth(
                        lastSeen.get(device),
                        agentHealth.get(device),
                      )
                    : null;
                  for (const project of projects) {
                    if (
                      args.expectedProject &&
                      args.expectedProject !== project
                    )
                      continue;
                    const activeProject =
                      registered &&
                      (!agent.dynamic || agent.projects?.includes(project));
                    const status = !registered
                      ? "GATEWAY_REGISTRATION_MISSING"
                      : !activeProject
                        ? "PROJECT_SCOPE_MISMATCH"
                        : health.online
                          ? "READY"
                          : health.connectionState === "never_seen"
                            ? "AGENT_NEVER_ONLINE"
                            : "AGENT_OFFLINE";
                    const nextAction = {
                      READY: "NONE",
                      GATEWAY_REGISTRATION_MISSING: "RUN_VM_CONNECTION_DOCTOR",
                      PROJECT_SCOPE_MISMATCH:
                        "VERIFY_ENROLLED_PROJECT_AND_GRANT",
                      AGENT_NEVER_ONLINE: "CHECK_AGENT_SERVICE_LOGS",
                      AGENT_OFFLINE: "CHECK_AGENT_SERVICE_LOGS",
                    }[status];
                    devices.push({
                      device,
                      project,
                      status,
                      nextAction,
                      ...(health
                        ? { connectionState: health.connectionState }
                        : {}),
                    });
                  }
                };
                for (const membership of memberships) {
                  if (!membership?.tenant) continue;
                  if (membership.devices !== undefined) {
                    for (const [device, projects] of Object.entries(
                      membership.devices,
                    ))
                      addDeviceProjects(membership, device, projects);
                    continue;
                  }
                  for (const agent of agents.values()) {
                    if (agent.tenant !== membership.tenant) continue;
                    addDeviceProjects(
                      membership,
                      agent.id,
                      allowedProjects(user, agent) ?? [],
                    );
                  }
                }
                devices.sort(
                  (a, b) =>
                    a.device.localeCompare(b.device) ||
                    a.project.localeCompare(b.project),
                );
                const expectedNotGranted =
                  Boolean(args.expectedDevice || args.expectedProject) &&
                  devices.length === 0;
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        overallStatus: expectedNotGranted
                          ? args.expectedProject && !args.expectedDevice
                            ? "ACCOUNT_PROJECT_GRANT_MISSING"
                            : "ACCOUNT_GRANT_MISSING"
                          : !devices.length
                            ? "NO_GRANTED_DEVICES"
                            : devices.every((entry) => entry.status === "READY")
                              ? "READY"
                              : "NEEDS_ATTENTION",
                        ...(expectedNotGranted
                          ? {
                              ...(args.expectedDevice
                                ? { expectedDevice: args.expectedDevice }
                                : {}),
                              ...(args.expectedProject
                                ? { expectedProject: args.expectedProject }
                                : {}),
                              nextAction:
                                "CHECK_MAIN_PLATFORM_ACCOUNT_AND_DEVICE_PAIRING",
                            }
                          : {}),
                        readyCount: devices.filter(
                          (entry) => entry.status === "READY",
                        ).length,
                        attentionCount: devices.filter(
                          (entry) => entry.status !== "READY",
                        ).length,
                        devices,
                      }),
                    },
                  ],
                };
              }
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
                    ...connectionHealth(
                      lastSeen.get(agent.id),
                      agentHealth.get(agent.id),
                    ),
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
                    online: connectionHealth(
                      lastSeen.get(agent.id),
                      agentHealth.get(agent.id),
                    ).online,
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
                      knownAgent
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
              if (name === "compact_work_brief") {
                const result = await getCompactWorkBrief(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                };
              }
              if (name === "multi_chat_sync") {
                const result = await getMultiChatSync(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                };
              }
              if (name === "context_resume") {
                const result = await getContextResume(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  structuredContent: result,
                };
              }
              if (name === "render_codebridge_status") {
                const result = await getMissionControlBrief(user, args);
                return {
                  content: [{ type: "text", text: compactStatusText(result) }],
                  structuredContent: result,
                };
              }
              if (name === "fleet_overview") {
                const result = await fleetOverview(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                };
              }
              if (name === "fast_context") {
                const result = await fastContext(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                };
              }
              if (name === "fast_read_batch") {
                const result = await fastReadBatch(user, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                };
              }
              if (ciDispatch && name === "ci_status_failure_log") {
                const result = await ciDispatch(name, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(result) }],
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
      if (config.oauth)
        mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: Object.entries(allDefinitions).map(([name, d]) => {
            const input = normalizeObjectSchema(d.input);
            const security = toolSecurityMeta(config.oauth, d.access);
            return {
              name,
              title: d.title,
              description: d.description,
              inputSchema: input
                ? toJsonSchemaCompat(input, {
                    strictUnions: true,
                    pipeStrategy: "input",
                  })
                : { type: "object", properties: {} },
              // Keep the public tools/list icon consistent with serverInfo
              // and the registered tool even when the SDK omits tool icons.
              icons: clientIcons,
              annotations: {
                title: d.title,
                readOnlyHint: d.access === "read",
                destructiveHint: d.access !== "read",
                idempotentHint: d.access === "read",
                openWorldHint:
                  name === "run_quality_gate" || name.startsWith("github_"),
              },
              ...(name === "render_codebridge_status"
                ? {
                    _meta: {
                      ui: { resourceUri: KMJ_STATUS_RESOURCE_URI },
                      "openai/outputTemplate": KMJ_STATUS_RESOURCE_URI,
                    },
                  }
                : {}),
              ...security,
            };
          }),
        }));

      mcp.registerResource(
        "KMJ CodeBridge status card",
        KMJ_STATUS_RESOURCE_URI,
        {
          title: "KMJ TECHNO Project Status",
          mimeType: "text/html;profile=mcp-app",
          description:
            "Lightweight branded status display, zero remote scripts.",
        },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: "text/html;profile=mcp-app",
              text: KMJ_STATUS_HTML,
              _meta: {
                ui: {
                  prefersBorder: true,
                  csp: {
                    connectDomains: [],
                    resourceDomains: ["https://raw.githubusercontent.com"],
                  },
                },
              },
            },
          ],
        }),
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
