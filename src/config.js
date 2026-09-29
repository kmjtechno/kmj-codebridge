import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const permission = z.enum(["read", "write", "execute"]);
export const gatewaySchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  allowedHosts: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.string().url()).default([]),
  users: z
    .array(
      z.object({
        id,
        tenant: id,
        tokenHash: digest,
        devices: z.record(z.array(id)),
        permissions: z.array(permission),
      }),
    )
    .min(1),
  agents: z.array(z.object({ id, tenant: id, tokenHash: digest })).min(1),
});
export const agentSchema = z.object({
  gateway: z.string().url(),
  token: z.string().min(32),
  id,
  tenant: id,
  stateDir: z.string(),
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
      keys: z.record(z.string()),
    }),
  ]),
});
export const identifier = id;
