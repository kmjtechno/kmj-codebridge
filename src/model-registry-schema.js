import { z } from "zod";

// Owner-declared model registry entry (agent config). Deny-by-default: strict,
// no live fields (health/available/discovery are derived from the live overlay,
// never declared). Declaring a model here never proves it is free and never
// enables generation; it only lets read-only planning/inventory tools list it.
export const modelRegistryEntrySchema = z
  .object({
    id: z.string().min(1).max(96),
    provider: z.string().min(1).max(96),
    kind: z.enum(["local", "cloud"]),
    free: z.boolean(),
    privateCodeAllowed: z.boolean(),
    enabled: z.boolean().optional(),
    contextWindow: z.number().int().positive().max(1_000_000),
    capabilities: z.array(z.string().min(1).max(32)).max(16),
    qualityScore: z.number().min(0).max(100).optional(),
    reliabilityPct: z.number().min(0).max(100).optional(),
    p95LatencyMs: z.number().min(0).max(120000).optional(),
    freeTierVerified: z.boolean().optional(),
    costPerMillionTokensUsd: z.number().min(0).optional(),
    limits: z
      .object({
        perMinute: z.number().int().min(1).max(1_000_000).optional(),
        perDay: z.number().int().min(1).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const modelRegistrySchema = z
  .array(modelRegistryEntrySchema)
  .max(64)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, {
    message: "Duplicate model id in owner registry",
  });
