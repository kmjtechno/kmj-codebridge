import { z } from "zod";
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
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    deviceTimeoutMs: z.number().int().min(100).max(120000).default(15000),
    allowedHosts: z.array(z.string()).default([]),
    allowedOrigins: z.array(z.string().url()).default([]),
    users: z
      .array(
        z.object({
          id,
          tenant: id,
          tokenHash: digest.optional(),
          subject: z.string().min(1).max(256).optional(),
          devices: z.record(z.array(id)),
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
  token: z.string().min(32),
  id,
  tenant: id,
  stateDir: z.string(),
  supervisorSocket: z.literal("/run/kmj-codebridge/supervisor.sock").optional(),
  pollMs: z.number().min(10).max(5000).default(250),
  projects: z
    .array(
      z.object({
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
      }),
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
export const identifier = id;
