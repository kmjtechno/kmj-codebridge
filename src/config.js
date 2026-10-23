import { z } from "zod";
import { validApprovedScriptPath } from "./windows-powershell-profile.js";
import { COMMAND_PRESET_IDS, expandCommandPresets } from "./command-presets.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const permission = z.enum(["read", "write", "execute"]);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/["\\\s]/.test(value)
    );
  }, "Requires a canonical HTTPS URL");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Operator-supplied, publicly reachable icon URL for the standard MCP
// `Implementation.icons` field (spec 2025-11-25 / SEP-973). Optional and
// never defaulted or guessed: the gateway advertises no icon at all unless
// a real public HTTPS URL is configured here. See docs/CLIENTS.md
// "Connector and plugin icon behavior" for why this exists and what it
// does and does not fix.
const iconUrl = httpsUrl
  .refine(
    (value) => !LOOPBACK_HOSTS.has(new URL(value).hostname),
    "iconUrl must be a public HTTPS URL, not a loopback/local address",
  )
  .optional();
export const gatewaySchema = z
  .object({
    oauth: z
      .object({
        issuer: httpsUrl,
        resource: httpsUrl.refine(
          (value) => new URL(value).pathname === "/mcp",
        ),
        jwks: z
          .object({
            keys: z
              .array(
                z
                  .object({ kty: z.enum(["RSA", "EC", "OKP"]) })
                  .passthrough()
                  .refine(
                    (key) =>
                      !["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
                        (name) => name in key,
                      ),
                    "Public keys only",
                  ),
              )
              .min(1)
              .max(20),
          })
          .optional(),
        jwksUri: httpsUrl.optional(),
      })
      .superRefine((oauth, ctx) => {
        if (Boolean(oauth.jwks) === Boolean(oauth.jwksUri)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Configure exactly one of jwks or jwksUri",
          });
        }
        if (
          oauth.jwksUri &&
          new URL(oauth.jwksUri).origin !== new URL(oauth.issuer).origin
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Remote JWKS must share the OAuth issuer origin",
          });
        }
      })
      .optional(),
    agentIntrospection: z
      .object({
        endpoint: httpsUrl,
        cacheSeconds: z.number().int().min(5).max(300).default(60),
      })
      .optional(),
    userIntrospection: z
      .object({
        endpoint: httpsUrl,
        cacheSeconds: z.number().int().min(5).max(300).default(30),
      })
      .optional(),
    github: z
      .object({
        apiBase: httpsUrl.default("https://api.github.com/"),
        tokenEnv: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
          .optional(),
        publicReadOnly: z.boolean().optional(),
        repositories: z
          .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
          .min(1)
          .max(100),
        cacheSeconds: z.number().int().min(5).max(300).default(30),
        circleci: z
          .object({
            tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
            repositories: z
              .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
              .min(1)
              .max(25),
            outputHosts: z
              .array(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/))
              .min(1)
              .max(15),
          })
          .strict()
          .optional(),
      })
      .superRefine((github, ctx) => {
        if (!github.publicReadOnly && !github.tokenEnv) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "GitHub tokenEnv is required unless publicReadOnly is enabled",
          });
        }
        if (
          github.publicReadOnly &&
          new URL(github.apiBase).href !== "https://api.github.com/"
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Public read-only GitHub mode must use api.github.com",
          });
        }
      })
      .optional(),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    deviceTimeoutMs: z.number().int().min(100).max(120000).default(15000),
    pollWaitMs: z.number().int().min(25).max(120000).default(45000),
    allowedHosts: z.array(z.string()).default([]),
    allowedOrigins: z.array(z.string().url()).default([]),
    openaiAppsChallenge: z
      .string()
      .regex(/^[A-Za-z0-9._~-]{1,512}$/)
      .optional(),
    iconUrl,
    users: z
      .array(
        z.object({
          id,
          tenant: id,
          tokenHash: digest.optional(),
          subject: z.string().min(1).max(256).optional(),
          devices: z.record(z.array(id)).default({}),
          permissions: z.array(permission),
        }),
      )
      .default([]),
    agents: z
      .array(z.object({ id, tenant: id, tokenHash: digest }))
      .default([]),
  })
  .superRefine((config, ctx) => {
    if (!config.oauth && config.users.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one user is required without OAuth",
      });
    }
    if (
      !config.oauth &&
      !config.agentIntrospection &&
      config.agents.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "At least one agent or agent introspection endpoint is required",
      });
    }
    const names = new Set();
    const subjects = new Set();
    for (const user of config.users) {
      if (
        names.has(user.id) ||
        (config.oauth
          ? !user.subject || subjects.has(user.subject)
          : !user.tokenHash)
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid or duplicate user identity",
        });
      names.add(user.id);
      subjects.add(user.subject);
    }
  })
  .transform((config) => {
    if (
      !config.userIntrospection &&
      config.oauth &&
      config.users.length === 0
    ) {
      config.userIntrospection = {
        endpoint: new URL(
          "/api/codebridge/v1/user-access/introspect",
          config.oauth.issuer,
        ).href,
        cacheSeconds: 30,
      };
    }
    if (!config.agentIntrospection && config.oauth) {
      config.agentIntrospection = {
        endpoint: new URL(
          "/api/codebridge/v1/device-credentials/introspect",
          config.oauth.issuer,
        ).href,
        cacheSeconds: 60,
      };
    }
    return config;
  });
export const agentSchema = z.object({
  gateway: z.string().url(),
  // Existing owner-enrolled inline tokens remain backward compatible.
  // New dedicated service identities can use a separate private file.
  token: z.string().min(32).optional(),
  gatewayTokenFile: z.string().min(3).max(4096).optional(),
  id,
  tenant: id,
  stateDir: z.string(),
  supervisorSocket: z.literal("/run/kmj-codebridge/supervisor.sock").optional(),
  // Windows-native supervisor: fixed-prefix named pipe plus the path of the
  // ACL-restricted secret file. Both or neither; never combined with the
  // Linux socket.
  supervisorPipe: z
    .string()
    .regex(/^\\\\\.\\pipe\\kmj-codebridge-supervisor-[a-z0-9-]{1,40}$/)
    .optional(),
  supervisorTokenFile: z.string().min(3).max(260).optional(),
  pollMs: z.number().min(10).max(5000).default(250),
  // Bounded operator-provided durable-archive retention (docs/JOB-ARCHIVAL.md,
  // issue #186). Purely a count cap, never age-based: an idempotency
  // tombstone must never silently expire and risk a requestKey replaying a
  // previously executed write. Default matches DurableJobArchive's own
  // default so an agent that omits this field keeps today's behavior.
  jobArchiveMaxEntries: z.number().int().min(1).max(1000000).default(100000),
  projects: z
    .array(
      z
        .object({
          id,
          root: z.string(),
          writable: z.boolean().default(false),
          gates: z
            .record(
              z.object({
                command: z.string().min(1),
                args: z.array(z.string()).default([]),
                timeoutMs: z.number().int().min(10).max(300000).default(30000),
              }),
            )
            .default({}),
          autopilotLocalWorker: z
            .object({
              enabled: z.boolean().default(false),
              model: z.string().regex(/^[A-Za-z0-9._:/-]{1,96}$/),
              maxTokens: z.number().int().min(32).max(512).default(256),
              timeoutSeconds: z.number().int().min(5).max(90).default(45),
            })
            .strict()
            .optional(),
          autopilotCiWatch: z
            .object({
              enabled: z.boolean().default(false),
              repository: z
                .string()
                .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
              branch: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
              workflow: z.string().min(1).max(120),
              job: z.string().min(1).max(120),
              recipe: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
              tokenEnv: z
                .string()
                .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
                .optional(),
              publicReadOnly: z.boolean().default(false),
              intervalSeconds: z.number().int().min(600).max(3600).default(900),
            })
            .strict()
            .superRefine((watch, ctx) => {
              if (Boolean(watch.tokenEnv) === watch.publicReadOnly) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message:
                    "Choose server token OR explicit public read-only mode",
                });
              }
            })
            .optional(),
          autopilotRepairWorker: z
            .object({
              enabled: z.boolean().default(false),
              recipes: z
                .record(
                  z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
                  z
                    .object({
                      fixGate: id,
                      verifyGate: id,
                      triggerGate: id.optional(),
                      paths: z
                        .array(
                          z
                            .string()
                            .regex(
                              /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/,
                            ),
                        )
                        .min(1)
                        .max(20),
                    })
                    .strict(),
                )
                .refine(
                  (recipes) =>
                    Object.keys(recipes).length > 0 &&
                    Object.keys(recipes).length <= 8,
                ),
            })
            .strict()
            .optional(),
          autopilotGateWorker: z
            .object({
              enabled: z.boolean().default(false),
              gates: z.array(id).min(1).max(16),
              // Explicit opt-in: run approved gate from a pinned clean detached
              // worktree even when Claude/main checkout has uncommitted work.
              isolatedWorktree: z.boolean().default(false),
            })
            .strict()
            .optional(),
          commandPresets: z
            .array(z.enum(COMMAND_PRESET_IDS))
            .max(COMMAND_PRESET_IDS.length)
            .default([]),
          commands: z
            .record(
              z.object({
                category: z.enum(["inspect", "build", "write", "network"]),
                description: z.string().max(160).default(""),
                command: z
                  .string()
                  .min(1)
                  .max(260)
                  .refine((value) => !/[\x00-\x1f]/.test(value)),
                variants: z
                  .record(
                    z.object({
                      args: z
                        .array(
                          z
                            .string()
                            .max(512)
                            .refine((value) => !/[\x00-\x1f]/.test(value)),
                        )
                        .max(32)
                        .default([]),
                      timeoutMs: z
                        .number()
                        .int()
                        .min(10)
                        .max(300000)
                        .default(30000),
                      // Admin-pinned local Windows script, not a chat-provided
                      // shell string. Revalidated before the queued job starts.
                      powershellScript: z
                        .object({
                          path: z
                            .string()
                            .min(5)
                            .max(240)
                            .refine(validApprovedScriptPath),
                          sha256: digest,
                        })
                        .strict()
                        .optional(),
                    }),
                  )
                  .refine((variants) => Object.keys(variants).length > 0),
              }),
            )
            .default({}),
        })
        .superRefine((project, ctx) => {
          for (const profile of Object.values(project.commands ?? {})) {
            const usesApprovedPowerShell = Object.values(
              profile.variants ?? {},
            ).some((variant) => variant.powershellScript !== undefined);
            if (
              usesApprovedPowerShell &&
              (profile.command !== "pwsh.exe" ||
                !["build", "write"].includes(profile.category))
            )
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  "PowerShell script profiles require an approved, bounded Windows build/write command",
              });
          }
          if (
            project.autopilotCiWatch?.enabled &&
            (!project.writable ||
              !project.autopilotRepairWorker?.enabled ||
              !Object.hasOwn(
                project.autopilotRepairWorker.recipes,
                project.autopilotCiWatch.recipe,
              ))
          )
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "CI watch needs a writable project and enabled repair recipe",
            });
        })
        .transform((project) => ({
          ...project,
          commands: expandCommandPresets(
            project.commandPresets,
            project.commands,
          ),
        })),
    )
    .min(1),
  license: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("free") }),
    z.object({
      mode: z.literal("signed"),
      tokenFile: z.string(),
      renewal: z
        .object({
          endpoint: httpsUrl,
          credential: z.string().min(32).max(4096),
          intervalSeconds: z.number().int().min(60).max(86400).default(3600),
        })
        .optional(),
      keys: z.record(z.string()),
    }),
  ]),
});
// Runtime-only refinement keeps agentSchema.shape available to existing
// Windows Supervisor field validators and other schema consumers.
export const enrolledAgentSchema = agentSchema.superRefine((agent, ctx) => {
  if (Boolean(agent.token) === Boolean(agent.gatewayTokenFile))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one gateway credential source is required",
    });
});
export const identifier = id;
