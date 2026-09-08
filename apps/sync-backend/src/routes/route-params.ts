import { type RegisteredProvider, registeredProviderSchema } from "@mail/shared";
import type { FastifyReply } from "fastify";

/**
 * Parses `:provider`, replying 400 for anything but `google`/`microsoft`.
 * Shared by `instance.ts` (Provider Registration CRUD) and `oauth-signin.ts`
 * (the sign-in start route) — both name the same two Providers off the same
 * `registeredProviderSchema`.
 */
export function parseProviderParam(
  request: { params: unknown },
  reply: FastifyReply,
): RegisteredProvider | undefined {
  const result = registeredProviderSchema.safeParse(
    (request.params as { provider?: string }).provider,
  );
  if (!result.success) {
    reply.code(400).send({ error: "invalid_provider" });
    return undefined;
  }
  return result.data;
}
