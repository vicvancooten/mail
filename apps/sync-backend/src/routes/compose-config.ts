import { composeConfigSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";

export interface ComposeConfigRoutesOptions {
  /** ADR-0012's instance-level attachment budget, in encoded bytes (`env.ATTACHMENT_BUDGET_BYTES`). */
  attachmentBudgetBytes: number;
}

/**
 * The one instance-level compose setting a Client needs before it can
 * enforce anything live: the attachment budget (#48). A plain unauthenticated
 * GET — it carries no User or Mail Account data, only a number this instance
 * was configured with, and the composer needs it the moment it opens, before
 * a session necessarily exists to gate it behind.
 */
export async function composeConfigRoutes(
  app: FastifyInstance,
  { attachmentBudgetBytes }: ComposeConfigRoutesOptions,
) {
  app.get("/compose-config", async () => {
    return composeConfigSchema.parse({ attachmentBudgetEncodedBytes: attachmentBudgetBytes });
  });
}
