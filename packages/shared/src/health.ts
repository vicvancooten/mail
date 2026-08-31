import { z } from "zod";

/**
 * Placeholder wire-contract schema, proving the shared package is importable
 * from both the Client and the Sync Backend (ADR-0005: a shared zod package
 * is the enforced API contract on both sides). Real Mail Account / Thread /
 * Message schemas replace this as the API takes shape.
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
