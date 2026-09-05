import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

interface FixedWindowBucket {
  count: number;
  resetAt: number;
}

export interface RouteRateLimitOptions {
  key: string;
  max: number;
  windowMs: number;
}

function identityFor(request: FastifyRequest): string {
  return request.user?.id ?? request.ip;
}

export function createRouteRateLimit({
  key,
  max,
  windowMs,
}: RouteRateLimitOptions): preHandlerHookHandler {
  const buckets = new Map<string, FixedWindowBucket>();

  return async function routeRateLimit(request, reply) {
    const now = Date.now();

    if (buckets.size > 1024) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    const bucketKey = `${key}:${identityFor(request)}`;
    const existing = buckets.get(bucketKey);
    const bucket =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;

    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    if (bucket.count <= max) {
      return;
    }

    return reply
      .header("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
      .code(429)
      .send({ error: "rate_limited" });
  };
}

export function guardWithRateLimit(
  guard: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  rateLimit: preHandlerHookHandler,
): preHandlerHookHandler {
  return async function guardedRateLimit(request, reply) {
    await guard(request, reply);
    if (reply.sent) {
      return;
    }
    return rateLimit(request, reply);
  };
}
